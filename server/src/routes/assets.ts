import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import { maxIsoDate } from "../calc/dates.js";
import { round2, splitDepreciationByLocation } from "../reports/transferDepreciationSplit.js";
import { ASSET_INSERT_COLUMNS, assetCreateSchema, assetCreateValues, farId as farIdSchema } from "./assetSchema.js";
import { isoToDDMMYYYY, loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { blockingAssetMessage, hasRealC2Data } from "./componentTwoGuard.js";
import { disposeWithChildren, undoDisposalWithChildren, type DisposalSnapshot } from "./disposalWriteOff.js";
import { findDirectChildActionViolations, validateParentLink } from "./parentLink.js";
import { requirePermission } from "../auth/middleware.js";
import { centerScopeSql, isCenterInScope } from "../auth/centerScope.js";
import { logAssetDelete } from "./assetDeleteAudit.js";
import { logAssetActivity } from "./assetActivityLog.js";
import { buildCalcCteExtras, buildConditionSql, conditionsQuerySchema, TOTAL_WDV_AND_PROFIT_LOSS_SQL } from "./assetColumnFilters.js";

const disposalSchema = z.object({
  dateOfDisposal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  saleValue: z.coerce.number().min(0)
});

// Shared by every Global-Admin-only delete/undo endpoint below — a reason is required,
// not optional, so asset_delete_audit_log never has a blank explanation for an
// irreversible-looking action.
const deleteReasonSchema = z.object({ reason: z.string().trim().min(1, "A reason is required.") });

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
  // No .int() — fractional useful life is a real, supported case; see assetSchema.ts's
  // identical field for why.
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
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Register's "N loaded / total" counter — the client asks for this only on a fresh
  // filter load, not on every scroll-triggered "load more" page, since it's an extra
  // COUNT(*) query (over the calc CTE too, when a computed-column condition is active)
  // that only needs recomputing when the filters themselves change.
  includeTotal: z.string().optional(),
  // Excel-style per-column custom filter conditions (Register's column-header
  // filters) — see assetColumnFilters.ts. AND'd with every filter above, and with each
  // other, same as every existing condition in this route.
  conditions: conditionsQuerySchema
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
  app.get("/api/assets", { preHandler: requirePermission("register", "view") }, async (req, reply) => {
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

    // Center-scoped access (auth/centerScope.ts) — always applied when the user is
    // scoped, ANDed with whatever center filter they explicitly chose above (which can
    // only narrow further within it, never escape it). No-op (null) for every
    // pre-existing unscoped user.
    const scopeSql = centerScopeSql(req.user!, "COALESCE(revised_location, location)", params);
    if (scopeSql) conditions.push(scopeSql);

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
    // Soft-deleted (Global Admin only, DELETE /api/assets/:farId) — always excluded from
    // the active Register, not an opt-in filter.
    conditions.push(`deleted_at IS NULL`);
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

    // Snapshot before the cursor condition below joins in — the total must count every
    // row matching the filters, not just the ones after the current scroll position.
    const filterConditions = [...conditions];
    const filterParams = [...params];

    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      const [cursorSortValue, cursorFarId] = cursor;
      params.push(cursorSortValue, cursorFarId);
      const op = q.sortDir === "asc" ? ">" : "<";
      conditions.push(`(${sortColumn}, far_id) ${op} ($${params.length - 1}, $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Excel-style column-header conditions — resolved against the calc CTE below (which
    // exposes far_calc_component's c1/c2 composites plus the handful of other derived
    // columns AssetGrid renders), so a filter on a computed field like NBV or Acc Dep
    // works the same as one on a raw stored column. Applied in the outer query, after
    // the CTE, not folded into `conditions` above — those are evaluated pre-calc for
    // cheapness, these need the calc to exist first.
    const computedConditions: string[] = [];
    for (const cond of q.conditions) {
      const built = buildConditionSql(cond, params, { fyStart: fySettings.fy_start, fyEnd: fySettings.fy_end });
      if ("error" in built) {
        reply.code(400);
        return { error: built.error };
      }
      computedConditions.push(built.sql);
    }
    const computedWhereClause = computedConditions.length > 0 ? `WHERE ${computedConditions.join(" AND ")}` : "";

    const calcExtras = buildCalcCteExtras(params, asAt, {
      fyStart: fySettings.fy_start,
      fyEnd: fySettings.fy_end,
      daysInFy: fySettings.days_in_fy
    });

    params.push(q.limit);
    const limitParamIndex = params.length;

    const sql = `
      WITH calc_base AS (
        SELECT assets.*, EXISTS(SELECT 1 FROM assets c WHERE c.parent_far_id = assets.far_id AND c.deleted_at IS NULL) AS has_children,
          ${calcExtras}
        FROM assets
        ${whereClause}
      ), calc AS (
        SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
        FROM calc_base
      )
      SELECT * FROM calc
      ${computedWhereClause}
      ORDER BY ${sortColumn} ${q.sortDir}, far_id ${q.sortDir}
      LIMIT $${limitParamIndex}
    `;

    let rows: AssetRow[];
    try {
      ({ rows } = await db.query<AssetRow>(sql, params));
    } catch (err) {
      // A malformed or unsupported filter combination should never surface as a bare
      // Fastify/Vercel 500 with a raw Postgres error message (an "ambiguous column" or
      // similar internal detail means nothing to someone applying a filter on Register).
      // Full technical detail still goes to the server log for debugging; the client
      // gets a plain-language message instead. See assetColumnFilters.ts's per-column
      // SQL registry for the class of bug this guards against.
      req.log.error({ err, sql, params }, "GET /api/assets query failed");
      reply.code(500);
      return { error: "Could not load the register with these filters — try removing or adjusting one of them." };
    }

    const farIds = rows.map((r) => r.far_id);
    let transfers: TransferRow[] = [];
    if (farIds.length > 0) {
      const { rows: transferRows } = await db.query<TransferRow>(
        `SELECT far_id, transaction_date, location FROM transfers
         WHERE far_id = ANY($1) AND transaction_date <= $2 AND deleted_at IS NULL
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

    let total: number | undefined;
    if (q.includeTotal === "true") {
      const totalWhereClause = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";
      if (q.conditions.length === 0) {
        // Cheap path — no Excel-style computed-column condition is active, so the count
        // can run directly against the table without paying for the calc CTE at all.
        const { rows: countRows } = await db.query<{ count: string }>(
          `SELECT COUNT(*)::bigint AS count FROM assets ${totalWhereClause}`,
          filterParams
        );
        total = Number(countRows[0]!.count);
      } else {
        // A computed condition (e.g. NBV, Acc Dep) needs the same calc CTE the main query
        // uses — same pattern as assetsExport.ts's own totals query: a fresh params array,
        // not the shared one, since its own calc-CTE params would otherwise collide with
        // indices already used above.
        const totalParams = [...filterParams];
        const totalCalcExtras = buildCalcCteExtras(totalParams, asAt, {
          fyStart: fySettings.fy_start,
          fyEnd: fySettings.fy_end,
          daysInFy: fySettings.days_in_fy
        });
        const totalComputedConditions = q.conditions.map((cond) => {
          const built = buildConditionSql(cond, totalParams, { fyStart: fySettings.fy_start, fyEnd: fySettings.fy_end });
          return "error" in built ? "" : built.sql;
        });
        const totalComputedWhereClause =
          totalComputedConditions.length > 0 ? `WHERE ${totalComputedConditions.join(" AND ")}` : "";
        const totalSql = `WITH calc_base AS (
             SELECT assets.*, ${totalCalcExtras}
             FROM assets ${totalWhereClause}
           ), calc AS (
             SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
             FROM calc_base
           )
           SELECT COUNT(*)::bigint AS count FROM calc ${totalComputedWhereClause}`;
        const { rows: countRows } = await db.query<{ count: string }>(totalSql, totalParams);
        total = Number(countRows[0]!.count);
      }
    }

    return { items, nextCursor, asAt, total };
  });

  // Asset 360: one asset's full record plus its complete transfer history (not just
  // transfers up to AS_AT — the lifecycle timeline shows everything that ever happened).
  app.get("/api/assets/:farId", { preHandler: requirePermission("register", "view") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const queryParsed = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    if (!paramsParsed.success || !queryParsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    const { farId } = paramsParsed.data;
    const db = await getPool();

    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1 AND deleted_at IS NULL`, [farId]);
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    // Center-scoped access: an out-of-scope asset 404s exactly like a nonexistent one —
    // a scoped user has no reason to know it exists at all, so this can't distinguish
    // "not found" from "not yours" (see the approved model's own reasoning).
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
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

    // Deleted transfers are excluded even from this full-lifecycle timeline (unlike the
    // asset row above, whose own deletion 404s the whole endpoint, a transfer can be
    // individually deleted while the asset stays active — see routes/transfers.ts's
    // DELETE /api/transfers/:id) — a deleted transfer is gone from every view, not just
    // the active Register.
    const { rows: transferRows } = await db.query<
      TransferRow & { id: string | number; cascaded_from_parent_far_id: string | null }
    >(
      `SELECT id, far_id, transaction_date, location, cascaded_from_parent_far_id
       FROM transfers WHERE far_id = $1 AND deleted_at IS NULL ORDER BY transaction_date ASC, id ASC`,
      [farId]
    );

    const asset = mapAssetRow(row);
    const fy = mapSettingsRow(fySettings);
    fy.asAt = asAt;
    const relevantTransfers = transferRows.filter((t) => t.transaction_date <= asAt).map(mapTransferRow);
    const result = computeAsset(asset, fy, relevantTransfers);

    // Center-wise depreciation breakdown for the current period, reusing the exact same
    // split the Asset Movement & Depreciation Schedule report uses per location-stay
    // (see reports.ts's computeMovementSchedulePage) — same period bounds, same
    // days-weighted allocation, just scoped to this one FAR ID instead of a full-table
    // scan.
    const periodStart = maxIsoDate([fy.fyStart, asset.dateAcquired]);
    const periodEnd = result.c1.effectiveEndDate;
    const locationSegments = splitDepreciationByLocation(
      asset.location,
      relevantTransfers,
      periodStart,
      periodEnd,
      round2(result.c1.periodDepreciation),
      round2(result.c2.periodDepreciation)
    );

    const transfers = transferRows.map((t) => ({
      id: Number(t.id),
      transactionDate: t.transaction_date,
      location: t.location,
      cascadedFromParentFarId: t.cascaded_from_parent_far_id
    }));

    return { asset, result, transfers, asAt, locationSegments };
  });

  // Capitalization: register a brand-new asset. Disposal fields are left at their
  // column defaults (null / 0) — an asset is never created pre-disposed.
  app.post("/api/assets", { preHandler: requirePermission("capitalization", "create") }, async (req, reply) => {
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
    // Center-scoped access: unlike an out-of-scope EXISTING asset (404, hides
    // existence), this is a center the user is actively choosing — it's a known,
    // visible Masters value, so "you don't manage it" is the honest answer.
    if (!isCenterInScope(req.user!, canonicalLocation!)) {
      reply.code(403);
      return { error: `"${canonicalLocation}" is outside your assigned center access.` };
    }
    const { rows: statusRow } = await db.query<{ system_managed: boolean }>(
      `SELECT system_managed FROM statuses WHERE name = $1`,
      [canonicalStatus]
    );
    if (statusRow[0]?.system_managed) {
      reply.code(400);
      return { error: `Status "${canonicalStatus}" can only be set through the Disposal flow, not Capitalization.` };
    }
    if (
      maps.subClassificationHasComponent2.get(canonicalSubClass!) === false &&
      hasRealC2Data(parsed.data)
    ) {
      reply.code(400);
      return { error: blockingAssetMessage(parsed.data.farId, canonicalSubClass!) };
    }
    const input = { ...parsed.data, status: canonicalStatus!, subClassification: canonicalSubClass!, location: canonicalLocation! };

    // far_id is the primary key, so even a soft-deleted row still occupies it — checked
    // unfiltered (not AND deleted_at IS NULL) on purpose, since the INSERT below would
    // fail on that same row regardless. The message distinguishes the two cases so a
    // deleted-FAR-ID collision doesn't look like a plain duplicate.
    const { rows: existing } = await db.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM assets WHERE far_id = $1`,
      [input.farId]
    );
    if (existing.length > 0) {
      reply.code(409);
      return {
        error:
          existing[0]!.deleted_at !== null
            ? `FAR ID "${input.farId}" was previously used by a deleted asset — it can't be reused. Contact a Global Admin.`
            : `An asset with FAR ID "${input.farId}" already exists.`
      };
    }
    if (parentFarId !== null) {
      const validation = await validateParentLink(db, input.farId, parentFarId, req.user!);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.errors.join(" ") };
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
    await logAssetActivity(db, {
      actorUserId: req.user!.id,
      action: "capitalization_create",
      farId: input.farId,
      details: { ...input, parentFarId, source: "single" }
    });
    return { farId: input.farId, created: true };
  });

  // Edit: modify an already-capitalized asset's non-historical particulars (FAR ID, Sub
  // Classification, Asset Description, Serial No, Useful Life C1/C2, Opening Acc Dep
  // C1/C2) without going through Bulk Upload. See editAssetSchema's comment for why this
  // field list stops here.
  app.patch("/api/assets/:farId", { preHandler: requirePermission("register", "edit") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = editAssetSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid edit payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const input = bodyParsed.data;
    const db = await getPool();

    const { rows: existing } = await db.query<{
      status: string;
      date_of_disposal: string | null;
      parent_far_id: string | null;
      c1_opening_cost: string | number;
      c2_opening_cost: string | number;
      additions_c2: string | number;
      deletions_c2: string | number;
      location: string;
      revised_location: string | null;
    }>(
      `SELECT status, date_of_disposal, parent_far_id, c1_opening_cost, c2_opening_cost, additions_c2, deletions_c2, location, revised_location
       FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    if (existing.length === 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    // Center-scoped access: treated exactly like a nonexistent asset — see GET
    // /api/assets/:farId's own comment for the reasoning.
    if (!isCenterInScope(req.user!, existing[0]!.revised_location ?? existing[0]!.location)) {
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

    // Opening cost itself isn't editable here (see editAssetSchema's comment), so this
    // checks the submitted Opening Acc Dep against the asset's existing, unchanged cost —
    // the engine's NBV math (openingNbv = openingGrossBlock - accDepOpening, and the
    // end-of-life taper's taperNbv) assumes accDepOpening never exceeds what the asset
    // actually cost. Same check as assetCreateSchema's checkAccDepWithinCost, duplicated
    // here rather than shared: this route compares against a *fetched* cost, not a
    // submitted one, so it can't reuse the same Zod refinement directly.
    const c1OpeningCost = Number(existing[0]!.c1_opening_cost);
    const c2OpeningCost = Number(existing[0]!.c2_opening_cost);
    if (input.accDepC1Opening > c1OpeningCost) {
      reply.code(400);
      return {
        error: `Component 1 Opening Acc. Dep. (${input.accDepC1Opening}) cannot exceed Component 1 Opening Cost (${c1OpeningCost}).`
      };
    }
    if (input.accDepC2Opening > c2OpeningCost) {
      reply.code(400);
      return {
        error: `Component 2 Opening Acc. Dep. (${input.accDepC2Opening}) cannot exceed Component 2 Opening Cost (${c2OpeningCost}).`
      };
    }

    const maps = await loadActiveMasterMaps(db);
    const canonicalSubClass = lookupCanonical(maps.subClassifications, input.subClassification);
    if (!canonicalSubClass) {
      reply.code(400);
      return { error: `Sub Classification "${input.subClassification}" not recognized — see Masters for valid values.` };
    }

    // Rule 4 of Has Component 2: an asset can't sit under a C1-only classification while
    // it still has real C2 data. c2OpeningCost/additionsC2/deletionsC2 aren't editable
    // here (see editAssetSchema's comment), so they come from the existing row; only
    // accDepC2Opening is checked against the submitted value, since this same request
    // can change it.
    if (
      maps.subClassificationHasComponent2.get(canonicalSubClass) === false &&
      hasRealC2Data({
        c2OpeningCost,
        additionsC2: Number(existing[0]!.additions_c2),
        deletionsC2: Number(existing[0]!.deletions_c2),
        accDepC2Opening: input.accDepC2Opening
      })
    ) {
      reply.code(400);
      return { error: blockingAssetMessage(input.farId, canonicalSubClass) };
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
          ? ({ ok: false, status: 400, errors: ["An asset cannot be its own parent."] } as const)
          : await validateParentLink(db, farId, input.parentFarId, req.user!);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.errors.join(" ") };
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
  app.post("/api/assets/merge", { preHandler: requirePermission("register", "edit") }, async (req, reply) => {
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid merge payload.", details: parsed.error.flatten() };
    }
    const { parentFarId } = parsed.data;
    const childFarIds = Array.from(new Set(parsed.data.childFarIds));
    const db = await getPool();

    const { rows: allExisting } = await db.query<{ far_id: string; location: string; revised_location: string | null }>(
      `SELECT far_id, location, revised_location FROM assets WHERE far_id = ANY($1) AND deleted_at IS NULL`,
      [[parentFarId, ...childFarIds]]
    );
    const byFarId = new Map(allExisting.map((r) => [r.far_id, r]));
    const missing = childFarIds.filter((id) => !byFarId.has(id));
    if (missing.length > 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID ${missing.map((id) => `"${id}"`).join(", ")}.` };
    }
    // Center-scoped access: parent and every child's current location must be in
    // scope — treated exactly like a nonexistent asset, same reasoning as every other
    // write-on-an-existing-asset check. A missing parent (not yet checked above) is
    // simply skipped here; validateParentLink below still catches it.
    const outOfScope = [parentFarId, ...childFarIds].filter((id) => {
      const row = byFarId.get(id);
      return row !== undefined && !isCenterInScope(req.user!, row.revised_location ?? row.location);
    });
    if (outOfScope.length > 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID ${outOfScope.map((id) => `"${id}"`).join(", ")}.` };
    }
    for (const childFarId of childFarIds) {
      const validation = await validateParentLink(db, childFarId, parentFarId, req.user!);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: `${childFarId}: ${validation.errors.join(" ")}` };
      }
    }

    await db.query(`UPDATE assets SET parent_far_id = $1 WHERE far_id = ANY($2)`, [parentFarId, childFarIds]);
    return { parentFarId, childFarIds, merged: childFarIds.length };
  });

  // Mid-Year Addition on an already-capitalized asset — writes the same
  // additionsC1/C2 + dateOfAddition columns Capitalization's own "Mid-Year Additions"
  // section uses, so the FY-rollover engine classifies it identically either way. See
  // additionSchema's comment for the one-addition-per-asset limit.
  app.patch("/api/assets/:farId/addition", { preHandler: requirePermission("additions", "create") }, async (req, reply) => {
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
      sub_classification: string;
      location: string;
      revised_location: string | null;
    }>(
      `SELECT date_acquired, date_of_disposal, additions_c1, additions_c2, date_of_addition, sub_classification, location, revised_location
       FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    if (existing.length === 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    const row = existing[0]!;
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (row.date_of_disposal !== null) {
      reply.code(409);
      return { error: `Asset "${farId}" has been disposed — no further additions can be recorded.` };
    }
    if (input.additionsC2 !== 0) {
      const { rows: subClassRow } = await db.query<{ has_component2: boolean }>(
        `SELECT has_component2 FROM sub_classifications WHERE name = $1`,
        [row.sub_classification]
      );
      if (subClassRow[0]?.has_component2 === false) {
        reply.code(400);
        return { error: blockingAssetMessage(farId, row.sub_classification) };
      }
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
      const validation = await validateParentLink(db, farId, input.parentFarId, req.user!);
      if (!validation.ok) {
        reply.code(validation.status);
        return { error: validation.errors.join(" ") };
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
    await logAssetActivity(db, {
      actorUserId: req.user!.id,
      action: "addition_create",
      farId,
      details: {
        additionsC1: input.additionsC1,
        additionsC2: input.additionsC2,
        dateOfAddition: input.dateOfAddition,
        parentFarId: input.parentFarId ?? null,
        source: "single"
      }
    });
    return { farId, added: true };
  });

  // Disposal preview: exactly what the real disposal would compute (same full-cost
  // write-off `applyFullDisposal` applies, same calc engine), for the *chosen* Disposal
  // Date — without writing anything. Lets the confirmation dialog show real WDV/Profit-
  // Loss figures instead of approximating with today's NBV. AS_AT is pinned to the
  // chosen Disposal Date itself (not whatever the app's global "Figures as of" is set
  // to) so depreciation accrues up to exactly that date, matching what disposing on it
  // for real would produce.
  app.post("/api/assets/:farId/disposal/preview", { preHandler: requirePermission("disposals", "create") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = disposalSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid disposal payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { dateOfDisposal, saleValue } = bodyParsed.data;
    const db = await getPool();

    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1 AND deleted_at IS NULL`, [farId]);
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    const asset = mapAssetRow(row);
    // Rule 1 (2026-08-28): a child asset can't be disposed directly — the only way it
    // disposes is via its parent's own disposal cascading to it (disposeWithChildren).
    if (asset.parentFarId !== null) {
      reply.code(409);
      return { error: `This asset is a child of "${asset.parentFarId}" — dispose the parent instead.` };
    }
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
    if (asset.dateOfAddition !== null && dateOfDisposal < asset.dateOfAddition) {
      reply.code(400);
      return {
        error: `Disposal date cannot be before the asset's addition date (${isoToDDMMYYYY(asset.dateOfAddition)}).`
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
  app.patch("/api/assets/:farId/disposal", { preHandler: requirePermission("disposals", "create") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = disposalSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid disposal payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { dateOfDisposal, saleValue } = bodyParsed.data;
    const db = await getPool();
    // Center-scoped access: fetched separately (rather than relying on the
    // disposeWithChildren write below to fail) since that write's own failure path
    // can't distinguish "out of scope" from "already disposed"/"bad date" — this check
    // must run first, same 404-hides-existence treatment as everywhere else.
    const { rows: scopeCheckRows } = await db.query<{ location: string; revised_location: string | null }>(
      `SELECT location, revised_location FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    if (scopeCheckRows[0] && !isCenterInScope(req.user!, scopeCheckRows[0].revised_location ?? scopeCheckRows[0].location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    // Rule 1 (2026-08-28): a child asset can't be disposed directly — see the identical
    // check on the preview route above for the full comment.
    const [childViolation] = await findDirectChildActionViolations(db, [farId]);
    if (childViolation) {
      reply.code(409);
      return { error: `This asset is a child of "${childViolation.parentFarId}" — dispose the parent instead.` };
    }
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
      const { rows: check } = await db.query<{
        date_of_disposal: string | null;
        date_acquired: string;
        date_of_addition: string | null;
      }>(
        `SELECT date_of_disposal, date_acquired, date_of_addition FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
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
      if (check[0]!.date_of_addition !== null && dateOfDisposal < check[0]!.date_of_addition!) {
        reply.code(400);
        return {
          error: `Disposal date cannot be before the asset's addition date (${isoToDDMMYYYY(check[0]!.date_of_addition!)}).`
        };
      }
      reply.code(400);
      return {
        error: `Disposal date cannot be before the asset's capitalization date (${isoToDDMMYYYY(check[0]!.date_acquired)}).`
      };
    }
    await logAssetActivity(db, {
      actorUserId: req.user!.id,
      action: "disposal_create",
      farId,
      details: { dateOfDisposal, saleValue, childrenDisposed: result.childrenDisposed, source: "single" }
    });
    return { farId, disposed: true, childrenDisposed: result.childrenDisposed };
  });

  // Capitalization delete (Global Admin only) — there is no separate "capitalization
  // record": Capitalization is the assets row itself, so deleting one soft-deletes the
  // whole row (deleted_at/deleted_by/delete_reason), not a hard DELETE. Blocked whenever
  // the asset has ANY downstream activity — a transfer, an addition, a disposal, or being
  // the parent of another asset — so the admin must undo those first, in reverse order,
  // via the addition/disposal/transfer undo endpoints below. Deliberately no
  // force-cascade option: each undo stays its own deliberate, auditable action.
  app.delete("/api/assets/:farId", { preHandler: requirePermission("capitalization", "delete") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = deleteReasonSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "A reason is required to delete this asset.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { reason } = bodyParsed.data;
    const db = await getPool();

    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1 AND deleted_at IS NULL`, [farId]);
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }

    const blockers: string[] = [];
    const { rows: transferCountRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transfers WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    const transferCount = Number(transferCountRows[0]!.count);
    if (transferCount > 0) {
      blockers.push(`it has ${transferCount} transfer(s) on record — delete those first`);
    }
    if (Number(row.additions_c1) !== 0 || Number(row.additions_c2) !== 0 || row.date_of_addition !== null) {
      blockers.push("it has an addition recorded — undo the addition first");
    }
    if (row.date_of_disposal !== null) {
      blockers.push("it has been disposed — undo the disposal first");
    }
    const { rows: childRows } = await db.query<{ far_id: string }>(
      `SELECT far_id FROM assets WHERE parent_far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    if (childRows.length > 0) {
      blockers.push(`it is the parent of ${childRows.map((r) => `"${r.far_id}"`).join(", ")} — unlink or delete ${childRows.length === 1 ? "that child" : "those children"} first`);
    }
    if (blockers.length > 0) {
      reply.code(409);
      return { error: `Can't delete "${farId}" — ${blockers.join("; ")}.` };
    }

    await db.query(`UPDATE assets SET deleted_at = now(), deleted_by = $1, delete_reason = $2 WHERE far_id = $3`, [
      req.user!.id,
      reason,
      farId
    ]);
    await logAssetDelete(db, {
      actorUserId: req.user!.id,
      action: "capitalization_delete",
      farId,
      reason,
      details: {
        subClassification: row.sub_classification,
        assetDescription: row.asset_description,
        dateAcquired: row.date_acquired,
        location: row.location,
        c1OpeningCost: Number(row.c1_opening_cost),
        c2OpeningCost: Number(row.c2_opening_cost)
      }
    });
    return { farId, deleted: true };
  });

  // Addition undo (Global Admin only) — there's no separate "addition record" either
  // (see additionSchema's comment); this clears additions_c1/c2 + date_of_addition back
  // to their column defaults on the existing row. Blocked once the asset has since been
  // disposed: applyFullDisposal computed deletions_c1/c2 as opening_cost + additions_c1/c2
  // at disposal time, so undoing the addition afterward would silently leave that
  // already-realized disposal figure wrong — the admin must undo the disposal first.
  app.post("/api/assets/:farId/addition/undo", { preHandler: requirePermission("additions", "undo") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = deleteReasonSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "A reason is required to undo this addition.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { reason } = bodyParsed.data;
    const db = await getPool();

    const { rows } = await db.query<{
      additions_c1: string | number;
      additions_c2: string | number;
      date_of_addition: string | null;
      date_of_disposal: string | null;
      location: string;
      revised_location: string | null;
    }>(
      `SELECT additions_c1, additions_c2, date_of_addition, date_of_disposal, location, revised_location FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (Number(row.additions_c1) === 0 && Number(row.additions_c2) === 0 && row.date_of_addition === null) {
      reply.code(409);
      return { error: `Asset "${farId}" has no addition recorded to undo.` };
    }
    if (row.date_of_disposal !== null) {
      reply.code(409);
      return { error: `Asset "${farId}" has been disposed — undo the disposal first before undoing its addition.` };
    }

    const details = {
      additionsC1: Number(row.additions_c1),
      additionsC2: Number(row.additions_c2),
      dateOfAddition: row.date_of_addition
    };
    await db.query(`UPDATE assets SET additions_c1 = 0, additions_c2 = 0, date_of_addition = NULL WHERE far_id = $1`, [
      farId
    ]);
    await logAssetDelete(db, { actorUserId: req.user!.id, action: "addition_undo", farId, reason, details });
    return { farId, additionUndone: true };
  });

  // Disposal undo (Global Admin only) — reverses applyFullDisposal via
  // undoDisposalWithChildren (disposalWriteOff.ts), which also automatically un-disposes
  // every child that was disposed specifically by THIS disposal's own cascade. A disposal
  // that was itself a cascade (disposed_via_parent_far_id set) can't be undone directly —
  // same "act on the parent instead" rule Rule 1 already applies to disposing a child
  // directly, mirrored here for undoing one.
  app.post("/api/assets/:farId/disposal/undo", { preHandler: requirePermission("disposals", "undo") }, async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = deleteReasonSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "A reason is required to undo this disposal.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { reason } = bodyParsed.data;
    const db = await getPool();

    const { rows } = await db.query<{
      date_of_disposal: string | null;
      disposed_via_parent_far_id: string | null;
      location: string;
      revised_location: string | null;
    }>(
      `SELECT date_of_disposal, disposed_via_parent_far_id, location, revised_location FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
      [farId]
    );
    const row = rows[0];
    if (!row) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (!isCenterInScope(req.user!, row.revised_location ?? row.location)) {
      reply.code(404);
      return { error: `No asset found with FAR ID "${farId}".` };
    }
    if (row.date_of_disposal === null) {
      reply.code(409);
      return { error: `Asset "${farId}" has not been disposed.` };
    }
    if (row.disposed_via_parent_far_id !== null) {
      reply.code(409);
      return {
        error: `This asset was disposed via its parent's ("${row.disposed_via_parent_far_id}") cascade — undo the parent's disposal instead.`
      };
    }

    const client = await db.connect();
    let result: { parent: DisposalSnapshot; children: DisposalSnapshot[] } | null;
    try {
      await client.query("BEGIN");
      result = await undoDisposalWithChildren(client, farId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (!result) {
      reply.code(409);
      return { error: `Asset "${farId}" has not been disposed.` };
    }

    await logAssetDelete(db, {
      actorUserId: req.user!.id,
      action: "disposal_undo",
      farId,
      reason,
      details: { ...result.parent, cascadedChildren: result.children }
    });
    return { farId, disposalUndone: true, childrenUndone: result.children.map((c) => c.farId) };
  });
}
