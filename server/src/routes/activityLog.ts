import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { centerScopeSql } from "../auth/centerScope.js";
import type { AuthedUser } from "../auth/middleware.js";

const CATEGORIES = ["capitalization", "addition", "transfer", "disposal", "delete", "masters"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  capitalization: "Capitalization",
  addition: "Addition",
  transfer: "Transfer",
  disposal: "Disposal",
  delete: "Delete",
  masters: "Masters"
};

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

// No cursor/limit — the export always covers every matching row, not one page.
const activityLogExportQuerySchema = z.object({
  farId: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.enum(CATEGORIES).optional()
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

// The three-table UNION every read of this feed is built on — shared verbatim by both
// the list endpoint and the export below, so they can never quietly drift into showing
// different rows for "the same" filters.
const COMBINED_SELECT_SQL = `
  WITH combined AS (
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
  LEFT JOIN assets a ON a.far_id = c.far_id
`;

interface FilterQuery {
  farId?: string;
  category?: Category;
  dateFrom?: string;
  dateTo?: string;
}

/** The named filters (farId/category/dateFrom/dateTo) plus center scope, shared by the
 *  list endpoint and the export below — one definition so "what this export contains"
 *  can never disagree with "what the screen is showing" for the same filter values.
 *  Returns `params` still open for a caller to push a cursor/limit onto afterward. */
function buildActivityLogConditions(q: FilterQuery, user: Pick<AuthedUser, "centerScope">): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  // Center-scoped access: the Capitalization/Addition/Transfer/Disposal/Delete
  // categories are all far_id-linked (asset_activity_log/asset_delete_audit_log) —
  // scoped by that ASSET's current location (via the LEFT JOIN above), same
  // current-state principle as every other scoped listing. The Masters category has no
  // far_id at all (c.far_id IS NULL) — no asset dimension, so it's always let through,
  // unaffected by center scope.
  const scopeSql = centerScopeSql(user, "COALESCE(a.revised_location, a.location)", params);
  if (scopeSql) conditions.push(`(c.far_id IS NULL OR ${scopeSql})`);
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
  // AT TIME ZONE 'Asia/Kolkata' before the ::date cast — a bare `created_at::date`
  // depends on the Postgres session's implicit timezone, non-deterministic across
  // environments.
  if (q.dateFrom) {
    params.push(q.dateFrom);
    conditions.push(`(c.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`);
  }
  if (q.dateTo) {
    params.push(q.dateTo);
    conditions.push(`(c.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`);
  }
  return { conditions, params };
}

interface RawRow {
  id: string;
  src: "activity" | "delete" | "masters";
  action: string;
  far_id: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  username: string | null;
}

interface ShapedItem {
  id: number;
  source: "activity" | "delete" | "masters";
  action: string;
  category: Category;
  farId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  actorUsername: string | null;
}

/** One raw UNION row -> the shape both the list JSON and the export share: category
 *  resolved, and `details.type`/`details.reason` merged in for delete/masters rows —
 *  shared so the export's "Type/Action" and "Reason" columns read exactly what the list
 *  view's own expanded-details panel would show for the same row. */
function shapeRow(r: RawRow): ShapedItem {
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
}

// Parallel definitions of the client's own humanizeKey/formatDetailValue
// (ActivityLogPage.tsx) — no shared package boundary between client and server in this
// app, same convention as assetsExport.ts's GROUP_INFO. Used only to render the export's
// "Changed"/"Other Details" columns in the same plain-English style the on-screen expanded
// row already uses.
function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function humanizeAction(action: string): string {
  return action.split("_").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "Code: OLD -> NEW; Description: old -> new" from a Masters update's
 *  `details.previous` diff (routes/masters.ts's diffPrevious) — empty for every other
 *  category, which has no prior state to diff. */
function buildChangedText(details: Record<string, unknown> | null): string {
  if (!details || !isPlainObject(details.previous)) return "";
  return Object.entries(details.previous)
    .map(([key, oldValue]) => `${humanizeKey(key)}: ${formatDetailValue(oldValue)} → ${formatDetailValue(details[key])}`)
    .join("; ");
}

/** Everything in `details` besides what already has its own column (type/reason) or is
 *  already fully represented in the Changed column (previous itself, and every field
 *  Changed already shows old -> new for — otherwise a Masters update's changed field
 *  would appear twice, once in each column). */
function buildOtherDetailsText(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const changedKeys = isPlainObject(details.previous) ? new Set(Object.keys(details.previous)) : null;
  return Object.entries(details)
    .filter(([key]) => key !== "previous" && key !== "type" && key !== "reason" && !changedKeys?.has(key))
    .map(([key, value]) => `${humanizeKey(key)}: ${formatDetailValue(value)}`)
    .join("; ");
}

// DD-MM-YYYY HH:MM IST — matches assetsExport.ts's exportedAtText convention (Intl parts
// rather than a locale default separator, pinned to IST regardless of server timezone).
function formatIstTimestamp(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata"
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}-${part("month")}-${part("year")} ${part("hour")}:${part("minute")}`;
}

const EXPORT_BATCH_SIZE = 2000;

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

    const { conditions, params } = buildActivityLogConditions(q, req.user!);
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

    const { rows } = await db.query<RawRow>(
      `${COMBINED_SELECT_SQL}
       ${whereClause}
       ORDER BY c.created_at DESC, c.src DESC, c.id DESC
       LIMIT $${params.length}`,
      params
    );

    const items = rows.map(shapeRow);
    const last = rows[rows.length - 1];
    const nextCursor =
      last && items.length === q.limit ? encodeCursor({ createdAt: last.created_at, src: last.src, id: Number(last.id) }) : null;

    return { items, nextCursor };
  });

  // Full export — every row matching the same filters the screen accepts, not one page.
  // Streamed (PassThrough + ExcelJS.stream.xlsx.WorkbookWriter, batched keyset pagination
  // on (created_at, src, id) ascending), same pattern as assetsExport.ts: this is an
  // append-only, ever-growing event log with no natural row cap the way e.g. Audit
  // Reconciliation's bounded per-sub-classification summary has, so it's built to stay
  // correct at any size rather than assumed small.
  app.get("/api/audit-log/activity/export", { preHandler: requirePermission("activityLog", "export") }, async (req, reply) => {
    const parsed = activityLogExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();
    const { conditions, params } = buildActivityLogConditions(q, req.user!);

    const exportDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="activity-log-${exportDate}.xlsx"`);

    const stream = new PassThrough();
    reply.send(stream);

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
      const worksheet = workbook.addWorksheet("Activity Log");
      worksheet.columns = [
        { header: "Timestamp (IST)", width: 18 },
        { header: "Category", width: 14 },
        { header: "Type / Action", width: 24 },
        { header: "FAR ID", width: 16 },
        { header: "Actor", width: 18 },
        { header: "Reason", width: 28 },
        { header: "Changed", width: 50 },
        { header: "Other Details", width: 50 }
      ];
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.commit();

      let cursor: Cursor | null = null;
      for (;;) {
        const batchConditions = [...conditions];
        const batchParams = [...params];
        if (cursor) {
          batchParams.push(cursor.createdAt, cursor.src, cursor.id);
          batchConditions.push(
            `(c.created_at, c.src, c.id) > ($${batchParams.length - 2}::timestamptz, $${batchParams.length - 1}, $${batchParams.length})`
          );
        }
        const batchWhereClause = batchConditions.length > 0 ? `WHERE ${batchConditions.join(" AND ")}` : "";
        batchParams.push(EXPORT_BATCH_SIZE);

        const { rows } = await db.query<RawRow>(
          `${COMBINED_SELECT_SQL}
           ${batchWhereClause}
           ORDER BY c.created_at ASC, c.src ASC, c.id ASC
           LIMIT $${batchParams.length}`,
          batchParams
        );
        if (rows.length === 0) break;

        for (const r of rows) {
          const item = shapeRow(r);
          worksheet
            .addRow([
              formatIstTimestamp(item.createdAt),
              CATEGORY_LABELS[item.category],
              (item.details?.type as string | undefined) ?? humanizeAction(item.action),
              item.farId ?? "",
              item.actorUsername ?? "Unknown user",
              (item.details?.reason as string | undefined) ?? "",
              buildChangedText(item.details),
              buildOtherDetailsText(item.details)
            ])
            .commit();
        }

        const last = rows[rows.length - 1]!;
        cursor = { createdAt: last.created_at, src: last.src, id: Number(last.id) };
        if (rows.length < EXPORT_BATCH_SIZE) break;
      }

      worksheet.commit();
      await workbook.commit();
    } catch (err) {
      app.log.error(err, "Activity log export failed mid-stream");
      stream.destroy(err instanceof Error ? err : new Error("Export failed"));
    }
  });
}
