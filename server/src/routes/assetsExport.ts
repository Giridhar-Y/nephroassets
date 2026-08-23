import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import type { AssetCalculationResult, AssetInput } from "../calc/types.js";

// Matched to a keyset page at a time (ordered by far_id) rather than one giant query, so
// exporting the full 2,50,000+ row register doesn't hold the whole result set in memory
// at once — same scale concern that motivated the denormalized location column and the
// PL/pgSQL report functions.
const EXPORT_BATCH_SIZE = 2000;

// Comma-separated multi-value filters — see the identical helper in assets.ts (the
// non-export list route), which this route's filters intentionally mirror.
const multiValue = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").filter(Boolean) : undefined));

const exportQuerySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  center: multiValue,
  subClassification: multiValue,
  status: multiValue,
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
  globalSearch: z.string().optional()
});

interface LabelContext {
  asAt: string;
  fyStart: string;
}

// DD-MM-YYYY — a plain string rearrangement of the ISO "YYYY-MM-DD" storage format, no
// Date object and no timezone risk (matches the client's own formatDateDDMMYYYY, and the
// rest of this app's convention of treating dates as plain strings throughout).
function ddmmyyyy(value: string | null): string {
  if (!value) return "";
  const [y, m, d] = value.split("-");
  return `${d}-${m}-${y}`;
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

interface ExportColumn {
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
const EXPORT_COLUMNS: ExportColumn[] = [
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

function resolveLabel(col: ExportColumn, ctx: LabelContext): string {
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
const SQL_SUM_EXPRESSIONS: Record<string, string> = {
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

export default async function assetsExportRoutes(app: FastifyInstance) {
  // Register's "Export to Excel": same filters as GET /api/assets (center, sub
  // classification, status, date range, FAR ID search), but every matching row rather
  // than one page — no filters applied means the entire register is exported. Full
  // 39-column/10-group parity with the on-screen Register table (see columns.ts on the
  // client) — a totals row, then the grouped header (merged, bold, no fill color), then
  // one streamed row per matching asset.
  app.get("/api/assets/export", async (req, reply) => {
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

    // Totals row: one aggregate pass over every matching row (same filters, no cursor),
    // computed in Postgres via the same `far_calc_component` SQL port of the calc engine
    // the other reports already use — reading all 2,50,000+ rows into Node just to sum
    // them would defeat the point of streaming the export in the first place.
    const totalsParams = [...params, fy.asAt, fy.fyStart, fy.daysInFy];
    const asAtPh = params.length + 1;
    const fyStartPh = params.length + 2;
    const daysPh = params.length + 3;
    const { rows: totalsRows } = await db.query(
      `WITH calc AS (
         SELECT qty, acc_dep_c1_opening, acc_dep_c2_opening,
           far_calc_component(c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
             date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $${asAtPh}, $${fyStartPh}, $${daysPh}, date_acquired) AS c1,
           far_calc_component(c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
             date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $${asAtPh}, $${fyStartPh}, $${daysPh}, date_acquired) AS c2,
           deletions_c1, deletions_c2, sale_value
         FROM assets ${whereClause}
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
       FROM calc`,
      totalsParams
    );
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

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="far-register-${asAt}.xlsx"`);

    const stream = new PassThrough();
    reply.send(stream);

    try {
      // useStyles: true — needed for bold headers and per-column number formatting.
      // Column-level numFmt/width (set once, not per cell/row) keeps the per-row cost of
      // this low even at 2,50,000+ rows, unlike setting styles on every individual cell.
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
      const worksheet = workbook.addWorksheet("Register");
      worksheet.columns = EXPORT_COLUMNS.map((c) => ({
        width: c.width,
        style: c.kind === "number" ? { numFmt: "#,##0.00" } : undefined
      }));

      // Row 1: totals — "TOTAL" in the first column, a sum under every totalable numeric
      // column, blank everywhere else (text/date columns, and non-totalable numbers like
      // Useful Life).
      const totalsRowValues = EXPORT_COLUMNS.map((c, i) => {
        if (i === 0) return "TOTAL";
        if (c.kind === "number" && c.totalable !== false) return totals[c.key] ?? 0;
        return "";
      });
      const totalsRow = worksheet.addRow(totalsRowValues);
      totalsRow.font = { bold: true };
      totalsRow.commit();

      // Row 2: group band — merged across each contiguous same-group run, bold, with a
      // distinct muted fill per group (every cell in the run gets it, not just the
      // merged range's top-left, so it renders correctly regardless of how a given
      // reader handles merge-range styling).
      const groupRow = worksheet.addRow(EXPORT_COLUMNS.map(() => ""));
      for (const run of groupRuns(EXPORT_COLUMNS)) {
        const info = GROUP_INFO[run.groupKey]!;
        groupRow.getCell(run.startCol).value = info.label;
        for (let c = run.startCol; c <= run.endCol; c++) {
          groupRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: info.fill } };
        }
        if (run.endCol > run.startCol) worksheet.mergeCells(2, run.startCol, 2, run.endCol);
      }
      groupRow.font = { bold: true };
      groupRow.commit();

      // Row 3: column names — resolves each column's live "as at ..." date text.
      const headerRow = worksheet.addRow(EXPORT_COLUMNS.map((c) => resolveLabel(c, ctx)));
      headerRow.font = { bold: true };
      headerRow.commit();

      let lastFarId: string | null = null;
      for (;;) {
        const batchParams = [...params];
        const batchConditions = [...conditions];
        if (lastFarId !== null) {
          batchParams.push(lastFarId);
          batchConditions.push(`far_id > $${batchParams.length}`);
        }
        const batchWhereClause = batchConditions.length > 0 ? `WHERE ${batchConditions.join(" AND ")}` : "";
        batchParams.push(EXPORT_BATCH_SIZE);

        const { rows } = await db.query<AssetRow>(
          `SELECT * FROM assets ${batchWhereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
          batchParams
        );
        if (rows.length === 0) break;

        const farIds = rows.map((r) => r.far_id);
        const { rows: transferRows } = await db.query<TransferRow>(
          `SELECT far_id, transaction_date, location FROM transfers
           WHERE far_id = ANY($1) AND transaction_date <= $2
           ORDER BY far_id, transaction_date`,
          [farIds, asAt]
        );

        for (const row of rows) {
          const asset = mapAssetRow(row);
          const relevantTransfers = transferRows.filter((t) => t.far_id === row.far_id).map(mapTransferRow);
          const result = computeAsset(asset, fy, relevantTransfers);
          const values = EXPORT_COLUMNS.map((c) => {
            const v = c.value(asset, result);
            if (c.kind === "date") return ddmmyyyy(v as string | null);
            return v ?? "";
          });
          worksheet.addRow(values).commit();
        }

        lastFarId = rows[rows.length - 1]!.far_id;
        if (rows.length < EXPORT_BATCH_SIZE) break;
      }

      worksheet.commit();
      await workbook.commit();
    } catch (err) {
      app.log.error(err, "Register export failed mid-stream");
      stream.destroy(err instanceof Error ? err : new Error("Export failed"));
    }
  });
}
