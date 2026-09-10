import type { FastifyInstance } from "fastify";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { centerScopeSql } from "../auth/centerScope.js";
import type { AuthedUser } from "../auth/middleware.js";
import { isoToDDMMYYYY } from "./bulkParse.js";

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
  actor: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.enum(CATEGORIES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// No cursor/limit — the export always covers every matching row, not one page.
const activityLogExportQuerySchema = z.object({
  farId: z.string().optional(),
  actor: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.enum(CATEGORIES).optional()
});

// Same shape as the two above minus cursor/limit — the summary's counts must reflect
// exactly the same filters the list/export use, just without `category` itself (see
// buildActivityLogConditions's caller below for why).
const activityLogSummaryQuerySchema = z.object({
  farId: z.string().optional(),
  actor: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
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

// The three-table UNION every read of this feed is built on — shared verbatim by the
// list endpoint, the export, and the summary counts below, so all three can never
// quietly drift into disagreeing about "the same" filters. A CTE must precede the SELECT
// that uses it, so this is split into the WITH clause and the FROM/JOIN clause with each
// caller's own SELECT list sandwiched between them (row detail vs. a grouped count).
const COMBINED_WITH_SQL = `
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
`;
const COMBINED_JOIN_SQL = `
  FROM combined c
  LEFT JOIN users u ON u.id = c.actor_user_id
  LEFT JOIN assets a ON a.far_id = c.far_id
`;
const COMBINED_SELECT_SQL = `${COMBINED_WITH_SQL} SELECT c.id, c.src, c.action, c.far_id, c.reason, c.details, c.created_at, u.username ${COMBINED_JOIN_SQL}`;

interface FilterQuery {
  farId?: string;
  actor?: string;
  category?: Category;
  dateFrom?: string;
  dateTo?: string;
}

/** The named filters (farId/actor/category/dateFrom/dateTo) plus center scope, shared by
 *  the list endpoint and the export below — one definition so "what this export
 *  contains" can never disagree with "what the screen is showing" for the same filter
 *  values. Returns `params` still open for a caller to push a cursor/limit onto
 *  afterward. */
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
  // Same free-text "contains, case-insensitive" convention as the FAR ID filter above —
  // not a dropdown of known users, so it stays useful even for an actor account that's
  // since been disabled or renamed.
  if (q.actor) {
    params.push(`%${q.actor}%`);
    conditions.push(`u.username ILIKE $${params.length}`);
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

interface ChangedField {
  label: string;
  oldValue: string;
  newValue: string;
}

/** One entry per field in a `details.previous` diff (routes/masters.ts's diffPrevious,
 *  and now the same shape from assets.ts's Addition/Disposal and transfers.ts's
 *  Transfer routes — see their own comments) — empty for a category with no prior state
 *  to diff (a create). Structured rather than joined into one string so the export can
 *  put Old Value / New Value in their own filterable/pivotable columns instead of a
 *  semicolon-joined blob. */
function buildChangedFields(details: Record<string, unknown> | null): ChangedField[] {
  if (!details || !isPlainObject(details.previous)) return [];
  return Object.entries(details.previous).map(([key, oldValue]) => ({
    label: humanizeKey(key),
    oldValue: formatDetailValue(oldValue),
    newValue: formatDetailValue(details[key])
  }));
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

// No existing "which FY does date X fall in" helper anywhere in the codebase to reuse —
// Settings (settings.fy_start/fy_end) only ever describes the ONE currently-configured
// FY window, not a recurring calendar rule, and the calc engine (engine.ts) only ever
// needs that single window too. This derives the recurring rule (an FY starts on
// fy_start's month/day every year) from Settings rather than hardcoding "April 1", so an
// org configured differently still gets correct labels — but the generalization itself
// (labeling an arbitrary historical date, across any number of past FYs) is new for this
// export, not lifted from existing logic.
export function resolveFinancialYear(iso: string, fyStartMonth: number, fyStartDay: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const isOnOrAfterFyStart = month > fyStartMonth || (month === fyStartMonth && day >= fyStartDay);
  const startYear = isOnOrAfterFyStart ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Sane default (India's standard financial year) used only if Settings hasn't been
// configured yet — Masters activity can happen before FY setup, so the export shouldn't
// hard-fail just because of that; every other category realistically implies FY setup
// already happened (Capitalization/Addition/Transfer/Disposal all require it elsewhere).
const DEFAULT_FY_START_MONTH = 4;
const DEFAULT_FY_START_DAY = 1;

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

  // Counts per category for the summary strip above the table — deliberately computed
  // WITHOUT the category filter itself (activityLogSummaryQuerySchema has no `category`
  // field at all) so all six counts stay meaningful even while one category is selected,
  // letting the strip double as a set of category quick-filters. One grouped query
  // (by src/action, the two raw columns category is actually derived from) rather than
  // six separate COUNT(*) calls — same category resolution as shapeRow, just applied to
  // grouped rows instead of one row at a time so it can't quietly drift from what the
  // list/export actually show.
  app.get("/api/audit-log/activity/summary", { preHandler: requirePermission("activityLog", "view") }, async (req, reply) => {
    const parsed = activityLogSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const { conditions, params } = buildActivityLogConditions(parsed.data, req.user!);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await db.query<{ src: "activity" | "delete" | "masters"; action: string; count: string }>(
      `${COMBINED_WITH_SQL}
       SELECT c.src, c.action, COUNT(*) AS count
       ${COMBINED_JOIN_SQL}
       ${whereClause}
       GROUP BY c.src, c.action`,
      params
    );

    const counts: Record<Category, number> = {
      capitalization: 0,
      addition: 0,
      transfer: 0,
      disposal: 0,
      delete: 0,
      masters: 0
    };
    for (const row of rows) {
      const category: Category =
        row.src === "delete" ? "delete" : row.src === "masters" ? "masters" : (CATEGORY_BY_CREATE_ACTION[row.action] ?? "capitalization");
      counts[category] += Number(row.count);
    }
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });

  // Full export — every row matching the same filters the screen accepts, not one page.
  // The DB fetch still batches with keyset pagination on (created_at, src, id) ascending
  // (EXPORT_BATCH_SIZE per round trip) so a large export doesn't hold one giant result
  // set in memory at once — only the final .xlsx itself is built in memory (see the
  // in-memory-vs-streaming comment further down for why).
  app.get("/api/audit-log/activity/export", { preHandler: requirePermission("activityLog", "export") }, async (req, reply) => {
    const parsed = activityLogExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();
    const { conditions, params } = buildActivityLogConditions(q, req.user!);

    const { rows: settingsRows } = await db.query<{ fy_start: string }>(`SELECT fy_start FROM settings WHERE id = TRUE`);
    const fyStartParts = settingsRows[0]?.fy_start.split("-").map(Number);
    const fyStartMonth = fyStartParts?.[1] ?? DEFAULT_FY_START_MONTH;
    const fyStartDay = fyStartParts?.[2] ?? DEFAULT_FY_START_DAY;

    const filterParts: string[] = [];
    if (q.farId) filterParts.push(`FAR ID contains "${q.farId}"`);
    if (q.actor) filterParts.push(`Actor contains "${q.actor}"`);
    if (q.category) filterParts.push(`Category: ${CATEGORY_LABELS[q.category]}`);
    if (q.dateFrom || q.dateTo) {
      filterParts.push(`Date: ${q.dateFrom ? isoToDDMMYYYY(q.dateFrom) : "the beginning"} to ${q.dateTo ? isoToDDMMYYYY(q.dateTo) : "today"}`);
    }
    const filterSummaryText = filterParts.length > 0 ? `Filters: ${filterParts.join("  |  ")}` : "Filters: None — showing all activity";

    const exportDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

    // In-memory ExcelJS.Workbook, not the streaming WorkbookWriter+PassThrough this
    // route used at first (matching reports.ts's Transfer & Depreciation Schedule
    // pattern) — switched after live verification of this exact export against a real,
    // freshly-started server found it producing a genuinely corrupted .xlsx (a bad
    // zip-entry CRC, then a bad deflate stream on a separate attempt — always on the
    // FIRST export request after a cold start, never once on a warm one, and never
    // reproducible in an isolated script that builds the identical workbook shape
    // without a real PassThrough+Fastify response in the loop). Root cause not fully
    // pinned down, but the fragile combination (streaming zip writer piped through a
    // real HTTP response) is isolated to this one route; assetsExport.ts's identical
    // non-streaming approach has never shown this failure anywhere in this codebase.
    // The DB fetch below still batches with the same keyset pagination as before, so
    // memory use scales with export size the same way it always has — only the final
    // write-to-response mechanism changed.
    const workbook = new ExcelJS.Workbook();
    const COLUMN_COUNT = 11;
    try {
      const worksheet = workbook.addWorksheet("Activity Log");
      worksheet.columns = [
        { width: 18 },
        { width: 14 },
        { width: 22 },
        { width: 16 },
        { width: 16 },
        { width: 12 },
        { width: 24 },
        { width: 22 },
        { width: 24 },
        { width: 24 },
        { width: 40 }
      ];

      // Brand header band: same navy (FF1F4E79) the Audit Reconciliation and Register
      // exports already use for their own title rows (reports.ts/assetsExport.ts) —
      // reused rather than a third "brand color" for Excel exports in this app.
      const titleRow = worksheet.getRow(1);
      titleRow.getCell(1).value = "NephroPlus — Activity Log Export";
      worksheet.mergeCells(1, 1, 1, COLUMN_COUNT);
      titleRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
      titleRow.getCell(1).font = { color: { argb: "FFFFFFFF" }, bold: true, size: 12 };
      titleRow.commit();

      const generatedRow = worksheet.getRow(2);
      generatedRow.getCell(1).value = `Generated by ${req.user!.displayName} on ${formatIstTimestamp(new Date().toISOString())} IST`;
      worksheet.mergeCells(2, 1, 2, COLUMN_COUNT);
      generatedRow.getCell(1).font = { italic: true, color: { argb: "FF52525B" } };
      generatedRow.commit();

      const filterRow = worksheet.getRow(3);
      filterRow.getCell(1).value = filterSummaryText;
      worksheet.mergeCells(3, 1, 3, COLUMN_COUNT);
      filterRow.getCell(1).font = { italic: true, color: { argb: "FF52525B" } };
      filterRow.commit();

      worksheet.getRow(4).commit(); // blank spacer row

      const headerRow = worksheet.getRow(5);
      [
        "Timestamp (IST)",
        "Category",
        "Type / Action",
        "FAR ID",
        "Actor",
        "Financial Year",
        "Reason",
        "Field Changed",
        "Old Value",
        "New Value",
        "Other Details"
      ].forEach((label, i) => {
        headerRow.getCell(i + 1).value = label;
      });
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
          const shared = [
            formatIstTimestamp(item.createdAt),
            CATEGORY_LABELS[item.category],
            (item.details?.type as string | undefined) ?? humanizeAction(item.action),
            item.farId ?? "",
            item.actorUsername ?? "Unknown user",
            resolveFinancialYear(item.createdAt, fyStartMonth, fyStartDay),
            (item.details?.reason as string | undefined) ?? ""
          ];
          const otherDetails = buildOtherDetailsText(item.details);
          const changedFields = buildChangedFields(item.details);
          // One row per changed field — not one row per activity with a semicolon-joined
          // "Changed" blob — so Old Value/New Value stay real, filterable/pivotable Excel
          // columns even when a single action changed several fields at once. An action
          // with nothing to diff (a create, or an update with no prior-state capture yet)
          // still gets exactly one row, with those three columns blank.
          if (changedFields.length === 0) {
            worksheet.addRow([...shared, "", "", "", otherDetails]).commit();
          } else {
            for (const field of changedFields) {
              worksheet.addRow([...shared, field.label, field.oldValue, field.newValue, otherDetails]).commit();
            }
          }
        }

        const last = rows[rows.length - 1]!;
        cursor = { createdAt: last.created_at, src: last.src, id: Number(last.id) };
        if (rows.length < EXPORT_BATCH_SIZE) break;
      }

      const buffer = await workbook.xlsx.writeBuffer();
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="activity-log-${exportDate}.xlsx"`);
      return reply.send(buffer);
    } catch (err) {
      app.log.error(err, "Activity log export failed");
      reply.code(500);
      return { error: "Export failed." };
    }
  });
}
