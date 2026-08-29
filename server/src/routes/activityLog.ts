import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireEditor } from "../auth/middleware.js";

const ACTIVITY_ACTIONS = ["capitalization_create", "addition_create", "transfer_create", "disposal_create"] as const;

const activityLogQuerySchema = z.object({
  farId: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  action: z.enum(ACTIVITY_ACTIONS).optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// Read-only view of every Capitalization/Addition/Transfer/Disposal CREATE event
// (single-item and Bulk Upload/Bulk Transfer/Bulk Dispose alike) — see
// asset_activity_log's own schema.sql comment for what gets written and why. Editor+
// visibility, same as the actions themselves (all requireEditor, not requireAdmin) —
// unlike asset_delete_audit_log/deleteAuditLog.ts, which is admin-only because deletion
// itself is admin-only.
export default async function activityLogRoutes(app: FastifyInstance) {
  app.get("/api/audit-log/activity", { preHandler: requireEditor }, async (req, reply) => {
    const parsed = activityLogQuerySchema.safeParse(req.query);
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
      conditions.push(`al.far_id ILIKE $${params.length}`);
    }
    if (q.action) {
      params.push(q.action);
      conditions.push(`al.action = $${params.length}`);
    }
    // AT TIME ZONE 'Asia/Kolkata' before the ::date cast — same reasoning as
    // deleteAuditLog.ts's identical filter: a bare `created_at::date` depends on the
    // Postgres session's implicit timezone, non-deterministic across environments.
    if (q.dateFrom) {
      params.push(q.dateFrom);
      conditions.push(`(al.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`);
    }
    if (q.dateTo) {
      params.push(q.dateTo);
      conditions.push(`(al.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`);
    }
    if (q.cursor !== undefined) {
      params.push(q.cursor);
      conditions.push(`al.id < $${params.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(q.limit);

    const { rows } = await db.query<{
      id: string;
      action: string;
      far_id: string;
      details: Record<string, unknown> | null;
      created_at: string;
      username: string | null;
    }>(
      `SELECT al.id, al.action, al.far_id, al.details, al.created_at, u.username
       FROM asset_activity_log al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${whereClause}
       ORDER BY al.id DESC
       LIMIT $${params.length}`,
      params
    );

    const items = rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      farId: r.far_id,
      details: r.details,
      createdAt: new Date(r.created_at).toISOString(),
      actorUsername: r.username
    }));
    const last = items[items.length - 1];
    const nextCursor = last && items.length === q.limit ? last.id : null;

    return { items, nextCursor };
  });
}
