import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { centerScopeSql } from "../auth/centerScope.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import type { AssetCalculationResult, AssetInput } from "../calc/types.js";
import {
  buildCalcCteExtras,
  buildConditionSql,
  buildFilterSummaryText,
  conditionsQuerySchema,
  TOTAL_WDV_AND_PROFIT_LOSS_SQL
} from "./assetColumnFilters.js";
import { loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { buildExceptionPredicate, EXCEPTION_KEYS, EXCEPTION_LABELS } from "./exceptionPredicates.js";

// Every Component 2 export column key — mirrors client/src/lib/columns.ts's
// C2_COLUMN_IDS (minus expiryDateC1/C2, which are Register-screen-only, never
// exported). Dropped from the export when every Sub Classification the request is
// filtered to is C1-only — see shouldHideC2Columns below.
const C2_EXPORT_KEYS = new Set([
  "usefulLifeC2Years",
  "c2OpeningCost",
  "additionsC2",
  "deletionsC2",
  "c2GrossBlock",
  "accDepC2Opening",
  "c2PeriodDep",
  "accDepOnDisposedC2",
  "c2AccDep",
  "c2Wdv",
  "c2NbvOpening",
  "c2Nbv"
]);

// Matched to a keyset page at a time (ordered by far_id) rather than one giant query, so
// exporting the full 2,50,000+ row register doesn't hold the whole result set in memory
// at once — same scale concern that motivated the denormalized location column and the
// PL/pgSQL report functions.
//
// Raised from 2,000 to 20,000 (a 10x cut in round trips) after profiling the export's
// real bottleneck (2026-09-04, investigating why the fully-styled version took 93-123s
// at 250k rows against Vercel's 60s Hobby-plan ceiling): per-batch instrumentation
// showed the batch query itself was ~50% of total time — but that cost turned out to be
// almost entirely WASTED work, not genuine per-row cost. The batch query always ran
// through the same two-stage far_calc_component() CTE the totals/computed-filter path
// needs, evaluating it for every row in the batch even when nothing downstream reads
// those computed columns (the per-row export values are independently recomputed in JS
// via computeAsset() regardless — see the batch loop's own comment). Skipping that CTE
// entirely for the common case (no computed-column filter — see the batch query's own
// branch below) turns this into a plain indexed range scan on `far_id`, cheap enough
// that a much bigger batch is safe; the remaining reason to keep batching at all instead
// of one huge query is memory (never holding the whole export in memory at once) and
// giving up cleanly at a batch boundary, not query cost.
const EXPORT_BATCH_SIZE = 20_000;

// TEMPORARY safety cap while this deployment is on Vercel's Hobby plan, which hard-caps
// every serverless function invocation at 60s with NO way to raise it (staying on Hobby
// is a deliberate choice for now — this is UAT, not full production yet — rather than a
// Pro-plan upgrade or a hosting migration; Supabase's own Pro plan IS in use, though,
// which is what made the fix below possible).
//
// The original version of this route (fully-styled ExcelJS output, 2,000-row batches
// that always ran the full far_calc_component() calc CTE regardless of need) measured
// 93,214-123,055ms for a 250,000-row export — that number came from the local load-test
// harness's embedded Postgres, a LOWER BOUND with zero network latency. Investigating
// why (2026-09-04) found two real, fixable costs: the batch query's calc CTE was mostly
// wasted work (the exported row VALUES are independently recomputed in JS via
// computeAsset() regardless — the CTE's own output was never read for that), and
// ExcelJS's per-row styled-cell writing was ~40% of total time on its own. Fixed both:
// the batch query skips the CTE entirely when there's no computed-column filter (see its
// own branch below), batch size raised 2,000 -> 20,000 now that the query is cheap, and
// the output switched from a styled .xlsx to plain CSV (same EXPORT_COLUMNS values,
// just without ExcelJS's per-cell formatting machinery) for every export size, not kept
// as a second parallel format.
//
// Re-measured end-to-end against the REAL Supabase Pro production database (not just
// local embedded Postgres, which the same investigation also caught giving wildly
// unreliable numbers for the totals query — 27s on one run, 73s on an identical
// back-to-back run, almost certainly its tiny 128MB shared_buffers fighting the test
// process for memory, not a real cost): 220,000 synthetic rows, unfiltered,
// end-to-end (row-count check + totals query + full batched export) — 17,780ms. That's
// with real Vercel-region-independent network latency included (the profiling script
// ran the same queries the route does directly against the production instance), just
// missing Vercel's own request-handling overhead, which is small next to a
// multi-second budget.
//
// EXPORT_ROW_LIMIT is set well below the ~740,000-row point that rate (17,780ms /
// 220,000 ≈ 0.081ms/row) alone projects to blow 60s — comfortable margin for real-world
// variance, messier data than the synthetic fixture, and Vercel's own overhead this
// measurement didn't include. Still a real cap, not removed outright, because none of
// this has been verified beyond ~220,000 rows.
//
// This is NOT a permanent design decision — raise or remove it entirely the moment
// hosting changes (a Pro plan's higher maxDuration, or a persistent-process host with no
// duration ceiling at all — server/src/index.ts is already built for that, see
// render.yaml).
export const EXPORT_ROW_LIMIT = 400_000;

// Comma-separated multi-value filters — see the identical helper in assets.ts (the
// non-export list route), which this route's filters intentionally mirror.
const multiValue = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").filter(Boolean) : undefined));

const exportQuerySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  center: multiValue,
  capLocation: multiValue,
  subClassification: multiValue,
  status: multiValue,
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
  globalSearch: z.string().optional(),
  // Excel-style per-column custom filter conditions — same mechanism and validation as
  // GET /api/assets (see assetColumnFilters.ts). Required so the export reflects
  // exactly the filtered result set Register's grid is showing, not the whole table.
  conditions: conditionsQuerySchema,
  // Finance FAR Dashboard drill-through — same shared predicate as GET /api/assets, so
  // "Export to Excel" from a drill-through view exports exactly those rows.
  exception: z.enum(EXCEPTION_KEYS).optional()
});

