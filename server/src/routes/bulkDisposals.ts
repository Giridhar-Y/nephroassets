import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkDate, loadWorksheet, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";
import { applyFullDisposal } from "./disposalWriteOff.js";

const disposalRowSchema = z.object({
  farId: z.string().min(1),
  dateOfDisposal: bulkDate,
  saleValue: z.coerce.number().min(0).default(0)
});

export default async function bulkDisposalsRoutes(app: FastifyInstance) {
  // Bulk Disposals: same full-disposal semantics as PATCH /api/assets/:farId/disposal
  // (deletions = the asset's entire capitalized cost, status forced to Disposed),
  // applied to every row in a CSV/XLSX instead of one asset at a time.
  app.post("/api/assets/bulk-dispose", async (req, reply) => {
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

    // Preview mode: same not-found / already-disposed checks the commit loop below does,
    // against the same schema-valid rows, but read-only — no UPDATE, no transaction.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const existing = new Map<string, string | null>();
      if (farIds.length > 0) {
        const { rows } = await db.query<{ far_id: string; date_of_disposal: string | null }>(
          `SELECT far_id, date_of_disposal FROM assets WHERE far_id = ANY($1)`,
          [farIds]
        );
        for (const r of rows) existing.set(r.far_id, r.date_of_disposal);
      }
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        if (!existing.has(data.farId)) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
        } else if (existing.get(data.farId) != null) {
          errors.push({ row, farId: data.farId, message: `Asset "${data.farId}" has already been disposed.` });
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const { row, data } of validRows) {
          const written = await applyFullDisposal(client, data.farId, data.dateOfDisposal, data.saleValue);
          if (!written) {
            const { rows: check } = await client.query(`SELECT date_of_disposal FROM assets WHERE far_id = $1`, [
              data.farId
            ]);
            errors.push({
              row,
              farId: data.farId,
              message:
                check.length === 0
                  ? `No asset found with FAR ID "${data.farId}".`
                  : `Asset "${data.farId}" has already been disposed.`
            });
            continue;
          }
          processed++;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    // Disposals never create a new asset — every processed row is an update.
    return { totalRows, processed, added: 0, updated: processed, errors };
  });
}
