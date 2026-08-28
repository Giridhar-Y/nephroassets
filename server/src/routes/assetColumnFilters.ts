import {
  makeConditionBuilder,
  makeConditionsQuerySchema,
  pushParam,
  type ColumnFilterType as CoreColumnFilterType,
  type RawCondition as CoreRawCondition
} from "./columnFilterCore.js";

// Excel-style per-column custom filter conditions for Register — every column in
// client/src/lib/columns.ts's ALL_COLUMNS gets an entry here. `sql` is a raw SQL
// expression valid inside assets.ts's `calc` CTE, which exposes every raw `assets`
// column unchanged (via SELECT assets.*) plus these computed aliases: `c1`/`c2` (the
// two far_calc_component() composites), `effective_location`,
// `computed_last_date_of_transaction`, `expiry_date_c1`/`expiry_date_c2`, `total_wdv`,
// `profit_loss` — see buildCalcCte there.
//
// This is filter-only: it decides which rows match, never what's displayed. The
// response body is still built from mapAssetRow() + computeAsset() exactly as before —
// two independent (but sqlParity.test.ts-verified-consistent) implementations of the
// same math, kept that way deliberately so a filtering change here can never alter a
// displayed figure.
//
// A computed alias here must never reuse the exact name of a real `assets` column —
// `SELECT assets.*` pulls every raw column in unchanged, so a same-named computed alias
// silently creates two identically-named columns in the CTE's output; Postgres only
// complains once something references that name ("column reference is ambiguous",
// 42702), which surfaced as a raw 500 on Register the first time
// `computed_last_date_of_transaction` (originally misnamed `last_date_of_transaction`,
// colliding with the real column of that name — see schema.sql) got a WHERE condition.
// Every alias below has been checked against the real column list; if you add a new one,
// check it again.
//
// The operator SQL-generation logic itself (text/number/date, blank/notBlank, the date
// relative buckets) lives in columnFilterCore.ts, shared with transferColumnFilters.ts —
// this file only supplies the Register-specific registry/SQL-map/labels.
export type ColumnFilterType = CoreColumnFilterType;
export type RawCondition = CoreRawCondition;

export const REGISTER_COLUMNS: Record<string, ColumnFilterType> = {
  farId: "text",
  subClassification: "text",
  dateAcquired: "date",
  location: "text",
  lastDateOfTransaction: "date",
  effectiveLocation: "text",
  serialNo: "text",
  parentFarId: "text",
  status: "text",
  assetDescription: "text",
  qty: "number",
  usefulLifeC1Years: "number",
  usefulLifeC2Years: "number",
  expiryDateC1: "date",
  expiryDateC2: "date",
  c1OpeningCost: "number",
  c2OpeningCost: "number",
  additionsC1: "number",
  additionsC2: "number",
  dateOfAddition: "date",
  dateOfDisposal: "date",
  deletionsC1: "number",
  deletionsC2: "number",
  saleValue: "number",
  c1GrossBlock: "number",
  c2GrossBlock: "number",
  accDepC1Opening: "number",
  accDepC2Opening: "number",
  c1PeriodDep: "number",
  c2PeriodDep: "number",
  accDepOnDisposedC1: "number",
  accDepOnDisposedC2: "number",
  c1AccDep: "number",
  c2AccDep: "number",
  c1Wdv: "number",
  c2Wdv: "number",
  totalWdv: "number",
  profitLoss: "number",
  c1NbvOpening: "number",
  c2NbvOpening: "number",
  c1Nbv: "number",
  c2Nbv: "number"
};

