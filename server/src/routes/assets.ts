import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import { ASSET_INSERT_COLUMNS, assetCreateSchema, assetCreateValues } from "./assetSchema.js";

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

const querySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  center: z.string().optional(),
  subClassification: z.string().optional(),
  status: z.string().optional(),
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
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
      conditions.push(`COALESCE(revised_location, location) = $${params.length}`);
    }
    if (q.subClassification) {
      params.push(q.subClassification);
      conditions.push(`sub_classification = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`status = $${params.length}`);
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

  // Capitalization: register a brand-new asset. Disposal fields are left at their
  // column defaults (null / 0) — an asset is never created pre-disposed.
  app.post("/api/assets", async (req, reply) => {
    const parsed = assetCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid asset payload.", details: parsed.error.flatten() };
    }
    const input = parsed.data;
    const db = await getPool();
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
    const { rows } = await db.query(
      `UPDATE assets
       SET date_of_disposal = $1,
           deletions_c1 = c1_opening_cost + additions_c1,
           deletions_c2 = c2_opening_cost + additions_c2,
           sale_value = $2
       WHERE far_id = $3 AND date_of_disposal IS NULL
       RETURNING far_id`,
      [dateOfDisposal, saleValue, farId]
    );
    if (rows.length === 0) {
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
