import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { ASSET_UPSERT_COLUMNS, bulkAssetRowSchema, bulkAssetRowValues, type BulkAssetRowInput } from "./assetSchema.js";
import { loadActiveMasterMaps, loadWorksheet, lookupCanonical, mergePreviewRows, parseWorksheetRows, type RowError } from "./bulkParse.js";
import { requirePermission, type AuthedUser } from "../auth/middleware.js";
import { isCenterInScope } from "../auth/centerScope.js";
import { blockingAssetMessage, hasRealC2Data } from "./componentTwoGuard.js";
import { logAssetActivity } from "./assetActivityLog.js";

// Center-scoped access: an upsert row can either create a brand-new asset (only its
// target `location` matters) or correct an existing one (whose `location` column CAN
// be changed this way, unlike the single Edit endpoint — see assetSchema.ts's own
// comment on why Bulk Upload is the one place a capitalization location gets
// corrected) — mechanically the same real-world effect as a Transfer, so it gets the
// same dual check: the existing row's CURRENT location (hidden as "not found" if out
// of scope, like every other write-on-an-existing-asset check) and the row's own
// `location` value (named directly, like Transfer's destination check — it's a center
// the row is actively assigning, known and visible in Masters either way). A no-op
// query for an unscoped user, same as every other scoped listing/check in this app.
async function rejectOutOfScopeRows(
  validRows: Array<{ row: number; data: BulkAssetRowInput }>,
  errors: RowError[],
  user: Pick<AuthedUser, "centerScope">
): Promise<{ validRows: Array<{ row: number; data: BulkAssetRowInput }>; errors: RowError[] }> {
  if (validRows.length === 0 || user.centerScope === null) return { validRows, errors };
  const db = await getPool();
  const farIds = validRows.map(({ data }) => data.farId);
  const { rows: existingRows } = await db.query<{ far_id: string; location: string; revised_location: string | null }>(
    `SELECT far_id, location, revised_location FROM assets WHERE far_id = ANY($1)`,
    [farIds]
  );
  const currentLocationByFarId = new Map(existingRows.map((r) => [r.far_id, r.revised_location ?? r.location]));

  const stillValid: Array<{ row: number; data: BulkAssetRowInput }> = [];
  const allErrors = [...errors];
  for (const { row, data } of validRows) {
    const currentLocation = currentLocationByFarId.get(data.farId);
    if (currentLocation !== undefined && !isCenterInScope(user, currentLocation)) {
      allErrors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
      continue;
    }
    if (!isCenterInScope(user, data.location)) {
      allErrors.push({ row, farId: data.farId, message: `"${data.location}" is outside your assigned center access.` });
      continue;
    }
    stillValid.push({ row, data });
  }
  return { validRows: stillValid, errors: allErrors };
}

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
    // Only checked once canonicalSubClass itself resolved — an unrecognized Sub
    // Classification is already rejected above, so there's no has_component2 to look up.
    if (canonicalSubClass && maps.subClassificationHasComponent2.get(canonicalSubClass) === false && hasRealC2Data(data)) {
      messages.push(blockingAssetMessage(data.farId, canonicalSubClass));
    }
    if (messages.length > 0) {
      allErrors.push({ row, farId: data.farId, message: messages.join("; ") });
      continue;
    }
    stillValid.push({ row, data: { ...data, status: canonicalStatus!, subClassification: canonicalSubClass!, location: canonicalLocation! } });
  }
  return { validRows: stillValid, errors: allErrors };
}

// Rejects the second and later occurrence of the same FAR ID within one uploaded file.
// Without this, two rows for the same FAR ID both pass schema/Masters validation, and the
// commit loop's INSERT ... ON CONFLICT DO UPDATE lets the last one silently win — the
// first row's values vanish with no error, and Preview mode would misleadingly count both
// as separate "new" rows even though only one asset ever ends up existing. Same seenKeys
// pattern bulkMasters.ts already uses for Centers/Sub Classifications/Statuses.
function rejectDuplicateFarIds(
  validRows: Array<{ row: number; data: BulkAssetRowInput }>,
  errors: RowError[]
): { validRows: Array<{ row: number; data: BulkAssetRowInput }>; errors: RowError[] } {
  const seen = new Set<string>();
  const stillValid: Array<{ row: number; data: BulkAssetRowInput }> = [];
  const allErrors = [...errors];
  for (const { row, data } of validRows) {
    const key = data.farId.toLowerCase();
    if (seen.has(key)) {
      allErrors.push({ row, farId: data.farId, message: `Duplicate FAR ID "${data.farId}" — already appears earlier in this file.` });
      continue;
    }
    seen.add(key);
    stillValid.push({ row, data });
  }
  return { validRows: stillValid, errors: allErrors };
}