const COLUMN_SQL: Record<string, string> = {
  farId: "far_id",
  subClassification: "sub_classification",
  dateAcquired: "date_acquired",
  location: "location",
  lastDateOfTransaction: "computed_last_date_of_transaction",
  effectiveLocation: "effective_location",
  serialNo: "serial_no",
  parentFarId: "parent_far_id",
  status: "status",
  assetDescription: "asset_description",
  qty: "qty",
  usefulLifeC1Years: "useful_life_c1_years",
  usefulLifeC2Years: "useful_life_c2_years",
  expiryDateC1: "expiry_date_c1",
  expiryDateC2: "expiry_date_c2",
  c1OpeningCost: "(c1).opening_gross_block",
  c2OpeningCost: "(c2).opening_gross_block",
  additionsC1: "(c1).additions_gross_block",
  additionsC2: "(c2).additions_gross_block",
  dateOfAddition: "date_of_addition",
  dateOfDisposal: "date_of_disposal",
  deletionsC1: "deletions_c1",
  deletionsC2: "deletions_c2",
  saleValue: "sale_value",
  c1GrossBlock: "(c1).gross_block",
  c2GrossBlock: "(c2).gross_block",
  accDepC1Opening: "acc_dep_c1_opening",
  accDepC2Opening: "acc_dep_c2_opening",
  c1PeriodDep: "(c1).period_depreciation",
  c2PeriodDep: "(c2).period_depreciation",
  accDepOnDisposedC1: "(c1).acc_dep_on_disposed",
  accDepOnDisposedC2: "(c2).acc_dep_on_disposed",
  c1AccDep: "(c1).closing_acc_dep",
  c2AccDep: "(c2).closing_acc_dep",
  c1Wdv: "(c1).wdv_at_disposal",
  c2Wdv: "(c2).wdv_at_disposal",
  totalWdv: "total_wdv",
  profitLoss: "profit_loss",
  c1NbvOpening: "(c1).opening_nbv",
  c2NbvOpening: "(c2).opening_nbv",
  c1Nbv: "(c1).nbv",
  c2Nbv: "(c2).nbv"
};

// A JSON-encoded array in one query param (`conditions=<json>`) — see
// columnFilterCore.ts's makeConditionsQuerySchema. Capped at the column count.
export const conditionsQuerySchema = makeConditionsQuerySchema(Object.keys(REGISTER_COLUMNS).length);

/** Builds one SQL boolean expression for a single Register condition — see
 *  columnFilterCore.ts's makeConditionBuilder/buildConditionSqlCore for the actual
 *  operator SQL generation, shared with transferColumnFilters.ts. */
export const buildConditionSql = makeConditionBuilder(REGISTER_COLUMNS, COLUMN_SQL);

