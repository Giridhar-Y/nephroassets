import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import { ASSET_INSERT_COLUMNS, assetCreateSchema, assetCreateValues } from "./assetSchema.js";
import { loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { applyFullDisposal } from "./disposalWriteOff.js";

const disposalSchema = z.object({
  dateOfDisposal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  saleValue: z.coerce.number().min(0)
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
  subClassification: multiValue,
  status: multiValue,
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
    if (q.subClassification) {
      params.push(q.subClassification);
      conditions.push(`sub_classification = ANY($${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`status = ANY($${params.length})`);
    }
    if (q.dateAcquiredFrom) {
      params.push(q.dateAcquiredFrom);
      conditions.push(`date_acquired >= $${params.length}`);
    }
    if (q.dateAcquiredTo) {
      params.push(q.dateAcquiredTo);
      conditions.push(`date_acquired <= $${params.length}`);
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
      SELECT * FROM assets
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

    const { rows: transferRows } = await db.query<TransferRow & { id: string | number }>(
      `SELECT id, far_id, transaction_date, location FROM transfers WHERE far_id = $1 ORDER BY transaction_date ASC, id ASC`,
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
      location: t.location
    }));

    return { asset, result, transfers, asAt };
  });

  // Capitalization: register a brand-new asset. Disposal fields are left at their
  // column defaults (null / 0) — an asset is never created pre-disposed.
  app.post("/api/assets", async (req, reply) => {
    const parsed = assetCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid asset payload.", details: parsed.error.flatten() };
    }
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
    await db.query(
      `INSERT INTO assets (${ASSET_INSERT_COLUMNS.join(", ")})
       VALUES (${ASSET_INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      assetCreateValues(input)
    );
    return { farId: input.farId, created: true };
  });

  // Disposal preview: exactly what the real disposal would compute (same full-cost
  // write-off `applyFullDisposal` applies, same calc engine), for the *chosen* Disposal
  // Date — without writing anything. Lets the confirmation dialog show real WDV/Profit-
  // Loss figures instead of approximating with today's NBV. AS_AT is pinned to the
  // chosen Disposal Date itself (not whatever the app's global "Figures as of" is set
  // to) so depreciation accrues up to exactly that date, matching what disposing on it
  // for real would produce.
  app.post("/api/assets/:farId/disposal/preview", async (req, reply) => {
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
  // cost (opening + additions) rather than a user-entered partial amount.
  app.patch("/api/assets/:farId/disposal", async (req, reply) => {
    const paramsParsed = z.object({ farId: z.string().min(1) }).safeParse(req.params);
    const bodyParsed = disposalSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid disposal payload.", details: bodyParsed.error?.flatten() };
    }
    const { farId } = paramsParsed.data;
    const { dateOfDisposal, saleValue } = bodyParsed.data;
    const db = await getPool();
    const written = await applyFullDisposal(db, farId, dateOfDisposal, saleValue);
    if (!written) {
      const { rows: check } = await db.query(`SELECT date_of_disposal FROM assets WHERE far_id = $1`, [farId]);
      if (check.length === 0) {
        reply.code(404);
        return { error: `No asset found with FAR ID "${farId}".` };
      }
      reply.code(409);
      return { error: `Asset "${farId}" has already been disposed.` };
    }
    return { farId, disposed: true };
  });
}