export interface LabelContext {
  asAt: string;
  fyStart: string;
}

// DD-MM-YYYY — a plain string rearrangement of the ISO "YYYY-MM-DD" storage format, no
// Date object and no timezone risk (matches the client's own formatDateDDMMYYYY, and the
// rest of this app's convention of treating dates as plain strings throughout).
export function ddmmyyyy(value: string | null): string {
  if (!value) return "";
  const [y, m, d] = value.split("-");
  return `${d}-${m}-${y}`;
}

// RFC4180 field escaping — same rule as the client's own csvEscape (BulkUploadPage.tsx's
// downloadTemplate, csvChunking.ts): quote only when the value actually contains a
// comma/quote/newline, doubling up any embedded quote. Numbers are written as plain,
// unformatted values (no thousands separator) — machine-readable and unambiguous in
// CSV, matching every other CSV this app already produces; a reader who wants
// "1,23,456.00"-style display formatting gets that from Excel's own column formatting
// after opening it, same as any other CSV import.
export function csvField(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: Array<string | number | null>): string {
  return values.map(csvField).join(",");
}

// The same 10 groups, in the same order, as client/src/lib/columns.ts (COLUMN_GROUPS) —
// kept as parallel definitions rather than a shared import since client and server are
// separate TS builds with no shared package boundary here. Unlike the on-screen Register
// (typography + borders only, no color — see AssetGrid.tsx), the export keeps a distinct
// muted fill per group; a spreadsheet has no sticky/collapsible affordances to lean on
// for orientation the way the live table does, so color still earns its place here.
const GROUP_INFO: Record<string, { label: string; fill: string }> = {
  g1: { label: "Asset Identification", fill: "FFF1F5F9" }, // slate-100
  g2: { label: "Gross Block (Cost)", fill: "FFEFF6FF" }, // blue-50
  g3: { label: "Addition Date", fill: "FFECFEFF" }, // cyan-50
  g4: { label: "Disposal Inputs", fill: "FFFFFBEB" }, // amber-50
  g5: { label: "Gross Block (Cost)", fill: "FFF0F9FF" }, // sky-50
  g6: { label: "Accumulated Depreciation (SLM, Actual Days, Capped at Gross Block)", fill: "FFF5F3FF" }, // violet-50
  g7: { label: "Acc Dep on Disposed Assets (at Disposal Date)", fill: "FFFFF7ED" }, // orange-50
  g8: { label: "Accumulated Depreciation", fill: "FFFAF5FF" }, // purple-50
  g9: { label: "Disposal P&L", fill: "FFFFF1F2" }, // rose-50
  g10: { label: "Net Block (NBV)", fill: "FFECFDF5" } // emerald-50
};

export interface ExportColumn {
  key: string;
  label: string | ((ctx: LabelContext) => string);
  width: number;
  groupKey: string;
  kind: "text" | "date" | "number";
  /** Only meaningful when kind === "number". Defaults to true — set false for a rate
   *  (e.g. Useful Life in years) that isn't meaningful to sum across dissimilar assets. */
  totalable?: boolean;
  value: (asset: AssetInput, result: AssetCalculationResult) => string | number | null;
}