// SQL fragment appended to assets.ts's `calc` CTE, computing every filter-only column
// this registry can reference beyond the raw `assets.*` passthrough — the two
// far_calc_component() composites, plus the handful of derived fields
// (effective_location/computed_last_date_of_transaction/expiry dates/total_wdv/profit_loss) that
// exist in AssetGrid's column set but never had a SQL form until now. Every asAt/fy
// param below is pushed fresh (not indexed against the caller's existing params) —
// simpler than threading shared indices through, and cheap at this row count.
export function buildCalcCteExtras(params: unknown[], asAt: string, fy: { fyStart: string; fyEnd: string; daysInFy: number }): string {
  const c1 = `far_calc_component(c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years, date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, ${pushParam(params, asAt)}::date, ${pushParam(params, fy.fyStart)}::date, ${pushParam(params, fy.fyEnd)}::date, ${pushParam(params, fy.daysInFy)}::integer, date_acquired)`;
  const c2 = `far_calc_component(c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years, date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, ${pushParam(params, asAt)}::date, ${pushParam(params, fy.fyStart)}::date, ${pushParam(params, fy.fyEnd)}::date, ${pushParam(params, fy.daysInFy)}::integer, date_acquired)`;
  const disposalAsAt = pushParam(params, asAt);
  const additionAsAt = pushParam(params, asAt);
  const transferAsAt = pushParam(params, asAt);
  return `
    ${c1} AS c1,
    ${c2} AS c2,
    COALESCE(revised_location, location) AS effective_location,
    GREATEST(
      date_acquired,
      CASE WHEN date_of_addition IS NOT NULL AND date_of_addition <= ${additionAsAt}::date THEN date_of_addition ELSE date_acquired END,
      CASE WHEN date_of_disposal IS NOT NULL AND date_of_disposal <= ${disposalAsAt}::date THEN date_of_disposal ELSE date_acquired END,
      COALESCE(
        (SELECT MAX(t.transaction_date) FROM transfers t WHERE t.far_id = assets.far_id AND t.transaction_date <= ${transferAsAt}::date),
        date_acquired
      )
    -- NOT aliased "last_date_of_transaction" — the assets table already has a real,
    -- actively-maintained column by that exact name (schema.sql, updated by every
    -- transfer). SELECT assets.* pulls that raw column in unchanged; giving this
    -- computed value the same name silently produced two identically-named columns in
    -- the CTE's output, which Postgres only complains about once something actually
    -- references the name — "column reference is ambiguous" (42702), surfaced as a raw
    -- 500 the moment this column got its first WHERE-clause condition. The two aren't
    -- interchangeable, either: the raw column just tracks "latest transfer ever written"
    -- (never gated to AS_AT), while this GREATEST(...) is the correct, AS_AT-aware value
    -- that matches computeLastDateOfTransaction() and what Register's own "Last Txn
    -- Date" column displays — this one is the one filtering should use.
    ) AS computed_last_date_of_transaction,
    CASE WHEN useful_life_c1_years > 0 THEN
      (date_acquired + (FLOOR(useful_life_c1_years) || ' years')::interval + (ROUND((useful_life_c1_years - FLOOR(useful_life_c1_years)) * 365.25) || ' days')::interval)::date
    ELSE NULL END AS expiry_date_c1,
    CASE WHEN useful_life_c2_years > 0 THEN
      (date_acquired + (FLOOR(useful_life_c2_years) || ' years')::interval + (ROUND((useful_life_c2_years - FLOOR(useful_life_c2_years)) * 365.25) || ' days')::interval)::date
    ELSE NULL END AS expiry_date_c2
  `;
}

// Second pass, evaluated in the CTE's outer SELECT (not inside buildCalcCteExtras'
// FROM assets list) since it combines two already-computed c1/c2 composites rather than
// raw columns — see buildCalcCte in assets.ts for where this gets spliced in.
export const TOTAL_WDV_AND_PROFIT_LOSS_SQL = `
  CASE WHEN (c1).wdv_at_disposal IS NOT NULL AND (c2).wdv_at_disposal IS NOT NULL
    THEN (c1).wdv_at_disposal + (c2).wdv_at_disposal ELSE NULL END AS total_wdv,
  CASE WHEN (c1).wdv_at_disposal IS NOT NULL AND (c2).wdv_at_disposal IS NOT NULL
    THEN sale_value - ((c1).wdv_at_disposal + (c2).wdv_at_disposal) ELSE NULL END AS profit_loss
`;

