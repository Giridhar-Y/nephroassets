import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkDate, loadWorksheet, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";

const transferRowSchema = z.object({
  farId: z.string().min(1),
  toLocation: z.string().min(1),
  transactionDate: bulkDate
});

export default async function bulkTransfersRoutes(app: FastifyInstance) {
  // Bulk Transfers: same effect as POST /api/transfers (one transfer history row plus a
  // denormalized location update per asset), but each row can move to a different
  // center/date — the single endpoint only supports one shared destination per batch.
  app.post("/api/transfers/bulk-upload", async (req, reply) => {
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
      ({ validRows, errors } = parseWorksheetRows(worksheet, transferRowSchema));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    // Preview mode: same FAR-ID-exists check the commit loop below does, read-only.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const existing = new Set(
        farIds.length > 0
          ? (await db.query<{ far_id: string }>(`SELECT far_id FROM assets WHERE far_id = ANY($1)`, [farIds])).rows.map(
              (r) => r.far_id
            )
          : []
      );
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        if (!existing.has(data.farId)) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
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
          const { rows: exists } = await client.query(`SELECT 1 FROM assets WHERE far_id = $1`, [data.farId]);
          if (exists.length === 0) {
            errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
            continue;
          }
          await client.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`, [
            data.farId,
            data.transactionDate,
            data.toLocation
          ]);
          await client.query(`UPDATE assets SET revised_location = $1, last_date_of_transaction = $2 WHERE far_id = $3`, [
            data.toLocation,
            data.transactionDate,
            data.farId
          ]);
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

    // Transfers never create a new asset — every processed row is an update.
    return { totalRows, processed, added: 0, updated: processed, errors };
  });
}
