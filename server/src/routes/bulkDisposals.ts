import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { loadWorksheet, parseWorksheetRows } from "./bulkParse.js";

const disposalRowSchema = z.object({
  farId: z.string().min(1),
  dateOfDisposal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

    const totalRows = validRows.length + errors.length;
    let processed = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const { row, data } of validRows) {
          const { rows: updated } = await client.query(
            `UPDATE assets
             SET date_of_disposal = $1,
                 deletions_c1 = c1_opening_cost + additions_c1,
                 deletions_c2 = c2_opening_cost + additions_c2,
                 sale_value = $2,
                 status = 'Disposed'
             WHERE far_id = $3 AND date_of_disposal IS NULL
             RETURNING far_id`,
            [data.dateOfDisposal, data.saleValue, data.farId]
          );
          if (updated.length === 0) {
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

    return { totalRows, processed, errors };
  });
}
