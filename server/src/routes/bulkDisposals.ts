import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkDate, isoToDDMMYYYY, loadWorksheet, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";
import { disposeWithChildren } from "./disposalWriteOff.js";
import { findDirectChildActionViolations } from "./parentLink.js";
import { requireEditor } from "../auth/middleware.js";

const disposalRowSchema = z.object({
  farId: z.string().min(1),
  dateOfDisposal: bulkDate,
  saleValue: z.coerce.number().min(0).default(0)
});

export default async function bulkDisposalsRoutes(app: FastifyInstance) {
  // Bulk Disposals: same full-disposal semantics as PATCH /api/assets/:farId/disposal
  // (deletions = the asset's entire capitalized cost, status forced to Disposed),
  // applied to every row in a CSV/XLSX instead of one asset at a time.
  app.post("/api/assets/bulk-dispose", { preHandler: requireEditor }, async (req, reply) => {
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: "No file was uploaded." };
    }

    const buffer = await file.toBuffer();
    let worksheet;
    try {
      worksheet = await loadWorksheet(buffer, file.filename);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    let validRows, errors;
    try {
      ({ validRows, errors } = parseWorksheetRows(worksheet, disposalRowSchema));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    // Preview mode: same not-found / already-disposed / before-capitalization / child-
    // can't-dispose-directly checks the commit loop below does, against the same
    // schema-valid rows, but read-only — no UPDATE, no transaction.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const existing = new Map<
        string,
        { dateOfDisposal: string | null; dateAcquired: string; dateOfAddition: string | null }
      >();
      if (farIds.length > 0) {
        const { rows } = await db.query<{
          far_id: string;
          date_of_disposal: string | null;
          date_acquired: string;
          date_of_addition: string | null;
        }>(
          `SELECT far_id, date_of_disposal, date_acquired, date_of_addition FROM assets WHERE far_id = ANY($1)`,
          [farIds]
        );
        for (const r of rows) {
          existing.set(r.far_id, {
            dateOfDisposal: r.date_of_disposal,
            dateAcquired: r.date_acquired,
            dateOfAddition: r.date_of_addition
          });
        }
      }
      // Rule 1 (2026-08-28): a child asset can't be disposed directly via a bulk row —
      // every row here is its own standalone instruction (unlike the single-item Transfer
      // endpoint's multi-select, there's no "parent also in this same request" exception
      // to make; a parent's own row, if also present, cascades to its children anyway).
      const childViolations = new Map(
        (await findDirectChildActionViolations(db, farIds)).map((v) => [v.farId, v.parentFarId])
      );
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        const info = existing.get(data.farId);
        const violatingParent = childViolations.get(data.farId);
        if (violatingParent) {
          errors.push({
            row,
            farId: data.farId,
            message: `This asset is a child of "${violatingParent}" — dispose the parent instead.`
          });
        } else if (!info) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
        } else if (info.dateOfDisposal != null) {
          errors.push({ row, farId: data.farId, message: `Asset "${data.farId}" has already been disposed.` });
        } else if (data.dateOfDisposal < info.dateAcquired) {
          errors.push({
            row,
            farId: data.farId,
            message: `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(info.dateAcquired)}).`
          });
        } else if (info.dateOfAddition !== null && data.dateOfDisposal < info.dateOfAddition) {
          errors.push({
            row,
            farId: data.farId,
            message: `Disposal date cannot be before the asset's addition date (${isoToDDMMYYYY(info.dateOfAddition)}).`
          });
        } else {
          classified.push({ row, farId: data.farId, status: "update" });
        }
      }
      return mergePreviewRows(classified, errors);
    }

    const totalRows = validRows.length + errors.length;
    let processed = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      // Rule 1, same batched check as preview mode above — a child's row never reaches
      // disposeWithChildren at all.
      const childViolations = new Map(
        (await findDirectChildActionViolations(db, validRows.map(({ data }) => data.farId))).map((v) => [
          v.farId,
          v.parentFarId
        ])
      );
      // Each row now writes through disposeWithChildren (parent + cascade to every active
      // child), which needs an explicit transaction per disposalWriteOff.ts's own doc
      // comment — one BEGIN...COMMIT/ROLLBACK per row (not one for the whole loop, same
      // reasoning as bulkTransfers.ts) isolates a DB-level failure on one row to just that
      // row, while still keeping one row's parent+children write atomic.
      const client = await db.connect();
      try {
        for (const { row, data } of validRows) {
          const violatingParent = childViolations.get(data.farId);
          if (violatingParent) {
            errors.push({
              row,
              farId: data.farId,
              message: `This asset is a child of "${violatingParent}" — dispose the parent instead.`
            });
            continue;
          }
          try {
            await client.query("BEGIN");
            const result = await disposeWithChildren(client, data.farId, data.dateOfDisposal, data.saleValue);
            if (!result.written) {
              await client.query("ROLLBACK");
              const { rows: check } = await client.query<{
                date_of_disposal: string | null;
                date_acquired: string;
                date_of_addition: string | null;
              }>(
                `SELECT date_of_disposal, date_acquired, date_of_addition FROM assets WHERE far_id = $1`,
                [data.farId]
              );
              let message: string;
              if (check.length === 0) {
                message = `No asset found with FAR ID "${data.farId}".`;
              } else if (check[0]!.date_of_disposal !== null) {
                message = `Asset "${data.farId}" has already been disposed.`;
              } else if (check[0]!.date_of_addition !== null && data.dateOfDisposal < check[0]!.date_of_addition!) {
                message = `Disposal date cannot be before the asset's addition date (${isoToDDMMYYYY(check[0]!.date_of_addition!)}).`;
              } else {
                message = `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(check[0]!.date_acquired)}).`;
              }
              errors.push({ row, farId: data.farId, message });
              continue;
            }
            await client.query("COMMIT");
            processed++;
          } catch (err) {
            await client.query("ROLLBACK");
            errors.push({ row, farId: data.farId, message: err instanceof Error ? err.message : "Could not save this row." });
          }
        }
      } finally {
        client.release();
      }
    }

    // Disposals never create a new asset — every processed row is an update.
    return { totalRows, processed, added: 0, updated: processed, errors };
  });
}