// --- Plain-language filter descriptions, for the Register export's "what is this file"
// note (see assetsExport.ts). Mirrors RegisterPage.tsx's CONDITION_COLUMNS labels and
// DualModeFilterPanel column labels exactly — kept as a parallel definition (same
// no-shared-package convention as GROUP_INFO in assetsExport.ts) so the export's summary
// reads with the same names the user just saw on screen.
const COLUMN_LABELS: Record<string, string> = {
  farId: "FAR ID",
  subClassification: "Sub Classification",
  dateAcquired: "Date Acquired",
  location: "Capitalized Location",
  lastDateOfTransaction: "Last Transaction Date",
  effectiveLocation: "Current Location",
  serialNo: "Serial No",
  parentFarId: "Parent FAR ID",
  status: "Status",
  assetDescription: "Asset Description",
  qty: "Qty",
  usefulLifeC1Years: "Useful Life C1 (Years)",
  usefulLifeC2Years: "Useful Life C2 (Years)",
  expiryDateC1: "Expiry Date C1",
  expiryDateC2: "Expiry Date C2",
  c1OpeningCost: "C1 Opening Gross Block",
  c2OpeningCost: "C2 Opening Gross Block",
  additionsC1: "C1 Additions",
  additionsC2: "C2 Additions",
  dateOfAddition: "Addition Date",
  dateOfDisposal: "Disposal Date",
  deletionsC1: "C1 Deletions",
  deletionsC2: "C2 Deletions",
  saleValue: "Sale Value",
  c1GrossBlock: "C1 Gross Block",
  c2GrossBlock: "C2 Gross Block",
  accDepC1Opening: "C1 Opening Acc. Dep.",
  accDepC2Opening: "C2 Opening Acc. Dep.",
  c1PeriodDep: "C1 Depreciation (Period)",
  c2PeriodDep: "C2 Depreciation (Period)",
  accDepOnDisposedC1: "C1 Acc. Dep. on Disposed",
  accDepOnDisposedC2: "C2 Acc. Dep. on Disposed",
  c1AccDep: "C1 Acc. Dep.",
  c2AccDep: "C2 Acc. Dep.",
  c1Wdv: "C1 WDV",
  c2Wdv: "C2 WDV",
  totalWdv: "Total WDV",
  profitLoss: "Profit/(Loss) on Disposal",
  c1NbvOpening: "C1 Opening NBV",
  c2NbvOpening: "C2 Opening NBV",
  c1Nbv: "C1 NBV",
  c2Nbv: "C2 NBV"
};

// Number columns that are counts/rates, not money — everything else numeric in
// REGISTER_COLUMNS is a currency figure (cost, depreciation, NBV, WDV, ...).
const NON_MONEY_NUMBER_COLUMNS = new Set(["qty", "usefulLifeC1Years", "usefulLifeC2Years"]);

const rupeeFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function formatFilterDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function formatFilterNumber(columnId: string, raw: string | number | undefined): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? "");
  return NON_MONEY_NUMBER_COLUMNS.has(columnId) ? String(n) : rupeeFormatter.format(n);
}

const TEXT_OP_PHRASES: Record<string, string> = {
  equals: "is",
  notEquals: "is not",
  contains: "contains",
  notContains: "does not contain",
  beginsWith: "begins with",
  endsWith: "ends with",
  blank: "is blank",
  notBlank: "is not blank"
};

const NUMBER_OP_PHRASES: Record<string, string> = {
  equals: "equals",
  notEquals: "does not equal",
  gt: "greater than",
  gte: "greater than or equal to",
  lt: "less than",
  lte: "less than or equal to",
  blank: "is blank",
  notBlank: "is not blank"
};

const DATE_OP_PHRASES: Record<string, string> = {
  equals: "on",
  before: "before",
  after: "after",
  today: "today",
  thisWeek: "this week",
  thisMonth: "this month",
  thisFY: "this financial year",
  lastFY: "last financial year",
  blank: "is blank",
  notBlank: "is not blank"
};

/** One plain-English line per condition, e.g. "C1 NBV: greater than ₹2,00,000" or
 *  "Disposal Date: between 01-04-2026 and 30-06-2026" — for the export's filter-summary
 *  note. Falls back to the raw columnId/op if either isn't recognized (defensive only;
 *  buildConditionSql already rejects an unknown column/op pair before this ever runs on
 *  a real request). */
