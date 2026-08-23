import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { isoToDDMMYYYY, loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { requireEditor } from "../auth/middleware.js";

const createTransferSchema = z.object({
  farIds: z.array(z.string().min(1)).min(1),
  toLocation: z.string().min(1),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

// Comma-separated multi-value filter — see the identical helper in assets.ts.
const multiValue = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").filter(Boolean) : undefined));

const historyQuerySchema = z.object({
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
  location: multiValue,
  transactionDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  transactionDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export default async function transfersRoutes(app: FastifyInstance) {
  // Center-first transfer: move one or more assets (already narrowed to a source
  // center in the UI) to a different center/location.
  app.post("/api/transfers", { preHandler: requireEditor }, async (req, reply) => {
    const parsed = createTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid transfer payload.", details: parsed.error.flatten() };
    }
    const db = await getPool();

    // Same master-list check Bulk Transfers applies (routes/bulkTransfers.ts) — the
    // center-first picker's dropdown already only offers active Centers, but a direct API
    // call could still send anything.
    const maps = await loadActiveMasterMaps(db);
    const toLocation = lookupCanonical(maps.centers, parsed.data.toLocation);
    if (!toLocation) {
      reply.code(400);
      return { error: `Location "${parsed.data.toLocation}" not recognized — see Masters for valid values.` };
    }
    const { farIds, transactionDate } = parsed.data;

    // An asset can't have moved locations before it existed on the books — reject the
    // whole batch (matching the all-or-nothing transaction below) if the transfer date
    // is before any selected asset's capitalization date.
    const { rows: assetRows } = await db.query<{ far_id: string; date_acquired: string }>(
      `SELECT far_id, date_acquired FROM assets WHERE far_id = ANY($1)`,
      [farIds]
    );
    const dateAcquiredByFarId = new Map(assetRows.map((r) => [r.far_id, r.date_acquired]));
    const missing = farIds.filter((id) => !dateAcquiredByFarId.has(id));
    if (missing.length > 0) {
      reply.code(404);
      return { error: `No asset found with FAR ID ${missing.map((id) => `"${id}"`).join(", ")}.` };
    }
    const tooEarly = farIds.filter((id) => transactionDate < dateAcquiredByFarId.get(id)!);
    if (tooEarly.length > 0) {
      reply.code(400);
      return {
        error: `Transfer date cannot be before the asset's capitalization date — ${tooEarly
          .map((id) => `${id} was capitalized on ${isoToDDMMYYYY(dateAcquiredByFarId.get(id)!)}`)
          .join("; ")}.`
      };
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const farId of farIds) {
        await client.query(
          `INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`,
          [farId, transactionDate, toLocation]
        );
        // Keep the denormalized "current" location in sync so center filtering stays a
        // plain indexed column lookup at scale. This reflects the *current* effective
        // location; point-in-time correctness for a past AS_AT is handled separately by
        // the calculation engine's Effective Location step when rendering each row.
        await client.query(
          `UPDATE assets SET revised_location = $1, last_date_of_transaction = $2 WHERE far_id = $3`,
          [toLocation, transactionDate, farId]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { transferred: farIds.length, toLocation, transactionDate };
  });

  // Transfers screen: a read-only history log, newest first. Not a separate workflow —
  // initiating a transfer still only happens via the center-first picker in Register.
  app.get("/api/transfers", { preHandler: requireEditor }, async (req, reply) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const { search, descriptionSearch, location, transactionDateFrom, transactionDateTo, cursor, limit } =
      parsed.data;
    const db = await getPool();

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      params.push(`${search.toUpperCase()}%`);
      conditions.push(`t.far_id LIKE $${params.length}`);
    }
    if (descriptionSearch) {
      params.push(`%${descriptionSearch}%`);
      conditions.push(`a.asset_description ILIKE $${params.length}`);
    }
    if (location) {
      params.push(location);
      conditions.push(`t.location = ANY($${params.length})`);
    }
    if (transactionDateFrom) {
      params.push(transactionDateFrom);
      conditions.push(`t.transaction_date >= $${params.length}`);
    }
    if (transactionDateTo) {
      params.push(transactionDateTo);
      conditions.push(`t.transaction_date <= $${params.length}`);
    }
    if (cursor !== undefined) {
      params.push(cursor);
      conditions.push(`t.id < $${params.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const { rows } = await db.query<{
      id: string | number;
      far_id: string;
      asset_description: string;
      transaction_date: string;
      location: string;
    }>(
      `SELECT t.id, t.far_id, a.asset_description, t.transaction_date, t.location
       FROM transfers t
       JOIN assets a ON a.far_id = t.far_id
       ${whereClause}
       ORDER BY t.id DESC
       LIMIT $${params.length}`,
      params
    );

    const items = rows.map((r) => ({
      id: Number(r.id),
      farId: r.far_id,
      assetDescription: r.asset_description,
      transactionDate: r.transaction_date,
      location: r.location
    }));
    const last = items[items.length - 1];
    const nextCursor = last && items.length === limit ? last.id : null;

    return { items, nextCursor };
  });
}
