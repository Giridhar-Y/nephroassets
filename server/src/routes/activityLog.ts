import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";

const CATEGORIES = ["capitalization", "addition", "transfer", "disposal", "delete", "masters"] as const;
type Category = (typeof CATEGORIES)[number];

// Which single asset_activity_log action each of the four "create" categories maps to
// (1:1, unlike "delete"/"masters" below, which each cover several distinct actions).
const CREATE_ACTION_BY_CATEGORY: Record<"capitalization" | "addition" | "transfer" | "disposal", string> = {
  capitalization: "capitalization_create",
  addition: "addition_create",
  transfer: "transfer_create",
  disposal: "disposal_create"
};
const CATEGORY_BY_CREATE_ACTION: Record<string, Category> = Object.fromEntries(
  Object.entries(CREATE_ACTION_BY_CATEGORY).map(([category, action]) => [action, category as Category])
);

// Delete/undo actions (asset_delete_audit_log) don't have their own Category the way
// Capitalization/Addition/Transfer/Disposal do — they're all grouped under one "Delete"
// category, same as the user's own request to consolidate Delete Log into this page.
// Masters actions (master_activity_log) are similarly grouped under one "Masters"
// category, covering all three lists (Centers/Sub Classifications/Statuses) at once.
// Both maps below are merged into the row's `details` as a human `type` label, since the
// Category column alone can't distinguish e.g. an Addition Undo from a Disposal Undo.
const DELETE_ACTION_LABELS: Record<string, string> = {
  capitalization_delete: "Capitalization Delete",
  addition_undo: "Addition Undo",
  disposal_undo: "Disposal Undo",
  transfer_delete: "Transfer Delete"
};
const MASTERS_ACTION_LABELS: Record<string, string> = {
  center_create: "Center Created",
  center_update: "Center Updated",
  sub_classification_create: "Sub Classification Created",
  sub_classification_update: "Sub Classification Updated",
  status_create: "Status Created",
  status_update: "Status Updated"
};

const activityLogQuerySchema = z.object({
  farId: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.enum(CATEGORIES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

interface Cursor {
  createdAt: string;
  src: string;
  id: number;
}

// Opaque to the client — round-tripped verbatim as `nextCursor`/`cursor`. Needed (rather
// than the plain `id < cursor` every other keyset-paginated endpoint in this app uses)
// because this feed merges three tables with independent BIGSERIAL sequences: a bare id
// comparison can't order rows from different tables correctly, so the sort/cursor key is
// the (created_at, src, id) triple instead — src as a deterministic tie-breaker for the
// rare case two sources share an identical created_at (same-transaction inserts, e.g. a
// cascaded transfer's parent+child rows, already share one now() value today).
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.src === "string" &&
      typeof parsed.id === "number"
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Read-only view of every Capitalization/Addition/Transfer/Disposal CREATE event
// (asset_activity_log), every Global-Admin delete/undo action (asset_delete_audit_log),
// and every Masters create/rename/deactivate/reactivate (master_activity_log) — one
// consolidated feed instead of separate pages, per the user's own request. Editor+
// visibility throughout: this used to mean an editor couldn't see Delete Log (admin-only,
// matching that deletion itself is admin-only) — merging it in here does widen who can
// see a delete/undo record, a deliberate, requested consequence of consolidating onto one
// editor+ page rather than an oversight.
export default async function activityLogRoutes(app: FastifyInstance) {
  app.get("/api/audit-log/activity", { preHandler: requirePermission("activityLog", "view") }, async (req, reply) => {
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
      conditions.push(`c.far_id ILIKE $${params.length}`);
    }
    if (q.category) {
      if (q.category === "delete" || q.category === "masters") {
        params.push(q.category === "delete" ? "delete" : "masters");
        conditions.push(`c.src = $${params.length}`);
      } else {
        params.push("activity");
        conditions.push(`c.src = $${params.length}`);
        params.push(CREATE_ACTION_BY_CATEGORY[q.category]);
        conditions.push(`c.action = $${params.length}`);
      }
    }
    // AT TIME ZONE 'Asia/Kolkata' before the ::date cast — same reasoning as before: a
    // bare `created_at::date` depends on the Postgres session's implicit timezone,
    // non-deterministic across environments.
    if (q.dateFrom) {
      params.push(q.dateFrom);
      conditions.push(`(c.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`);
    }
    if (q.dateTo) {
      params.push(q.dateTo);
      conditions.push(`(c.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`);
    }
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      if (!cursor) {
        reply.code(400);
        return { error: "Invalid cursor." };
      }
      params.push(cursor.createdAt, cursor.src, cursor.id);
      conditions.push(`(c.created_at, c.src, c.id) < ($${params.length - 2}::timestamptz, $${params.length - 1}, $${params.length})`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(q.limit);

    const { rows } = await db.query<{
      id: string;
      src: "activity" | "delete" | "masters";
      action: string;
      far_id: string | null;
      reason: string | null;
      details: Record<string, unknown> | null;
      created_at: string;
      username: string | null;
    }>(
      `WITH combined AS (
         SELECT id, action, far_id, details, NULL::text AS reason, created_at, actor_user_id, 'activity'::text AS src
         FROM asset_activity_log
         UNION ALL
         SELECT id, action, far_id, details, reason, created_at, actor_user_id, 'delete'::text AS src
         FROM asset_delete_audit_log
         UNION ALL
         SELECT id, action, NULL::text AS far_id, details, NULL::text AS reason, created_at, actor_user_id, 'masters'::text AS src
         FROM master_activity_log
       )
       SELECT c.id, c.src, c.action, c.far_id, c.reason, c.details, c.created_at, u.username
       FROM combined c
       LEFT JOIN users u ON u.id = c.actor_user_id
       ${whereClause}
       ORDER BY c.created_at DESC, c.src DESC, c.id DESC
       LIMIT $${params.length}`,
      params
    );

    const items = rows.map((r) => {
      let category: Category;
      let details = r.details;
      if (r.src === "delete") {
        category = "delete";
        details = { type: DELETE_ACTION_LABELS[r.action] ?? r.action, reason: r.reason, ...r.details };
      } else if (r.src === "masters") {
        category = "masters";
        details = { type: MASTERS_ACTION_LABELS[r.action] ?? r.action, ...r.details };
      } else {
        category = CATEGORY_BY_CREATE_ACTION[r.action] ?? "capitalization";
      }
      return {
        id: Number(r.id),
        source: r.src,
        action: r.action,
        category,
        farId: r.far_id,
        details,
        createdAt: new Date(r.created_at).toISOString(),
        actorUsername: r.username
      };
    });
    const last = rows[rows.length - 1];
    const nextCursor =
      last && items.length === q.limit ? encodeCursor({ createdAt: last.created_at, src: last.src, id: Number(last.id) }) : null;

    return { items, nextCursor };
  });
}
