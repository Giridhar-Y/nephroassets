import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { isoToDDMMYYYY, loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { findDirectChildActionViolations } from "./parentLink.js";
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
    const { transactionDate } = parsed.data;

    // Rule 1 (2026-08-28): a child asset can't be transferred directly on its own — but
    // explicitly selecting a child ALONGSIDE its own parent in this same request is not
    // "directly," it's equivalent to letting the cascade below handle it (and is already
    // treated that way: see this route's own cascadedFrom comment). Only reject a child
    // whose parent isn't also part of this same explicit selection.
    const directChildViolations = await findDirectChildActionViolations(db, parsed.data.farIds, parsed.data.farIds);
    if (directChildViolations.length > 0) {
      reply.code(409);
      return {
        error: directChildViolations
          .map((v) => `"${v.farId}" is a child of "${v.parentFarId}" — transfer the parent instead.`)
          .join(" ")
      };
    }

    // Every still-active child of a selected asset moves with it automatically — a
    // parent/child pair (e.g. a machine and an accessory that must always be together)
    // stays together without Finance having to remember to select both. A child that's
    // already independently disposed is left alone. Deduped in case a child was also
    // separately selected in the same batch.
    const { rows: childRows } = await db.query<{ far_id: string; parent_far_id: string }>(
      `SELECT far_id, parent_far_id FROM assets WHERE parent_far_id = ANY($1) AND date_of_disposal IS NULL`,
      [parsed.data.farIds]
    );
    const childParentMap = new Map(childRows.map((r) => [r.far_id, r.parent_far_id]));
    const farIds = Array.from(new Set([...parsed.data.farIds, ...childRows.map((r) => r.far_id)]));

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
        // Mechanical, not intent-based: this row is "cascaded from parent X" whenever
        // its own parent_far_id is also moving in this same batch, whether the child's
        // FAR ID reached this batch via the cascade-detection query above or was also
        // literally present in the client's request (e.g. Register's checkbox
        // auto-select already includes active children in what it sends) — either way
        // the child moved because its parent did, on the same request.
        const cascadedFrom = childParentMap.get(farId) ?? null;
        await client.query(
          `INSERT INTO transfers (far_id, transaction_date, location, cascaded_from_parent_far_id) VALUES ($1, $2, $3, $4)`,
          [farId, transactionDate, toLocation, cascadedFrom]
        );
        // Keep the denormalized "current" location in sync so center filtering stays a
        // plain indexed column lookup at scale. This reflects the *current* effective
        // location; point-in-time correctness for a past AS_AT is handled separately by
        // the calculation engine's Effective Location step when rendering each row.
        // Guarded so a backdated/out-of-order transfer (entered after a later-dated one
        // already on file) still gets recorded in transfer history but doesn't regress
        // this cache — otherwise Center filtering/Location Summary/Export/Masters usage
        // count (which all trust this column directly, not a recomputed one) would show
        // the asset at a location it's already moved on from.
        await client.query(
          `UPDATE assets SET revised_location = $1, last_date_of_transaction = $2
           WHERE far_id = $3 AND (last_date_of_transaction IS NULL OR last_date_of_transaction <= $2)`,
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
    const childrenIncluded = childRows.map((r) => r.far_id).filter((id) => !parsed.data.farIds.includes(id));
    return { transferred: farIds.length, toLocation, transactionDate, childrenIncluded };
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
      from_location: string;
    }>(
      // from_location is a correlated subquery (not a window function) deliberately —
      // it must find the true immediately-prior transfer for this far_id regardless of
      // whatever filters are narrowing the outer result set (e.g. filtering to "Moved To:
      // Center-B" would make a window function's LAG skip right over an excluded
      // in-between transfer and report the wrong prior location). Falls back to the
      // asset's own capitalized location when there is no prior transfer.
      `SELECT t.id, t.far_id, a.asset_description, t.transaction_date, t.location,
         COALESCE(
           (SELECT t2.location FROM transfers t2
            WHERE t2.far_id = t.far_id AND (t2.transaction_date, t2.id) < (t.transaction_date, t.id)
            ORDER BY t2.transaction_date DESC, t2.id DESC LIMIT 1),
           a.location
         ) AS from_location
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
      fromLocation: r.from_location,
      location: r.location
    }));
    const last = items[items.length - 1];
    const nextCursor = last && items.length === limit ? last.id : null;

    return { items, nextCursor };
  });
}
