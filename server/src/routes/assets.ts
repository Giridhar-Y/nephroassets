import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import { ASSET_INSERT_COLUMNS, assetCreateSchema, assetCreateValues, farId as farIdSchema } from "./assetSchema.js";
import { isoToDDMMYYYY, loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { disposeWithChildren } from "./disposalWriteOff.js";
import { validateParentLink } from "./parentLink.js";
import { requireEditor } from "../auth/middleware.js";

const disposalSchema = z.object({
  dateOfDisposal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  saleValue: z.coerce.number().min(0)
});

// The assets table has exactly one additionsC1/C2 + dateOfAddition pair per asset —
// same columns Capitalization's own "Mid-Year Additions" section already writes. This
// route lets that pair be set *after* capitalization instead of only during it, but the
// one-tranche-per-asset limit is unchanged: an asset that already has an addition
// recorded can't get a second one without overwriting (and losing) the first, so the
// route rejects that case rather than silently doing it. Supporting more than one
// addition per asset would need a real ledger table, not a bigger form.
const additionSchema = z
  .object({
    additionsC1: z.coerce.number().min(0).default(0),
    additionsC2: z.coerce.number().min(0).default(0),
    dateOfAddition: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Optional, separate from the addition itself: lets the Additions screen link this
    // (already-existing) asset to a parent in the same request instead of a second trip
    // through Edit. Omitted entirely means "don't touch the existing link" — unlike Edit's
    // parentFarId, there's no way to *clear* a link from this endpoint.
    parentFarId: z.string().min(1).optional()
  })
  .refine((data) => data.additionsC1 !== 0 || data.additionsC2 !== 0, {
    message: "At least one of Additions C1/C2 must be non-zero.",
    path: ["additionsC1"]
  });

// Editable-after-capitalization: FAR ID, Sub Classification, and Asset Description are
// identity/categorization fields the calc engine never reads — safe to correct without
// touching any historical figure. Date Acquired, Location, Status, the cost fields
// (c1/c2OpeningCost), and additionsC1/C2 + dateOfAddition are still deliberately NOT
// editable here — changing any of THOSE after the fact would rewrite a fact the engine
// has already used to compute historical figures (a correction to those belongs in Bulk
// Upload, which is explicit about being an upsert; a new addition has its own dedicated
// flow). Useful Life and Opening Acc Dep are NOT date-versioned anywhere in this engine
// (same as Capitalization already allows) — editing them recomputes every AS_AT, past
// and future, same as editing them would if entered wrong at Capitalization time.
const editAssetSchema = z.object({
  farId: farIdSchema,
  subClassification: z.string().min(1),
  assetDescription: z.string().min(1),
  serialNo: z.string().optional().default(""),
  usefulLifeC1Years: z.coerce.number().min(0),
  usefulLifeC2Years: z.coerce.number().min(0),
  accDepC1Opening: z.coerce.number().min(0),
  accDepC2Opening: z.coerce.number().min(0),
  // Parent/child: this asset always moves/disposes together with its parent. null clears
  // the relationship. Restricted to one level (enforced below, not by the schema) — a
  // parent can't itself be a child, and an asset with its own children can't become one.
  parentFarId: z.string().min(1).nullable()
});

// Capitalization's own createAsset payload never carries parentFarId — it's kept out of
// the shared assetCreateSchema/ASSET_INSERT_COLUMNS (assetSchema.ts) deliberately, since
// that shape is also bulk upload's row schema, and letting a spreadsheet row silently set
// parent_far_id with no validation would be the same kind of scope creep the disposal
// cascade was deliberately kept out of bulk upload for. Parsed as a second, separate
// schema against the same request body instead.
const capitalizationParentSchema = z.object({ parentFarId: z.string().min(1).optional() });

const mergeSchema = z.object({
  parentFarId: z.string().min(1),
  childFarIds: z.array(z.string().min(1)).min(1)
});

const SORTABLE_COLUMNS: Record<string, string> = {
  farId: "far_id",
  dateAcquired: "date_acquired",
  subClassification: "sub_classification",
  status: "status",
  location: "location"
};

// Comma-separated multi-value filters — client sends e.g. "Active,Disposed" as one query
// param (URLSearchParams.set(key, String(array)) already produces this), matched with
// `= ANY(...)` below instead of `=`.
const multiValue = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").filter(Boolean) : undefined));

const querySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  center: multiValue,
  // The raw `location` column (where an asset was capitalized) — deliberately separate
  // from `center`, which filters COALESCE(revised_location, location) (today's actual
  // location, after any transfers). An asset that's since moved should still be findable
  // by either its capitalized location or its current one.
  capLocation: multiValue,
  // Children of a given set of parents — e.g. "what does this parent's cascade cover".
  parentFarId: multiValue,
  subClassification: multiValue,
  status: multiValue,
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Additions Log (the new single-asset addition flow) — assets carrying a recorded
  // mid-year addition, regardless of Sub Classification/Status/etc. A plain string
  // check against "true" rather than z.coerce.boolean(), which coerces the *string*
  // "false" to `true` (JS's own Boolean("false") === true) — a real zod footgun.
  hasAddition: z.string().optional(),
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
  globalSearch: z.string().optional(),
  sortBy: z.enum(["farId", "dateAcquired", "subClassification", "status", "location"]).default("farId"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (Array.isArray(decoded) && decoded.length === 2) {
      return [String(decoded[0]), String(decoded[1])];
    }
  } catch {
    // fall through to null
  }
  return null;
}