// Matches the reference Fixed Asset Register export's 10 groups and 39 columns, in the
// same order — see client/src/lib/columns.ts for the identical structure the Register
// screen itself renders.
//
// Exported so other routes needing the exact same "which columns, which are numeric,
// which are totalable" answer (e.g. reports.ts's Register Summary — a grouped-totals
// report) read it from here rather than hand-redefining a second column list that could
// silently drift out of sync with this one.
export const EXPORT_COLUMNS: ExportColumn[] = [
  // --- 1. Asset Identification ---------------------------------------------------
  { key: "farId", label: "FAR ID", width: 18, groupKey: "g1", kind: "text", value: (a) => a.farId },
  { key: "subClassification", label: "Sub Classification", width: 22, groupKey: "g1", kind: "text", value: (a) => a.subClassification },
  { key: "dateAcquired", label: "Date Acquired", width: 16, groupKey: "g1", kind: "date", value: (a) => a.dateAcquired },
  { key: "location", label: "Capitalized Location", width: 20, groupKey: "g1", kind: "text", value: (a) => a.location },
  {
    key: "lastDateOfTransaction",
    label: "Last Date of Transaction",
    width: 22,
    groupKey: "g1",
    kind: "date",
    value: (_a, r) => r.lastDateOfTransaction
  },
  { key: "effectiveLocation", label: "Current Location", width: 20, groupKey: "g1", kind: "text", value: (_a, r) => r.effectiveLocation },
  { key: "serialNo", label: "Serial No", width: 18, groupKey: "g1", kind: "text", value: (a) => a.serialNo },
  { key: "parentFarId", label: "Parent FAR ID", width: 18, groupKey: "g1", kind: "text", value: (a) => a.parentFarId },
  { key: "status", label: "Status", width: 14, groupKey: "g1", kind: "text", value: (a) => a.status },
  { key: "assetDescription", label: "Asset Description", width: 34, groupKey: "g1", kind: "text", value: (a) => a.assetDescription },
  { key: "qty", label: "Qty", width: 10, groupKey: "g1", kind: "number", value: (a) => a.qty },
  {
    key: "usefulLifeC1Years",
    label: "Useful Life C1 (Yrs)",
    width: 18,
    groupKey: "g1",
    kind: "number",
    totalable: false,
    value: (a) => a.usefulLifeC1Years
  },
  {
    key: "usefulLifeC2Years",
    label: "Useful Life C2 (Yrs)",
    width: 18,
    groupKey: "g1",
    kind: "number",
    totalable: false,
    value: (a) => a.usefulLifeC2Years
  },

  // --- 2. Gross Block (Cost) -------------------------------------------------------
  {
    key: "c1OpeningCost",
    label: (ctx) => `C1 Opening (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 22,
    groupKey: "g2",
    kind: "number",
    // Live-classified Opening Gross Block (see engine.ts's splitTranche), not the raw
    // c1OpeningCost column — a mid-FY capitalization now correctly shows 0 here and its
    // full cost under Additions instead, and a prior-FY addition now correctly rolls
    // into this figure once FY Start advances, with no manual re-entry.
    value: (_a, r) => r.c1.openingGrossBlock
  },
  {
    key: "c2OpeningCost",
    label: (ctx) => `C2 Opening (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 22,
    groupKey: "g2",
    kind: "number",
    value: (_a, r) => r.c2.openingGrossBlock
  },
  {
    key: "additionsC1",
    label: "Additions C1 (during FY)",
    width: 20,
    groupKey: "g2",
    kind: "number",
    value: (_a, r) => r.c1.additionsGrossBlock
  },
  {
    key: "additionsC2",
    label: "Additions C2 (during FY)",
    width: 20,
    groupKey: "g2",
    kind: "number",
    value: (_a, r) => r.c2.additionsGrossBlock
  },

  // --- 3. Addition Date --------------------------------------------------------
  {
    key: "dateOfAddition",
    label: "Date of Addition (during FY)",
    width: 22,
    groupKey: "g3",
    kind: "date",
    value: (a) => a.dateOfAddition
  },

  // --- 4. Disposal Inputs ------------------------------------------------------
  { key: "dateOfDisposal", label: "Date of Disposal", width: 16, groupKey: "g4", kind: "date", value: (a) => a.dateOfDisposal },
  { key: "deletionsC1", label: "Deletions C1 (Cost)", width: 20, groupKey: "g4", kind: "number", value: (a) => a.deletionsC1 },
  { key: "deletionsC2", label: "Deletions C2 (Cost)", width: 20, groupKey: "g4", kind: "number", value: (a) => a.deletionsC2 },
  { key: "saleValue", label: "Sale Value / Proceeds", width: 20, groupKey: "g4", kind: "number", value: (a) => a.saleValue },

  // --- 5. Gross Block (Cost) — as at Figures As Of ------------------------------
  {
    key: "c1GrossBlock",
    label: (ctx) => `C1 Gross Block as at ${ddmmyyyy(ctx.asAt)}`,
    width: 22,
    groupKey: "g5",
    kind: "number",
    value: (_a, r) => r.c1.grossBlock
  },
  {
    key: "c2GrossBlock",
    label: (ctx) => `C2 Gross Block as at ${ddmmyyyy(ctx.asAt)}`,
    width: 22,
    groupKey: "g5",
    kind: "number",
    value: (_a, r) => r.c2.grossBlock
  },

  // --- 6. Accumulated Depreciation (SLM, actual days, capped at Gross Block) ----
  {
    key: "accDepC1Opening",
    label: (ctx) => `Acc Dep C1 (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 22,
    groupKey: "g6",
    kind: "number",
    value: (a) => a.accDepC1Opening
  },
  {
    key: "accDepC2Opening",
    label: (ctx) => `Acc Dep C2 (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 22,
    groupKey: "g6",
    kind: "number",
    value: (a) => a.accDepC2Opening
  },
  {
    key: "c1PeriodDep",
    label: (ctx) => `C1 Dep for Period (Capped, as at ${ddmmyyyy(ctx.asAt)})`,
    width: 26,
    groupKey: "g6",
    kind: "number",
    value: (_a, r) => r.c1.periodDepreciation
  },
  {
    key: "c2PeriodDep",
    label: (ctx) => `C2 Dep for Period (Capped, as at ${ddmmyyyy(ctx.asAt)})`,
    width: 26,
    groupKey: "g6",
    kind: "number",
    value: (_a, r) => r.c2.periodDepreciation
  },

  // --- 7. Acc Dep on Disposed Assets (at Disposal Date) -------------------------
  {
    key: "accDepOnDisposedC1",
    label: "Acc Dep on Disposed C1",
    width: 22,
    groupKey: "g7",
    kind: "number",
    value: (_a, r) => r.c1.accDepOnDisposed
  },
  {
    key: "accDepOnDisposedC2",
    label: "Acc Dep on Disposed C2",
    width: 22,
    groupKey: "g7",
    kind: "number",
    value: (_a, r) => r.c2.accDepOnDisposed
  },

  // --- 8. Accumulated Depreciation — as at Figures As Of ------------------------
  {
    key: "c1AccDep",
    label: (ctx) => `C1 Acc Dep as at ${ddmmyyyy(ctx.asAt)}`,
    width: 22,
    groupKey: "g8",
    kind: "number",
    value: (_a, r) => r.c1.closingAccDep
  },
  {
    key: "c2AccDep",
    label: (ctx) => `C2 Acc Dep as at ${ddmmyyyy(ctx.asAt)}`,
    width: 22,
    groupKey: "g8",
    kind: "number",
    value: (_a, r) => r.c2.closingAccDep
  },

  // --- 9. Disposal P&L -----------------------------------------------------------
  {
    key: "c1Wdv",
    label: "WDV at Disposal C1",
    width: 20,
    groupKey: "g9",
    kind: "number",
    value: (_a, r) => r.c1.wdvAtDisposal
  },
  {
    key: "c2Wdv",
    label: "WDV at Disposal C2",
    width: 20,
    groupKey: "g9",
    kind: "number",
    value: (_a, r) => r.c2.wdvAtDisposal
  },
  {
    key: "totalWdv",
    label: "Total WDV at Disposal",
    width: 20,
    groupKey: "g9",
    kind: "number",
    value: (_a, r) => (r.c1.wdvAtDisposal === null || r.c2.wdvAtDisposal === null ? null : r.c1.wdvAtDisposal + r.c2.wdvAtDisposal)
  },
  {
    key: "profitLoss",
    label: "Profit / (Loss) on Disposal",
    width: 22,
    groupKey: "g9",
    kind: "number",
    value: (_a, r) => r.assetProfitLossOnDisposal
  },

  // --- 10. Net Block (NBV) --------------------------------------------------------
  {
    key: "c1NbvOpening",
    label: (ctx) => `C1 NBV (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 20,
    groupKey: "g10",
    kind: "number",
    value: (_a, r) => r.c1.openingNbv
  },
  {
    key: "c2NbvOpening",
    label: (ctx) => `C2 NBV (as at ${ddmmyyyy(ctx.fyStart)})`,
    width: 20,
    groupKey: "g10",
    kind: "number",
    value: (_a, r) => r.c2.openingNbv
  },
  {
    key: "c1Nbv",
    label: (ctx) => `C1 NBV as at ${ddmmyyyy(ctx.asAt)}`,
    width: 20,
    groupKey: "g10",
    kind: "number",
    value: (_a, r) => r.c1.nbv
  },
  {
    key: "c2Nbv",
    label: (ctx) => `C2 NBV as at ${ddmmyyyy(ctx.asAt)}`,
    width: 20,
    groupKey: "g10",
    kind: "number",
    value: (_a, r) => r.c2.nbv
  }
];

export function resolveLabel(col: ExportColumn, ctx: LabelContext): string {
  return typeof col.label === "function" ? col.label(ctx) : col.label;
}

// Contiguous runs of the same groupKey, for the group-band row's merged cells — same
// approach as the client's buildBandSegments, minus the pinned-column concept (nothing
// is pinned in a spreadsheet).
function groupRuns(columns: ExportColumn[]): Array<{ groupKey: string; startCol: number; endCol: number }> {
  const runs: Array<{ groupKey: string; startCol: number; endCol: number }> = [];
  columns.forEach((col, i) => {
    const colNumber = i + 1;
    const last = runs[runs.length - 1];
    if (last && last.groupKey === col.groupKey) last.endCol = colNumber;
    else runs.push({ groupKey: col.groupKey, startCol: colNumber, endCol: colNumber });
  });
  return runs;
}

// The columns SUM(...)'d in the aggregate totals query — every `kind: "number"` column
// with `totalable !== false`, except `totalWdv`, which is a combined C1+C2 figure derived
// in JS afterwards from the c1/c2 component sums (also fetched below) rather than needing
// its own SQL expression. `profitLoss` DOES need its own expression (assetProfitLoss,
// below) rather than summing per-component figures — see its comment for why.
//
// Exported (like EXPORT_COLUMNS above) so a grouped-totals report can build its own
// SUM(...) SELECT list from these same expressions instead of re-deriving them —
// keyed by EXPORT_COLUMN key, except `profitLoss` (keyed here as `assetProfitLoss`,
// historical) and `totalWdv` (no entry at all — always derived, see above).
export const SQL_SUM_EXPRESSIONS: Record<string, string> = {
  qty: "SUM(qty)",
  // Opening/Additions totals read the calc engine's own live-classified fields (see
  // far_calc_component in schema.sql), not the raw columns — matching the per-row
  // export values above, which do the same via `result.c1/c2.openingGrossBlock`.
  c1OpeningCost: "SUM((c1).opening_gross_block)",
  c2OpeningCost: "SUM((c2).opening_gross_block)",
  additionsC1: "SUM((c1).additions_gross_block)",
  additionsC2: "SUM((c2).additions_gross_block)",
  deletionsC1: "SUM(deletions_c1)",
  deletionsC2: "SUM(deletions_c2)",
  saleValue: "SUM(sale_value)",
  accDepC1Opening: "SUM(acc_dep_c1_opening)",
  accDepC2Opening: "SUM(acc_dep_c2_opening)",
  c1NbvOpening: "SUM((c1).opening_nbv)",
  c2NbvOpening: "SUM((c2).opening_nbv)",
  c1GrossBlock: "SUM((c1).gross_block)",
  c2GrossBlock: "SUM((c2).gross_block)",
  c1PeriodDep: "SUM((c1).period_depreciation)",
  c2PeriodDep: "SUM((c2).period_depreciation)",
  accDepOnDisposedC1: "SUM((c1).acc_dep_on_disposed)",
  accDepOnDisposedC2: "SUM((c2).acc_dep_on_disposed)",
  c1AccDep: "SUM((c1).closing_acc_dep)",
  c2AccDep: "SUM((c2).closing_acc_dep)",
  c1Wdv: "SUM((c1).wdv_at_disposal)",
  c2Wdv: "SUM((c2).wdv_at_disposal)",
  // Sale Value counted once against the combined WDV, matching the reference workbook's
  // Methodology sheet — NOT SUM(c1.profit_loss_on_disposal) + SUM(c2.profit_loss_on_disposal),
  // which double-counts sale_value once per disposed row (each per-component field
  // independently subtracts the *full* sale_value). NULL for non-disposed rows (both WDVs
  // are NULL), so SUM() skips them automatically, same as the per-component sums above.
  assetProfitLoss: "SUM(sale_value - ((c1).wdv_at_disposal + (c2).wdv_at_disposal))",
  c1Nbv: "SUM((c1).nbv)",
  c2Nbv: "SUM((c2).nbv)"
};

/** Counts exactly the rows the export below would stream — as cheaply as the filters
 *  actually require, and deliberately NOT by reading it off the totals query further
 *  down (which was the first version of this check): that query always pays for the
 *  full two-stage calc CTE (far_calc_component() evaluated per row) whether or not
 *  anything actually needs it, which measured ~39s on its own at 250,000 rows — an
 *  unfiltered, always-over-EXPORT_ROW_LIMIT request would then take 39s just to be told
 *  no, nowhere near the "fast" rejection the limit is supposed to give.
 *
 *  A plain named-filter export (the common case — and the one most likely to actually
 *  exceed EXPORT_ROW_LIMIT, since a computed-column filter typically narrows the result
 *  on its own) doesn't need the CTE at all: `whereClause` filters real columns on
 *  `assets` directly, so a bare COUNT(*) suffices. Only a genuine computed-column filter
 *  (an Excel-style condition on a derived value like C1 NBV, or a dashboard exception)
 *  actually requires evaluating the CTE to know which rows match — that's the only case
 *  paying its cost, same reasoning the batch loop's own "can't stop early" ponytail
 *  comment documents below.
 *
 *  Both branches read the SAME `whereClause`/`params`/`computedWhereClause` the totals
 *  query and the batch loop also use — nothing here rebuilds any filter-building logic. */
async function countMatchingRows(
  db: pg.Pool,
  whereClause: string,
  params: unknown[],
  computedConditions: string[],
  computedWhereClause: string,
  asAt: string,
  fy: { fyStart: string; fyEnd: string; daysInFy: number }
): Promise<number> {
  if (computedConditions.length === 0) {
    const { rows } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM assets ${whereClause}`, params);
    return Number(rows[0]!.count);
  }
  const countParams = [...params];
  const countCalcExtras = buildCalcCteExtras(countParams, asAt, fy);
  const { rows } = await db.query<{ count: string }>(
    `WITH calc_base AS (
       SELECT assets.*,
         ${countCalcExtras}
       FROM assets ${whereClause}
     ), calc AS (
       SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
       FROM calc_base
     )
     SELECT COUNT(*) AS count FROM calc ${computedWhereClause}`,
    countParams
  );
  return Number(rows[0]!.count);
}

export default async function assetsExportRoutes(app: FastifyInstance) {
  // Register's "Export to Excel": exactly the same filters as GET /api/assets — the
  // named fields (center, sub classification, status, date range, FAR ID search) plus
  // the Excel-style `conditions` array (including computed columns like NBV, via the
  // same far_calc_component-backed calc CTE) — but every matching row rather than one
  // page. No filters applied means the entire register is exported; either way, a
  // filter-summary note row states exactly what was applied so the file is never
  // mistaken for the full register once it's out of context. Full 39-column/10-group
  // parity with the on-screen Register table (see columns.ts on the
  // client) — a filter-summary note, a totals row, then the grouped header (merged, bold, no fill color), then
  // one streamed row per matching asset.
  app.get("/api/assets/export", { preHandler: requirePermission("register", "export") }, async (req, reply) => {
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();

    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const asAt = q.asAt ?? fySettings.as_at;
    const fy = mapSettingsRow(fySettings);
    fy.asAt = asAt;
    const ctx: LabelContext = { asAt: fy.asAt, fyStart: fy.fyStart };

    // Soft-deleted (Global Admin only, DELETE /api/assets/:farId) — always excluded from
    // the export, not an opt-in filter.
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    // Center-scoped access — same reasoning and column as GET /api/assets' own filter.
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
    if (q.subClassification) {
      params.push(q.subClassification);
      conditions.push(`sub_classification = ANY($${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`status = ANY($${params.length})`);
    }
    // Same fix as GET /api/assets: an export as at a given date can never include an
    // asset not yet capitalized as of that date — always applied.
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
    if (q.search) {
      params.push(`${q.search.toUpperCase()}%`);
      conditions.push(`far_id LIKE $${params.length}`);
    }
    if (q.descriptionSearch) {
      params.push(`%${q.descriptionSearch}%`);
      conditions.push(`asset_description ILIKE $${params.length}`);
    }
    if (q.globalSearch) {
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
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Excel-style column-header conditions — same handling as GET /api/assets: resolved
    // against the calc CTE (far_calc_component's c1/c2 plus the derived columns), applied
    // in the outer query after the CTE exists. Built once here and reused by both the
    // totals query and every row-fetching batch below, so the totals row and the exported
    // rows are always the same filtered set.
    const computedConditions: string[] = [];
    for (const cond of q.conditions) {
      const built = buildConditionSql(cond, params, { fyStart: fy.fyStart, fyEnd: fy.fyEnd });
      if ("error" in built) {
        reply.code(400);
        return { error: built.error };
      }
      computedConditions.push(built.sql);
    }
    if (q.exception) {
      computedConditions.push(buildExceptionPredicate(q.exception, params, { fyStart: fy.fyStart, asAt }));
    }
    const computedWhereClause = computedConditions.length > 0 ? `WHERE ${computedConditions.join(" AND ")}` : "";
    const filterSummaryText =
      buildFilterSummaryText(q, q.conditions) + (q.exception ? `; Dashboard Exception: ${EXCEPTION_LABELS[q.exception]}` : "");
    // DD-MM-YYYY HH:MM, matching the app's own date convention (ddmmyyyy() above) —
    // built from Intl's individual parts rather than trusting a locale's default
    // separator (en-IN renders DD/MM/YYYY with slashes, not the dashes used everywhere
    // else in this app), pinned to IST so the timestamp is unambiguous regardless of
    // which timezone the server process itself happens to run in.
    const exportedAtParts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Kolkata"
    }).formatToParts(new Date());
    const part = (type: string) => exportedAtParts.find((p) => p.type === type)?.value ?? "";
    const exportedAtText = `${part("day")}-${part("month")}-${part("year")} ${part("hour")}:${part("minute")}`;

    // Rejected up front, before the (expensive) totals query below even runs and well
    // before reply.send(stream) — a normal JSON error response the client can actually
    // show, not a 60s-timeout-killed truncated file. See EXPORT_ROW_LIMIT's own comment
    // for why this deployment needs a cap at all right now, and countMatchingRows' own
    // comment for why this is a separate, minimal query rather than reading a count off
    // the totals query further down.
    let rowCount: number;
    try {
      rowCount = await countMatchingRows(db, whereClause, params, computedConditions, computedWhereClause, asAt, {
        fyStart: fy.fyStart,
        fyEnd: fy.fyEnd,
        daysInFy: fy.daysInFy
      });
    } catch (err) {
      req.log.error({ err, whereClause, computedWhereClause }, "Register export row-count check failed");
      reply.code(500);
      return { error: "Could not export the register with these filters — try removing or adjusting one of them." };
    }
    if (rowCount > EXPORT_ROW_LIMIT) {
      reply.code(400);
      return {
        error: `This export would include ${rowCount.toLocaleString()} rows, more than this deployment can reliably generate in one request right now (limit: ${EXPORT_ROW_LIMIT.toLocaleString()}). Narrow your filters — by Center, Sub Classification, Status, or Date Acquired range — and try again with a smaller result set.`
      };
    }

    // Totals row: one aggregate pass over every matching row (same filters, no cursor),
    // computed in Postgres via the same `far_calc_component` SQL port of the calc engine
    // the other reports already use — reading all 2,50,000+ rows into Node just to sum
    // them would defeat the point of streaming the export in the first place. Uses its
    // own copy of `params` (not the shared one) since its calc-CTE params are specific to
    // this one query — the per-batch loop below builds an identical CTE fresh per batch,
    // off the shared (pre-totals) `params`, so the two never share param indices.
    const totalsParams = [...params];
    const totalsCalcExtras = buildCalcCteExtras(totalsParams, asAt, { fyStart: fy.fyStart, fyEnd: fy.fyEnd, daysInFy: fy.daysInFy });
    const totalsSql = `WITH calc_base AS (
         SELECT assets.*,
           ${totalsCalcExtras}
         FROM assets ${whereClause}
       ), calc AS (
         SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
         FROM calc_base
       )
       SELECT
         ${SQL_SUM_EXPRESSIONS.qty} AS qty,
         ${SQL_SUM_EXPRESSIONS.c1OpeningCost} AS c1_opening_cost,
         ${SQL_SUM_EXPRESSIONS.c2OpeningCost} AS c2_opening_cost,
         ${SQL_SUM_EXPRESSIONS.additionsC1} AS additions_c1,
         ${SQL_SUM_EXPRESSIONS.additionsC2} AS additions_c2,
         ${SQL_SUM_EXPRESSIONS.deletionsC1} AS deletions_c1,
         ${SQL_SUM_EXPRESSIONS.deletionsC2} AS deletions_c2,
         ${SQL_SUM_EXPRESSIONS.saleValue} AS sale_value,
         ${SQL_SUM_EXPRESSIONS.accDepC1Opening} AS acc_dep_c1_opening,
         ${SQL_SUM_EXPRESSIONS.accDepC2Opening} AS acc_dep_c2_opening,
         ${SQL_SUM_EXPRESSIONS.c1NbvOpening} AS c1_nbv_opening,
         ${SQL_SUM_EXPRESSIONS.c2NbvOpening} AS c2_nbv_opening,
         ${SQL_SUM_EXPRESSIONS.c1GrossBlock} AS c1_gross_block,
         ${SQL_SUM_EXPRESSIONS.c2GrossBlock} AS c2_gross_block,
         ${SQL_SUM_EXPRESSIONS.c1PeriodDep} AS c1_period_dep,
         ${SQL_SUM_EXPRESSIONS.c2PeriodDep} AS c2_period_dep,
         ${SQL_SUM_EXPRESSIONS.accDepOnDisposedC1} AS acc_dep_on_disposed_c1,
         ${SQL_SUM_EXPRESSIONS.accDepOnDisposedC2} AS acc_dep_on_disposed_c2,
         ${SQL_SUM_EXPRESSIONS.c1AccDep} AS c1_acc_dep,
         ${SQL_SUM_EXPRESSIONS.c2AccDep} AS c2_acc_dep,
         ${SQL_SUM_EXPRESSIONS.c1Wdv} AS c1_wdv,
         ${SQL_SUM_EXPRESSIONS.c2Wdv} AS c2_wdv,
         ${SQL_SUM_EXPRESSIONS.assetProfitLoss} AS asset_profit_loss,
         ${SQL_SUM_EXPRESSIONS.c1Nbv} AS c1_nbv,
         ${SQL_SUM_EXPRESSIONS.c2Nbv} AS c2_nbv
       FROM calc ${computedWhereClause}`;

    let totalsRows: Record<string, string | null>[];
    try {
      ({ rows: totalsRows } = await db.query(totalsSql, totalsParams));
    } catch (err) {
      // Same reasoning as GET /api/assets's identical guard — a bad filter combination
      // should never leak a raw Postgres error to whoever clicked Export.
      req.log.error({ err, sql: totalsSql, params: totalsParams }, "Register export totals query failed");
      reply.code(500);
      return { error: "Could not export the register with these filters — try removing or adjusting one of them." };
    }
    const t = totalsRows[0] as Record<string, string | null>;
    const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
    const totals: Record<string, number> = {
      qty: num(t.qty),
      c1OpeningCost: num(t.c1_opening_cost),
      c2OpeningCost: num(t.c2_opening_cost),
      additionsC1: num(t.additions_c1),
      additionsC2: num(t.additions_c2),
      deletionsC1: num(t.deletions_c1),
      deletionsC2: num(t.deletions_c2),
      saleValue: num(t.sale_value),
      accDepC1Opening: num(t.acc_dep_c1_opening),
      accDepC2Opening: num(t.acc_dep_c2_opening),
      c1NbvOpening: num(t.c1_nbv_opening),
      c2NbvOpening: num(t.c2_nbv_opening),
      c1GrossBlock: num(t.c1_gross_block),
      c2GrossBlock: num(t.c2_gross_block),
      c1PeriodDep: num(t.c1_period_dep),
      c2PeriodDep: num(t.c2_period_dep),
      accDepOnDisposedC1: num(t.acc_dep_on_disposed_c1),
      accDepOnDisposedC2: num(t.acc_dep_on_disposed_c2),
      c1AccDep: num(t.c1_acc_dep),
      c2AccDep: num(t.c2_acc_dep),
      c1Wdv: num(t.c1_wdv),
      c2Wdv: num(t.c2_wdv),
      totalWdv: num(t.c1_wdv) + num(t.c2_wdv),
      profitLoss: num(t.asset_profit_loss),
      c1Nbv: num(t.c1_nbv),
      c2Nbv: num(t.c2_nbv)
    };

    // Same "scoped to C1-only Sub Classification(s)" rule Register's own screen uses
    // (client/src/lib/columns.ts's allScopedC1Only) — only the exact multi-select filter
    // is checked here (not a custom-condition "equals", which the screen also honors),
    // since that's what this export's own query params carry. An unfiltered or
    // mixed-classification export always keeps every column.
    let shouldHideC2 = false;
    if (q.subClassification && q.subClassification.length > 0) {
      const maps = await loadActiveMasterMaps(db);
      shouldHideC2 = q.subClassification.every((name) => {
        const canonical = lookupCanonical(maps.subClassifications, name);
        return canonical !== undefined && maps.subClassificationHasComponent2.get(canonical) === false;
      });
    }
    const exportColumns = shouldHideC2 ? EXPORT_COLUMNS.filter((c) => !C2_EXPORT_KEYS.has(c.key)) : EXPORT_COLUMNS;

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="far-register-${asAt}.csv"`);

    const stream = new PassThrough();
    reply.send(stream);

    try {
      // Plain CSV, not a styled .xlsx — replaces the old per-row-styled ExcelJS output
      // outright rather than keeping both (2026-09-04, closing the same 60s-timeout gap
      // EXPORT_ROW_LIMIT was a stopgap for): profiling found ExcelJS's own per-row
      // styled-cell writing was ~40% of total export time on its own, on top of the
      // ~50% spent in the batch query (see EXPORT_BATCH_SIZE's comment). Every value
      // below is IDENTICAL data to what the old workbook wrote in the same 4 header
      // rows + one row per asset — only the styling (bold, italic, per-group fill
      // color, merged cells, column widths, number formatting) is gone, since none of
      // it survives a CSV anyway. Kept as ONE format for every export size rather than
      // maintaining a second, fully-styled code path alongside this one purely for
      // small/filtered exports — same EXPORT_COLUMNS definitions drive both the values
      // and the (now plain) column/group/totals rows, so there's nothing to keep in
      // sync between two parallel renderers.

      // Row 1: filter-summary note — what this file represents and when it was pulled,
      // so it's never mistaken for the full register once it's out of context (e.g.
      // forwarded, or opened weeks later). A single field, not one per column (nothing
      // to merge across in CSV).
      stream.write(csvLine([`Filters applied: ${filterSummaryText}  —  Exported: ${exportedAtText} IST`]) + "\r\n");

      // Row 2: totals — "TOTAL" in the first column, a sum under every totalable numeric
      // column, blank everywhere else (text/date columns, and non-totalable numbers like
      // Useful Life).
      const totalsRowValues = exportColumns.map((c, i) => {
        if (i === 0) return "TOTAL";
        if (c.kind === "number" && c.totalable !== false) return totals[c.key] ?? 0;
        return "";
      });
      stream.write(csvLine(totalsRowValues) + "\r\n");

      // Row 3: group band — the group label at each contiguous run's first column,
      // blank for the rest of that run (exactly the same cell VALUES the old merged/
      // filled version wrote — the merge and fill were a presentation layer on top of
      // this same data, never part of it).
      const groupRowValues = exportColumns.map<string>(() => "");
      for (const run of groupRuns(exportColumns)) {
        groupRowValues[run.startCol - 1] = GROUP_INFO[run.groupKey]!.label;
      }
      stream.write(csvLine(groupRowValues) + "\r\n");

      // Row 4: column names — resolves each column's live "as at ..." date text.
      stream.write(csvLine(exportColumns.map((c) => resolveLabel(c, ctx))) + "\r\n");

      // Timing instrumentation — logged per batch (not just a final total) so a real
      // Vercel function log shows exactly how far the export got and how long each
      // stage took if the function is killed mid-export (a platform timeout/OOM kill
      // terminates the process outright — no JS code runs at that point, including the
      // catch block below, so this is the only way to see from the logs alone whether
      // batch N was slow, or the process never got past batch N at all).
      const exportStart = performance.now();
      let batchNumber = 0;
      let rowsExported = 0;
      let lastFarId: string | null = null;
      for (;;) {
        batchNumber++;
        const batchStart = performance.now();
        const batchParams = [...params];
        const batchConditions = [...conditions];
        if (lastFarId !== null) {
          batchParams.push(lastFarId);
          batchConditions.push(`far_id > $${batchParams.length}`);
        }
        const batchWhereClause = batchConditions.length > 0 ? `WHERE ${batchConditions.join(" AND ")}` : "";

        const assetQueryStart = performance.now();
        let rows: AssetRow[];
        if (computedConditions.length === 0) {
          // The common case, and the one every large export actually takes (a
          // computed-column filter typically narrows the result on its own well below
          // EXPORT_ROW_LIMIT). No computed-column condition means nothing downstream
          // reads far_calc_component()'s output for this batch at all — the exported
          // row VALUES are independently recomputed in JS via computeAsset() just below
          // regardless (it needs each asset's transfer history for location-derived
          // fields the SQL function alone doesn't have), so the calc CTE's own columns
          // would be pure waste here. A plain indexed range scan on `far_id` instead —
          // this alone was roughly half of this route's total time before being found
          // and fixed (2026-09-04, see EXPORT_BATCH_SIZE's own comment for the numbers).
          batchParams.push(EXPORT_BATCH_SIZE);
          ({ rows } = await db.query<AssetRow>(
            `SELECT * FROM assets ${batchWhereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
            batchParams
          ));
        } else {
          // A genuine computed-column filter (e.g. C1 NBV > X) or dashboard exception
          // DOES need far_calc_component() evaluated to know which rows even match —
          // same two-stage calc CTE as the totals query above (and GET /api/assets).
          // ponytail: Postgres can't stop at EXPORT_BATCH_SIZE raw rows the way the
          // no-computed-filter branch above can — it has to compute far_calc_component
          // for every remaining row past the cursor to know which ones pass, every
          // batch iteration, until it collects a full page or exhausts the table. A
          // real, pre-existing cost this branch alone still pays; not fixed here (would
          // need a covering index or a materialized computed-value column) since
          // EXPORT_ROW_LIMIT already bounds how bad it can get.
          const batchCalcExtras = buildCalcCteExtras(batchParams, asAt, { fyStart: fy.fyStart, fyEnd: fy.fyEnd, daysInFy: fy.daysInFy });
          batchParams.push(EXPORT_BATCH_SIZE);
          ({ rows } = await db.query<AssetRow>(
            `WITH calc_base AS (
               SELECT assets.*,
                 ${batchCalcExtras}
               FROM assets ${batchWhereClause}
             ), calc AS (
               SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
               FROM calc_base
             )
             SELECT * FROM calc ${computedWhereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
            batchParams
          ));
        }
        if (rows.length === 0) break;
        const assetQueryMs = performance.now() - assetQueryStart;

        const farIds = rows.map((r) => r.far_id);
        const transferQueryStart = performance.now();
        const { rows: transferRows } = await db.query<TransferRow>(
          `SELECT far_id, transaction_date, location FROM transfers
           WHERE far_id = ANY($1) AND transaction_date <= $2 AND deleted_at IS NULL
           ORDER BY far_id, transaction_date`,
          [farIds, asAt]
        );
        const transferQueryMs = performance.now() - transferQueryStart;
        const rowBuildStart = performance.now();
        // Grouped once per batch, O(rows + transfers) — same pattern reports.ts's
        // streamAssetDepreciationBatches already uses at this app's 250k-row scale.
        // The previous version called `transferRows.filter(t => t.far_id === row.far_id)`
        // INSIDE the per-row loop below: O(batchSize × transferRows.length) per batch,
        // which scales quadratically with how many transfers this batch's assets have —
        // a real, confirmed CPU cost this route was the only batched-export route to
        // still pay (found while investigating a reported corrupted-export bug at
        // 217,000+ real rows).
        const transfersByFarId = new Map<string, TransferRow[]>();
        for (const t of transferRows) {
          const list = transfersByFarId.get(t.far_id);
          if (list) list.push(t);
          else transfersByFarId.set(t.far_id, [t]);
        }

        // One CSV line per row, joined and written to the stream once per batch rather
        // than once per row — far fewer stream writes than the old per-row
        // `worksheet.addRow(values).commit()` calls, on top of not paying for any
        // per-cell styling at all.
        const lines: string[] = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const asset = mapAssetRow(row);
          const relevantTransfers = (transfersByFarId.get(row.far_id) ?? []).map(mapTransferRow);
          const result = computeAsset(asset, fy, relevantTransfers);
          const values = exportColumns.map((c) => {
            const v = c.value(asset, result);
            if (c.kind === "date") return ddmmyyyy(v as string | null);
            return v;
          });
          lines[i] = csvLine(values);
        }
        stream.write(lines.join("\r\n") + "\r\n");

        rowsExported += rows.length;
        const rowBuildMs = performance.now() - rowBuildStart;
        const batchElapsedMs = performance.now() - batchStart;
        req.log.info(
          {
            batchNumber,
            rowsInBatch: rows.length,
            rowsExported,
            assetQueryMs: Math.round(assetQueryMs),
            transferQueryMs: Math.round(transferQueryMs),
            rowBuildMs: Math.round(rowBuildMs),
            batchElapsedMs: Math.round(batchElapsedMs),
            totalElapsedMs: Math.round(performance.now() - exportStart)
          },
          "Register export: batch complete"
        );

        lastFarId = rows[rows.length - 1]!.far_id;
        if (rows.length < EXPORT_BATCH_SIZE) break;
      }

      await new Promise<void>((resolve, reject) => stream.end((err: unknown) => (err ? reject(err) : resolve())));
      req.log.info(
        { rowsExported, batchNumber, totalElapsedMs: Math.round(performance.now() - exportStart) },
        "Register export: complete"
      );
    } catch (err) {
      app.log.error(err, "Register export failed mid-stream");
      stream.destroy(err instanceof Error ? err : new Error("Export failed"));
    }
  });
}
