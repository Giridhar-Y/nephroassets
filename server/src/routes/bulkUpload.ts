import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { ASSET_UPSERT_COLUMNS, bulkAssetRowSchema, bulkAssetRowValues, type BulkAssetRowInput } from "./assetSchema.js";
import { loadActiveMasterMaps, loadWorksheet, lookupCanonical, mergePreviewRows, parseWorksheetRows, type RowError } from "./bulkParse.js";
import { requireEditor } from "../auth/middleware.js";

// Rejects (rather than silently accepting) a status/subClassification/location that
// doesn't match an active Masters entry (routes/masters.ts) — case-insensitively, but the
// row is rewritten to the master list's own canonical casing before it's ever written to
// assets, so "it equipment" and "IT Equipment" end up as the exact same stored value.
async function validateAgainstMasters(
  validRows: Array<{ row: number; data: BulkAssetRowInput }>,
  errors: RowError[]
): Promise<{ validRows: Array<{ row: number; data: BulkAssetRowInput }>; errors: RowError[] }> {
  const maps = await loadActiveMasterMaps(await getPool());
  const stillValid: Array<{ row: number; data: BulkAssetRowInput }> = [];
  const allErrors = [...errors];
  for (const { row, data } of validRows) {
    const canonicalStatus = lookupCanonical(maps.statuses, data.status);
    const canonicalSubClass = lookupCanonical(maps.subClassifications, data.subClassification);
    const canonicalLocation = lookupCanonical(maps.centers, data.location);
    const messages: string[] = [];
    if (!canonicalStatus) messages.push(`Status "${data.status}" not recognized — see Masters for valid values.`);
    if (!canonicalSubClass) {
      messages.push(`Sub Classification "${data.subClassification}" not recognized — see Masters for valid values.`);
    }
    if (!canonicalLocation) messages.push(`Location "${data.location}" not recognized — see Masters for valid values.`);
    if (messages.length > 0) {
      allErrors.push({ row, farId: data.farId, message: messages.join("; ") });
      continue;
    }
    stillValid.push({ row, data: { ...data, status: canonicalStatus!, subClassification: canonicalSubClass!, location: canonicalLocation! } });
  }
  return { validRows: stillValid, errors: allErrors };
}

export default async function bulkUploadRoutes(app: FastifyInstance) {
  // Bulk Uploads: parse a CSV/XLSX of assets (columns named after the shared AssetInput
  // fields, e.g. farId, subClassification, c1OpeningCost…), validate every row, and
  // upsert by FAR ID so the same file can both import new assets and correct existing
  // ones. Rows that fail validation are reported but don't block the valid rows.
  app.post("/api/assets/bulk-upload", { preHandler: requireEditor }, async (req, reply) => {
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
    ({ validRows, errors } = await validateAgainstMasters(validRows, errors));

    // Preview mode: classify each valid row as new (FAR ID not on file) or update (FAR ID
    // already exists), without writing anything — Confirm Upload re-submits the same file
    // to this same route without ?preview, so the two are guaranteed to agree.
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
      const classified = validRows.map(({ row, data }) => ({
        row,
        farId: data.farId,
        status: existing.has(data.farId) ? ("update" as const) : ("new" as const)
      }));
      return mergePreviewRows(classified, errors);
    }

    let processed = 0;
    let added = 0;
    let updated = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      const client = await db.connect();
      const updateAssignments = ASSET_UPSERT_COLUMNS.filter((c) => c !== "far_id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      try {
        await client.query("BEGIN");
        for (const { data } of validRows) {
          // `xmax = 0` on the returned row is Postgres's own way of telling an INSERT
          // from an ON CONFLICT UPDATE — reused here (rather than a pre-check SELECT) so
          // two rows in the same file with the same FAR ID are still each counted right.
          const { rows: written } = await client.query<{ inserted: boolean }>(
            `INSERT INTO assets (${ASSET_UPSERT_COLUMNS.join(", ")})
             VALUES (${ASSET_UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (far_id) DO UPDATE SET ${updateAssignments}
             RETURNING (xmax = 0) AS inserted`,
            bulkAssetRowValues(data)
          );
          if (written[0]?.inserted) added++;
          else updated++;
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

    return { totalRows: validRows.length + errors.length, processed, added, updated, errors };
  });
}