function encodeCursor(sortValue: string, farId: string): string {
  return Buffer.from(JSON.stringify([sortValue, farId]), "utf-8").toString("base64url");
}

export default async function assetsRoutes(app: FastifyInstance) {
  app.get("/api/assets", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();

    // AS_AT defaults to the current setting so every list view stays anchored to the
    // same "as of" date shown in the top bar.
    let asAt = q.asAt;
    let fySettings: SettingsRow | undefined;
    {
      const { rows } = await db.query<SettingsRow>(
        `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
      );
      fySettings = rows[0];
    }
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    asAt ??= fySettings.as_at;

    const sortColumn = SORTABLE_COLUMNS[q.sortBy]!;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.center) {
      params.push(q.center);
      conditions.push(`COALESCE(revised_location, location) = ANY($${params.length})`);
    }
    if (q.capLocation) {
      params.push(q.capLocation);
      conditions.push(`location = ANY($${params.length})`);
    }
    if (q.parentFarId) {
      params.push(q.parentFarId);
      conditions.push(`parent_far_id = ANY($${params.length})`);
    }
    if (q.subClassification) {
      params.push(q.subClassification);
      conditions.push(`sub_classification = ANY($${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`status = ANY($${params.length})`);
    }
    // A fixed asset register as at a given date can never include an asset that wasn't
    // capitalized yet — always applied, not just when the user opts into the Date
    // Acquired filter, so viewing/exporting a prior period never lists an asset that
    // doesn't exist as of that date. The calc engine already zeroes its Gross Block/NBV
    // correctly for such a row (splitTranche gates on dateAcquired vs. AS_AT); the bug
    // was the row appearing in this list at all.
    params.push(asAt);
    conditions.push(`date_acquired <= $${params.length}`);
    if (q.dateAcquiredFrom) {
      params.push(q.dateAcquiredFrom);
      conditions.push(`date_acquired >= $${params.length}`);
    }
    if (q.dateAcquiredTo) {
      params.push(q.dateAcquiredTo);
      conditions.push(`date_acquired <= $${params.length}`);
    }
    if (q.hasAddition === "true") {
      conditions.push(`(additions_c1 <> 0 OR additions_c2 <> 0)`);
    }
    if (q.search) {
      params.push(`${q.search.toUpperCase()}%`);
      conditions.push(`far_id LIKE $${params.length}`);
    }
    if (q.descriptionSearch) {
      params.push(`%${q.descriptionSearch}%`);
      conditions.push(`asset_description ILIKE $${params.length}`);
    }
    if (q.globalSearch) {
      // The Register toolbar's single search box: matches any of these fields, unlike
      // the column-header filters above which are independent AND conditions. Fully
      // server-side against the whole table (not the client's lazy-loaded page), so a
      // match further down the list is found the same as one on the first page.
      params.push(`${q.globalSearch.toUpperCase()}%`);
      const farIdParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const descParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const subClassParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const statusParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const locationParam = params.length;
      conditions.push(
        `(far_id LIKE $${farIdParam}
          OR asset_description ILIKE $${descParam}
          OR sub_classification ILIKE $${subClassParam}
          OR status ILIKE $${statusParam}
          OR COALESCE(revised_location, location) ILIKE $${locationParam})`
      );
    }

    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      const [cursorSortValue, cursorFarId] = cursor;
      params.push(cursorSortValue, cursorFarId);
      const op = q.sortDir === "asc" ? ">" : "<";
      conditions.push(`(${sortColumn}, far_id) ${op} ($${params.length - 1}, $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(q.limit);
    const limitParamIndex = params.length;

    const sql = `
      SELECT *, EXISTS(SELECT 1 FROM assets c WHERE c.parent_far_id = assets.far_id) AS has_children
      FROM assets
      ${whereClause}
      ORDER BY ${sortColumn} ${q.sortDir}, far_id ${q.sortDir}
      LIMIT $${limitParamIndex}
    `;

    const { rows } = await db.query<AssetRow>(sql, params);

    const farIds = rows.map((r) => r.far_id);
    let transfers: TransferRow[] = [];
    if (farIds.length > 0) {
      const { rows: transferRows } = await db.query<TransferRow>(
        `SELECT far_id, transaction_date, location FROM transfers
         WHERE far_id = ANY($1) AND transaction_date <= $2
         ORDER BY far_id, transaction_date`,
        [farIds, asAt]
      );
      transfers = transferRows;
    }

    const fy = mapSettingsRow(fySettings);
    fy.asAt = asAt;

    const items = rows.map((row) => {
      const asset = mapAssetRow(row);
      const relevantTransfers = transfers
        .filter((t) => t.far_id === row.far_id)
        .map(mapTransferRow);
      const result = computeAsset(asset, fy, relevantTransfers);
      return { asset, result };
    });

    const last = rows[rows.length - 1];
    const nextCursor =
      last && rows.length === q.limit
        ? encodeCursor(String((last as unknown as Record<string, unknown>)[sortColumn]), last.far_id)
        : null;

    return { items, nextCursor, asAt };
  });

  // Asset 360: one asset's full record plus its complete transfer history (not just
  // transfers up to AS_AT — the lifecycle timeline shows everything that ever happened).
  app.get("/api/assets/:farId", async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const queryParsed = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    if (!paramsParsed.success || !queryParsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    const { farId } = paramsParsed.data;
    const db = await getPool();

    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1`, [farId]);
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }

    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const asAt = queryParsed.data.asAt ?? fySettings.as_at;

    const { rows: transferRows } = await db.query<
      TransferRow & { id: string | number; cascaded_from_parent_far_id: string | null }
    >(
      `SELECT id, far_id, transaction_date, location, cascaded_from_parent_far_id
       FROM transfers WHERE far_id = $1 ORDER BY transaction_date ASC, id ASC`,
      [farId]
    );

    const asset = mapAssetRow(row);
    const fy = mapSettingsRow(fySettings);
    fy.asAt = asAt;
    const relevantTransfers = transferRows.filter((t) => t.transaction_date <= asAt).map(mapTransferRow);
    const result = computeAsset(asset, fy, relevantTransfers);

    const transfers = transferRows.map((t) => ({
      id: Number(t.id),
      transactionDate: t.transaction_date,
      location: t.location,
      cascadedFromParentFarId: t.cascaded_from_parent_far_id
    }));

    return { asset, result, transfers, asAt };
  });

  // Capitalization: register a brand-new asset. Disposal fields are left at their
  // column defaults (null / 0) — an asset is never created pre-disposed.
  app.post("/api/assets", { preHandler: requireEditor }, async (req, reply) => {
    const parsed = assetCreateSchema.safeParse(req.body);
    const parentParsed = capitalizationParentSchema.safeParse(req.body);
    if (!parsed.success || !parentParsed.success) {
      reply.code(400);
      return { error: "Invalid asset payload.", details: (parsed.error ?? parentParsed.error)?.flatten() };
    }
    const parentFarId = parentParsed.data.parentFarId ?? null;
    const db = await getPool();

    // Same master-list check Bulk Upload applies (routes/bulkUpload.ts) — the
    // Capitalization form's dropdowns already only offer active master values, but a
    // direct API call could still send anything, and this is the one path that
    // additionally must reject a *system-managed* status (Disposed): a brand-new asset
    // must never be capitalized as already disposed, that's the Disposal flow's job.
    const maps = await loadActiveMasterMaps(db);
    const canonicalStatus = lookupCanonical(maps.statuses, parsed.data.status);
    const canonicalSubClass = lookupCanonical(maps.subClassifications, parsed.data.subClassification);
    const canonicalLocation = lookupCanonical(maps.centers, parsed.data.location);
    const badFields: string[] = [];
    if (!canonicalStatus) badFields.push(`Status "${parsed.data.status}"`);
    if (!canonicalSubClass) badFields.push(`Sub Classification "${parsed.data.subClassification}"`);
    if (!canonicalLocation) badFields.push(`Location "${parsed.data.location}"`);
    if (badFields.length > 0) {
      reply.code(400);
      return { error: `${badFields.join(", ")} not recognized — see Masters for valid values.` };
    }
    const { rows: statusRow } = await db.query<{ system_managed: boolean }>(
      `SELECT system_managed FROM statuses WHERE name = $1`,
      [canonicalStatus]
    );
    if (statusRow[0]?.system_managed) {
      reply.code(400);
      return { error: `Status "${canonicalStatus}" can only be set through the Disposal flow, not Capitalization.` };
    }
    const input = { ...parsed.data, status: canonicalStatus!, subClassification: canonicalSubClass!, location: canonicalLocation! };

    const { rows: existing } = await db.query(`SELECT 1 FROM assets WHERE far_id = $1`, [input.farId]);
    if (existing.length > 0) {
      reply.code(409);
      return { error: `An asset with FAR ID "${input.farId}" already exists.` };
    }
    if (parentFarId !== null) {
      const validation = await validateParentLink(db, input.farId, parentFarId);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.error };
      }
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO assets (${ASSET_INSERT_COLUMNS.join(", ")})
         VALUES (${ASSET_INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
        assetCreateValues(input)
      );
      if (parentFarId !== null) {
        await client.query(`UPDATE assets SET parent_far_id = $1 WHERE far_id = $2`, [parentFarId, input.farId]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { farId: input.farId, created: true };
  });

  // Edit: modify an already-capitalized asset's non-historical particulars (FAR ID, Sub
  // Classification, Asset Description, Serial No, Useful Life C1/C2, Opening Acc Dep
  // C1/C2) without going through Bulk Upload. See editAssetSchema's comment for why this
  // field list stops here.
  app.patch("/api/assets/:farId", { preHandler: requireEditor }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = editAssetSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid edit payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const input = bodyParsed.data;
    const db = await getPool();

    const { rows: existing } = await db.query<{ status: string; date_of_disposal: string | null; parent_far_id: string | null }>(
      `SELECT status, date_of_disposal, parent_far_id FROM assets WHERE far_id = $1`,
      [farId]
    );
    if (existing.length === 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    // A disposed asset's WDV/Profit-Loss on disposal was computed from Opening Acc Dep
    // at the time — editing it afterwards would silently rewrite an already-realized
    // disposal figure. Editing is only for an asset still on the books.
    if (existing[0]!.date_of_disposal !== null) {
      reply.code(409);
      return { error: `Asset "${farId}" has been disposed — its particulars can no longer be edited.` };
    }

    const maps = await loadActiveMasterMaps(db);
    const canonicalSubClass = lookupCanonical(maps.subClassifications, input.subClassification);
    if (!canonicalSubClass) {
      reply.code(400);
      return { error: `Sub Classification "${input.subClassification}" not recognized — see Masters for valid values.` };
    }

    // far_id is the primary key everything else (transfers, and now this same row) keys
    // off — only worth checking for a collision when it's actually changing.
    if (input.farId !== farId) {
      const { rows: collision } = await db.query(`SELECT 1 FROM assets WHERE far_id = $1`, [input.farId]);
      if (collision.length > 0) {
        reply.code(409);
        return { error: `FAR ID "${input.farId}" is already in use by another asset.` };
      }
    }

    // Parent/child is restricted to one level — a parent can't itself be a child, and an
    // asset that already has children of its own can't become one. Only worth validating
    // when the link is actually being set or changed, not when it's unchanged or being
    // cleared to null.
    if (input.parentFarId !== null && input.parentFarId !== existing[0]!.parent_far_id) {
      // input.farId is the *new* FAR ID this row is being renamed to (if any) — that's
      // what parent_far_id will end up pointing away from, so self-parent must check
      // against both the old and new identity.
      const validation =
        input.parentFarId === input.farId
          ? ({ ok: false, status: 400, error: "An asset cannot be its own parent." } as const)
          : await validateParentLink(db, farId, input.parentFarId);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.error };
      }
    }

    // A single UPDATE renaming far_id relies on transfers_far_id_fkey's ON UPDATE CASCADE
    // (see pool.ts) to carry that asset's transfer history to the new FAR ID atomically —
    // no separate repoint-then-rename dance needed.
    await db.query(
      `UPDATE assets
       SET far_id = $1, sub_classification = $2, asset_description = $3, serial_no = $4,
           useful_life_c1_years = $5, useful_life_c2_years = $6,
           acc_dep_c1_opening = $7, acc_dep_c2_opening = $8, parent_far_id = $9
       WHERE far_id = $10`,
      [
        input.farId,
        canonicalSubClass,
        input.assetDescription,
        input.serialNo,
        input.usefulLifeC1Years,
        input.usefulLifeC2Years,
        input.accDepC1Opening,
        input.accDepC2Opening,
        input.parentFarId,
        farId
      ]
    );
    return { farId: input.farId, updated: true };
  });

  // Bulk merge from Register: link one or more existing assets as children of one
  // existing parent in a single request — same validateParentLink rules Edit already
  // enforces one-at-a-time, applied per child, with nothing written until every child
  // passes (matches the confirm-step UX: nothing partially applies).
  app.post("/api/assets/merge", { preHandler: requireEditor }, async (req, reply) => {
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid merge payload.", details: parsed.error.flatten() };
    }
    const { parentFarId } = parsed.data;
    const childFarIds = Array.from(new Set(parsed.data.childFarIds));
    const db = await getPool();

    const { rows: childExisting } = await db.query<{ far_id: string }>(
      `SELECT far_id FROM assets WHERE far_id = ANY($1)`,
      [childFarIds]
    );
    const found = new Set(childExisting.map((r) => r.far_id));
    const missing = childFarIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID ${missing.map((id) => `"${id}"`).join(", ")}.` };
    }
    for (const childFarId of childFarIds) {
      const validation = await validateParentLink(db, childFarId, parentFarId);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: `${childFarId}: ${validation.error}` };
      }
    }

    await db.query(`UPDATE assets SET parent_far_id = $1 WHERE far_id = ANY($2)`, [parentFarId, childFarIds]);
    return { parentFarId, childFarIds, merged: childFarIds.length };
  });

  // Mid-Year Addition on an already-capitalized asset — writes the same
  // additionsC1/C2 + dateOfAddition columns Capitalization's own "Mid-Year Additions"
  // section uses, so the FY-rollover engine classifies it identically either way. See
  // additionSchema's comment for the one-addition-per-asset limit.
  app.patch("/api/assets/:farId/addition", { preHandler: requireEditor }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = additionSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid addition payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const input = bodyParsed.data;
    const db = await getPool();

    const { rows: existing } = await db.query<{
      date_acquired: string;
      date_of_disposal: string | null;
      additions_c1: string;
      additions_c2: string;
      date_of_addition: string | null;
    }>(
      `SELECT date_acquired, date_of_disposal, additions_c1, additions_c2, date_of_addition FROM assets WHERE far_id = $1`,
      [farId]
    );
    if (existing.length === 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    const row = existing[0]!;
    if (row.date_of_disposal !== null) {
      reply.code(409);
      return { error: `Asset "${farId}" has been disposed — no further additions can be recorded.` };
    }
    if (Number(row.additions_c1) !== 0 || Number(row.additions_c2) !== 0 || row.date_of_addition !== null) {
      reply.code(409);
      return {
        error: `Asset "${farId}" already has an addition recorded on ${isoToDDMMYYYY(row.date_of_addition!)} — a second addition isn't supported yet.`
      };
    }
    if (input.dateOfAddition < row.date_acquired) {
      reply.code(400);
      return {
        error: `Addition date cannot be before the asset's capitalization date (${isoToDDMMYYYY(row.date_acquired)}).`
      };
    }
    if (input.parentFarId !== undefined) {
      const validation = await validateParentLink(db, farId, input.parentFarId);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.error };
      }
    }

    const setClauses = ["additions_c1 = $1", "additions_c2 = $2", "date_of_addition = $3"];
    const values: unknown[] = [input.additionsC1, input.additionsC2, input.dateOfAddition];
    if (input.parentFarId !== undefined) {
      setClauses.push(`parent_far_id = $${values.length + 1}`);
      values.push(input.parentFarId);
    }
    values.push(farId);
    await db.query(`UPDATE assets SET ${setClauses.join(", ")} WHERE far_id = $${values.length}`, values);
    return { farId, added: true };
  });

  // Disposal preview: exactly what the real disposal would compute (same full-cost
  // write-off `applyFullDisposal` applies, same calc engine), for the *chosen* Disposal
  // Date — without writing anything. Lets the confirmation dialog show real WDV/Profit-
  // Loss figures instead of approximating with today's NBV. AS_AT is pinned to the
  // chosen Disposal Date itself (not whatever the app's global "Figures as of" is set
  // to) so depreciation accrues up to exactly that date, matching what disposing on it
  // for real would produce.
  app.post("/api/assets/:farId/disposal/preview", { preHandler: requireEditor }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = disposalSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid disposal payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { dateOfDisposal, saleValue } = bodyParsed.data;
    const db = await getPool();

    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1`, [farId]);
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    const asset = mapAssetRow(row);
    if (asset.dateOfDisposal !== null) {
      reply.code(409);
      return { error: `Asset "${farId}" has already been disposed.` };
    }
    if (dateOfDisposal < asset.dateAcquired) {
      reply.code(400);
      return {
        error: `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(asset.dateAcquired)}).`
      };
    }

    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const fy = mapSettingsRow(fySettings);
    fy.asAt = dateOfDisposal;

    const hypothetical = {
      ...asset,
      dateOfDisposal,
      deletionsC1: asset.c1OpeningCost + asset.additionsC1,
      deletionsC2: asset.c2OpeningCost + asset.additionsC2,
      saleValue
    };
    const result = computeAsset(hypothetical, fy, []);

    return {
      farId,
      c1Wdv: result.c1.wdvAtDisposal,
      c2Wdv: result.c2.wdvAtDisposal,
      totalWdv: (result.c1.wdvAtDisposal ?? 0) + (result.c2.wdvAtDisposal ?? 0),
      profitLoss: result.assetProfitLossOnDisposal ?? 0
    };
  });

  // Disposal: full disposal only, so Deletions is always the asset's entire capitalized
  // cost (opening + additions) rather than a user-entered partial amount. Cascades to
  // every still-active child of this asset (see disposeWithChildren) inside one
  // transaction, so a parent and its children are disposed together or not at all.
  app.patch("/api/assets/:farId/disposal", { preHandler: requireEditor }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = disposalSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid disposal payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { dateOfDisposal, saleValue } = bodyParsed.data;
    const db = await getPool();
    const client = await db.connect();
    let result: { written: boolean; childrenDisposed: string[] };
    try {
      await client.query("BEGIN");
      result = await disposeWithChildren(client, farId, dateOfDisposal, saleValue);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (!result.written) {
      const { rows: check } = await db.query<{ date_of_disposal: string | null; date_acquired: string }>(
        `SELECT date_of_disposal, date_acquired FROM assets WHERE far_id = $1`,
        [farId]
      );
      if (check.length === 0) {
        reply.code(404);
        return { error: `No asset found with FAR ID "${farId}".` };
      }
      if (check[0]!.date_of_disposal !== null) {
        reply.code(409);
        return { error: `Asset "${farId}" has already been disposed.` };
      }
      reply.code(400);
      return {
        error: `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(check[0]!.date_acquired)}).`
      };
    }
    return { farId, disposed: true, childrenDisposed: result.childrenDisposed };
  });
}
