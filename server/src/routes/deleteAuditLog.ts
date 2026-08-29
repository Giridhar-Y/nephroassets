import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

const AUDIT_ACTIONS = ["capitalization_delete", "addition_undo", "disposal_undo", "transfer_delete"] as const;

const auditLogQuerySchema = z.object({
  farId: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// Read-only view of every Global-Admin delete/undo action (assets.ts's
// DELETE /api/assets/:farId and .../addition/undo, .../disposal/undo; transfers.ts's
// DELETE /api/transfers/:id) — see asset_delete_audit_log's own schema.sql comment for
// what gets written and why. Admin-only, same as the actions it's a record of.
export default async function deleteAuditLogRoutes(app: FastifyInstance) {
  app.get("/api/audit-log/deletes", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (q.farId) {
      params.push(`%${q.farId}%`);
      conditions.push(`adl.far_id ILIKE $${params.length}`);
    }
    if (q.action) {
      params.push(q.action);
      conditions.push(`adl.action = $${params.length}`);
    }
    // AT TIME ZONE 'Asia/Kolkata' before the ::date cast — a bare `created_at::date`
    // would extract the date in whatever timezone the Postgres SESSION happens to be
    // configured with (not necessarily UTC, and not guaranteed the same across dev vs.
    // production), so the exact same dateFrom/dateTo could match a different set of rows
    // depending on which database this happens to be running against. Explicit IST
    // matches this app's one other timestamp-formatting convention (reports.ts's export
    // "Exported: ... IST" timestamp) and makes the comparison deterministic everywhere.
    if (q.dateFrom) {
      params.push(q.dateFrom);
      conditions.push(`(adl.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`);
    }
    if (q.dateTo) {
      params.push(q.dateTo);
      conditions.push(`(adl.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`);
    }
    // Keyset pagination on id (BIGSERIAL, monotonically increasing with created_at) —
    // same "cursor is the last row's own id" shape as GET /api/transfers.
    if (q.cursor !== undefined) {
      params.push(q.cursor);
      conditions.push(`adl.id < $${params.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(q.limit);

    const { rows } = await db.query<{
      id: string;
      action: string;
      far_id: string;
      transfer_id: string | null;
      reason: string;
      details: Record<string, unknown> | null;
      created_at: string;
      username: string | null;
    }>(
      `SELECT adl.id, adl.action, adl.far_id, adl.transfer_id, adl.reason, adl.details, adl.created_at, u.username
       FROM asset_delete_audit_log adl
       LEFT JOIN users u ON u.id = adl.actor_user_id
       ${whereClause}
       ORDER BY adl.id DESC
       LIMIT $${params.length}`,
      params
    );

    const items = rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      farId: r.far_id,
      transferId: r.transfer_id !== null ? Number(r.transfer_id) : null,
      reason: r.reason,
      details: r.details,
      createdAt: new Date(r.created_at).toISOString(),
      // LEFT JOIN, not an inner join: this app never hard-deletes a user (only disables
      // one), so actor_user_id should always resolve today — but a future admin-cleanup
      // path shouldn't turn every one of that actor's old entries into a 500.
      actorUsername: r.username
    }));
    const last = items[items.length - 1];
    const nextCursor = last && items.length === q.limit ? last.id : null;

    return { items, nextCursor };
  });
}