export function describeCondition(cond: RawCondition): string {
  const label = COLUMN_LABELS[cond.columnId] ?? cond.columnId;
  const type = REGISTER_COLUMNS[cond.columnId];

  if (type === "text") {
    const phrase = TEXT_OP_PHRASES[cond.op] ?? cond.op;
    if (cond.op === "blank" || cond.op === "notBlank") return `${label}: ${phrase}`;
    return `${label}: ${phrase} "${cond.value ?? ""}"`;
  }
  if (type === "number") {
    const phrase = NUMBER_OP_PHRASES[cond.op];
    if (cond.op === "blank" || cond.op === "notBlank") return `${label}: ${phrase}`;
    if (cond.op === "between") {
      return `${label}: between ${formatFilterNumber(cond.columnId, cond.value)} and ${formatFilterNumber(cond.columnId, cond.valueTo)}`;
    }
    return `${label}: ${phrase ?? cond.op} ${formatFilterNumber(cond.columnId, cond.value)}`;
  }
  // date
  const phrase = DATE_OP_PHRASES[cond.op];
  if (cond.op === "blank" || cond.op === "notBlank" || cond.op === "today" || cond.op === "thisWeek" || cond.op === "thisMonth" || cond.op === "thisFY" || cond.op === "lastFY") {
    return `${label}: ${phrase ?? cond.op}`;
  }
  if (cond.op === "between") {
    return `${label}: between ${formatFilterDate(String(cond.value ?? ""))} and ${formatFilterDate(String(cond.valueTo ?? ""))}`;
  }
  return `${label}: ${phrase ?? cond.op} ${formatFilterDate(String(cond.value ?? ""))}`;
}

/** The subset of a Register/export query's named (non-`conditions`) filters that are
 *  worth describing in the export note — mirrors the fields RegisterPage's UI can
 *  actually set (center, capLocation, subClassification, status, globalSearch) plus the
 *  older search/descriptionSearch/dateAcquiredFrom/dateAcquiredTo fields, kept for any
 *  caller that still sends them directly (e.g. a saved link from before this round). */
export interface NamedFilterQuery {
  center?: string[];
  capLocation?: string[];
  subClassification?: string[];
  status?: string[];
  dateAcquiredFrom?: string;
  dateAcquiredTo?: string;
  search?: string;
  descriptionSearch?: string;
  globalSearch?: string;
}

function describeNamedFilters(q: NamedFilterQuery): string[] {
  const lines: string[] = [];
  if (q.center?.length) lines.push(`Current Location: ${q.center.join(", ")}`);
  if (q.capLocation?.length) lines.push(`Capitalized Location: ${q.capLocation.join(", ")}`);
  if (q.subClassification?.length) lines.push(`Sub Classification: ${q.subClassification.join(", ")}`);
  if (q.status?.length) lines.push(`Status: ${q.status.join(", ")}`);
  if (q.dateAcquiredFrom || q.dateAcquiredTo) {
    if (q.dateAcquiredFrom && q.dateAcquiredTo) {
      lines.push(`Date Acquired: between ${formatFilterDate(q.dateAcquiredFrom)} and ${formatFilterDate(q.dateAcquiredTo)}`);
    } else if (q.dateAcquiredFrom) {
      lines.push(`Date Acquired: after ${formatFilterDate(q.dateAcquiredFrom)}`);
    } else {
      lines.push(`Date Acquired: before ${formatFilterDate(q.dateAcquiredTo!)}`);
    }
  }
  if (q.search) lines.push(`FAR ID: begins with "${q.search}"`);
  if (q.descriptionSearch) lines.push(`Asset Description: contains "${q.descriptionSearch}"`);
  if (q.globalSearch) lines.push(`Search: "${q.globalSearch}"`);
  return lines;
}

/** Full "Filters applied: ..." line for the export note, plus "No filters applied" when
 *  nothing is active — see assetsExport.ts for where this gets written into the sheet.
 *  Pure/no I/O, so it's directly unit-testable without a database. */
export function buildFilterSummaryText(q: NamedFilterQuery, conditions: RawCondition[]): string {
  const lines = [...describeNamedFilters(q), ...conditions.map(describeCondition)];
  return lines.length > 0 ? lines.join("; ") : "No filters applied";
}
