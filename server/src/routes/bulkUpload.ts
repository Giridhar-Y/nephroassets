import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { ASSET_UPSERT_COLUMNS, bulkAssetRowSchema, bulkAssetRowValues } from "./assetSchema.js";
import { loadWorksheet, parseWorksheetRows } from "./bulkParse.js";

export default async function bulkUploadRoutes(app: FastifyInstance) {
  // Bulk Uploads: parse a CSV/XLSX of assets (columns named after the shared AssetInput
  // fields, e.g. farId, subClassification, c1OpeningCost…), validate every row, and
  // upsert by FAR ID so the same file can both import new assets and correct existing
  // ones. Rows that fail validation are reported but don't block the valid rows.
  app.post("/api/assets/bulk-upload", async (req, reply) => {
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
      ({ validRows, errors } = parseWorksheetRows(worksheet, bulkAssetRowSchema));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    let processed = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      const client = await db.connect();
      const updateAssignments = ASSET_UPSERT_COLUMNS.filter((c) => c !== "far_id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      try {
        await client.query("BEGIN");
        for (const { data } of validRows) {
          await client.query(
            `INSERT INTO assets (${ASSET_UPSERT_COLUMNS.join(", ")})
             VALUES (${ASSET_UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (far_id) DO UPDATE SET ${updateAssignments}`,
            bulkAssetRowValues(data)
          );
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

    return { totalRows: validRows.length + errors.length, processed, errors };
  });
}