// Rejects a row whose FAR ID belongs to a soft-deleted asset (Global Admin only, see
// routes/assets.ts's DELETE /api/assets/:farId). far_id is the primary key, so the
// commit loop's INSERT ... ON CONFLICT (far_id) DO UPDATE would otherwise silently
// overwrite a deleted row's data on every column except deleted_at itself — the asset
// would get fresh figures but stay invisible everywhere (deleted_at still set), a
// confusing "the upload succeeded but the asset vanished" result. Run before the
// preview/commit branch so both paths always agree.
async function rejectDeletedFarIds(
  validRows: Array<{ row: number; data: BulkAssetRowInput }>,
  errors: RowError[]
): Promise<{ validRows: Array<{ row: number; data: BulkAssetRowInput }>; errors: RowError[] }> {
  if (validRows.length === 0) return { validRows, errors };
  const db = await getPool();
  const farIds = validRows.map(({ data }) => data.farId);
  const { rows: deletedRows } = await db.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE far_id = ANY($1) AND deleted_at IS NOT NULL`,
    [farIds]
  );
  if (deletedRows.length === 0) return { validRows, errors };
  const deletedFarIds = new Set(deletedRows.map((r) => r.far_id));
  const stillValid: Array<{ row: number; data: BulkAssetRowInput }> = [];
  const allErrors = [...errors];
  for (const { row, data } of validRows) {
    if (deletedFarIds.has(data.farId)) {
      allErrors.push({
        row,
        farId: data.farId,
        message: `FAR ID "${data.farId}" was previously used by a deleted asset — it can't be reused. Contact a Global Admin.`
      });
      continue;
    }
    stillValid.push({ row, data });
  }
  return { validRows: stillValid, errors: allErrors };
}

export default async function bulkUploadRoutes(app: FastifyInstance) {
  // Bulk Uploads: parse a CSV/XLSX of assets (columns named after the shared AssetInput
  // fields, e.g. farId, subClassification, c1OpeningCost…), validate every row, and
  // upsert by FAR ID so the same file can both import new assets and correct existing
  // ones. Rows that fail validation are reported but don't block the valid rows.
  app.post("/api/assets/bulk-upload", { preHandler: requirePermission("bulkUpload", "capitalization") }, async (req, reply) => {
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
    ({ validRows, errors } = rejectDuplicateFarIds(validRows, errors));
    ({ validRows, errors } = await rejectDeletedFarIds(validRows, errors));
    ({ validRows, errors } = await validateAgainstMasters(validRows, errors));
    ({ validRows, errors } = await rejectOutOfScopeRows(validRows, errors, req.user!));

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

    // Captured before the commit loop below can push more entries into `errors`, so a
    // row that fails at the DB-write step isn't double-counted (once as a valid row,
    // once as an error) — same pattern bulkTransfers.ts/bulkDisposals.ts already use.
    const totalRows = validRows.length + errors.length;
    let processed = 0;
    let added = 0;
    let updated = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      const updateAssignments = ASSET_UPSERT_COLUMNS.filter((c) => c !== "far_id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      // Each row's write is its own statement (a single INSERT ... ON CONFLICT), so it's
      // already atomic on its own — no explicit transaction needed. Isolating the
      // try/catch per row (rather than wrapping the whole loop in one BEGIN...COMMIT,
      // as this used to) means a DB-level failure on one row reports just that row as an
      // error and leaves every already-succeeded row standing, matching this route's own
      // "rows that fail validation are reported but don't block the valid rows" contract
      // for DB-level failures too, not just schema ones. Mirrors bulkMasters.ts's commit
      // loop, which never had this gap.
      for (const { row, data } of validRows) {
        try {
          // `xmax = 0` on the returned row is Postgres's own way of telling an INSERT
          // from an ON CONFLICT UPDATE.
          const { rows: written } = await db.query<{ inserted: boolean }>(
            `INSERT INTO assets (${ASSET_UPSERT_COLUMNS.join(", ")})
             VALUES (${ASSET_UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (far_id) DO UPDATE SET ${updateAssignments}
             RETURNING (xmax = 0) AS inserted`,
            bulkAssetRowValues(data)
          );
          if (written[0]?.inserted) {
            added++;
            await logAssetActivity(db, {
              actorUserId: req.user!.id,
              action: "capitalization_create",
              farId: data.farId,
              details: { ...data, source: "bulk", sourceFilename: file.filename }
            });
          } else {
            updated++;
          }
          processed++;
        } catch (err) {
          errors.push({ row, farId: data.farId, message: err instanceof Error ? err.message : "Could not save this row." });
        }
      }
    }

    return { totalRows, processed, added, updated, errors };
  });
}
