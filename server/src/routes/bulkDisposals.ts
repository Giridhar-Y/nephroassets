import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkDate, isoToDDMMYYYY, loadWorksheet, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";
import { applyFullDisposal } from "./disposalWriteOff.js";
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

    // Preview mode: same not-found / already-disposed / before-capitalization checks the
    // commit loop below does, against the same schema-valid rows, but read-only — no
    // UPDATE, no transaction.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const existing = new Map<string, { dateOfDisposal: string | null; dateAcquired: string }>();
      if (farIds.length > 0) {
        const { rows } = await db.query<{ far_id: string; date_of_disposal: string | null; date_acquired: string }>(
          `SELECT far_id, date_of_disposal, date_acquired FROM assets WHERE far_id = ANY($1)`,
          [farIds]
        );
        for (const r of rows) existing.set(r.far_id, { dateOfDisposal: r.date_of_disposal, dateAcquired: r.date_acquired });
      }
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        const info = existing.get(data.farId);
        if (!info) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
        } else if (info.dateOfDisposal != null) {
          errors.push({ row, farId: data.farId, message: `Asset "${data.farId}" has already been disposed.` });
        } else if (data.dateOfDisposal < info.dateAcquired) {
          errors.push({
            row,
            farId: data.farId,
            message: `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(info.dateAcquired)}).`
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
      // Each row's write (applyFullDisposal) is a single UPDATE statement, already atomic
      // on its own — no explicit transaction needed. try/catch is per row (rather than
      // wrapping the whole loop in one BEGIN...COMMIT, as this used to be) so a DB-level
      // failure on one row reports just that row as an error and leaves every
      // already-succeeded row standing. Mirrors bulkMasters.ts's commit loop.
      for (const { row, data } of validRows) {
        try {
          const written = await applyFullDisposal(db, data.farId, data.dateOfDisposal, data.saleValue);
          if (!written) {
            const { rows: check } = await db.query<{ date_of_disposal: string | null; date_acquired: string }>(
              `SELECT date_of_disposal, date_acquired FROM assets WHERE far_id = $1`,
              [data.farId]
            );
            let message: string;
            if (check.length === 0) {
              message = `No asset found with FAR ID "${data.farId}".`;
            } else if (check[0]!.date_of_disposal !== null) {
              message = `Asset "${data.farId}" has already been disposed.`;
            } else {
              message = `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(check[0]!.date_acquired)}).`;
            }
            errors.push({ row, farId: data.farId, message });
            continue;
          }
          processed++;
        } catch (err) {
          errors.push({ row, farId: data.farId, message: err instanceof Error ? err.message : "Could not save this row." });
        }
      }
    }

    // Disposals never create a new asset — every processed row is an update.
    return { totalRows, processed, added: 0, updated: processed, errors };
  });
}
