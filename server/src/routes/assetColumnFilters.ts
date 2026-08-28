import { z } from "zod";

// Excel-style per-column custom filter conditions for Register — every column in
// client/src/lib/columns.ts's ALL_COLUMNS gets an entry here. `sql` is a raw SQL
// expression valid inside assets.ts's `calc` CTE, which exposes every raw `assets`
// column unchanged (via SELECT assets.*) plus these computed aliases: `c1`/`c2` (the
// two far_calc_component() composites), `effective_location`, `last_date_of_transaction`,
// `expiry_date_c1`/`expiry_date_c2`, `total_wdv`, `profit_loss` — see buildCalcCte there.
//
// This is filter-only: it decides which rows match, never what's displayed. The
// response body is still built from mapAssetRow() + computeAsset() exactly as before —
// two independent (but sqlParity.test.ts-verified-consistent) implementations of the
// same math, kept that way deliberately so a filtering change here can never alter a
// displayed figure.
export type ColumnFilterType = "text" | "number" | "date";

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
  lastDateOfTransaction: "last_date_of_transaction",
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

const rawConditionSchema = z.object({
  columnId: z.string(),
  op: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
  valueTo: z.union([z.string(), z.number()]).optional()
});
export type RawCondition = z.infer<typeof rawConditionSchema>;

// A JSON-encoded array in one query param (`conditions=<json>`), same idea as the
// existing comma-joined multi-value params but for structured objects a flat string
// can't represent. Capped at the column count — there's never a legitimate reason to
// send more than one condition per column.
export const conditionsQuerySchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (!raw) return [] as RawCondition[];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "conditions must be valid JSON." });
      return z.NEVER;
    }
    const result = z.array(rawConditionSchema).max(Object.keys(REGISTER_COLUMNS).length).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "conditions must be an array of {columnId, op, value?, valueTo?}." });
      return z.NEVER;
    }
    return result.data;
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/** Builds one SQL boolean expression for a single condition, pushing any bind values
 *  onto `params` (which already has earlier params on it — indices continue from
 *  wherever the caller's params array currently stands). Returns an error message
 *  instead of throwing so the route can turn it into a 400 with normal control flow. */
export function buildConditionSql(
  cond: RawCondition,
  params: unknown[],
  fy: { fyStart: string; fyEnd: string }
): { sql: string } | { error: string } {
  const type = REGISTER_COLUMNS[cond.columnId];
  if (!type) return { error: `Unknown filter column "${cond.columnId}".` };
  const sql = COLUMN_SQL[cond.columnId]!;
  return buildTyped(type, sql, cond, params, fy);
}

function buildTyped(
  type: ColumnFilterType,
  sql: string,
  cond: RawCondition,
  params: unknown[],
  fy: { fyStart: string; fyEnd: string }
): { sql: string } | { error: string } {
  if (cond.op === "blank") return { sql: type === "text" ? `(${sql} IS NULL OR ${sql} = '')` : `${sql} IS NULL` };
  if (cond.op === "notBlank") return { sql: type === "text" ? `(${sql} IS NOT NULL AND ${sql} <> '')` : `${sql} IS NOT NULL` };

  if (type === "text") {
    const v = String(cond.value ?? "");
    switch (cond.op) {
      case "equals":
        return { sql: `${sql} = ${pushParam(params, v)}` };
      case "notEquals":
        return { sql: `${sql} IS DISTINCT FROM ${pushParam(params, v)}` };
      case "contains":
        return { sql: `${sql} ILIKE ${pushParam(params, `%${v}%`)}` };
      case "notContains":
        return { sql: `COALESCE(${sql}, '') NOT ILIKE ${pushParam(params, `%${v}%`)}` };
      case "beginsWith":
        return { sql: `${sql} ILIKE ${pushParam(params, `${v}%`)}` };
      case "endsWith":
        return { sql: `${sql} ILIKE ${pushParam(params, `%${v}`)}` };
      default:
        return { error: `Unsupported text filter operator "${cond.op}" for column "${cond.columnId}".` };
    }
  }

  if (type === "number") {
    const n = Number(cond.value);
    if (!Number.isFinite(n)) return { error: `Invalid numeric value for column "${cond.columnId}".` };
    switch (cond.op) {
      case "equals":
        return { sql: `${sql} = ${pushParam(params, n)}` };
      case "notEquals":
        return { sql: `${sql} IS DISTINCT FROM ${pushParam(params, n)}` };
      case "gt":
        return { sql: `${sql} > ${pushParam(params, n)}` };
      case "gte":
        return { sql: `${sql} >= ${pushParam(params, n)}` };
      case "lt":
        return { sql: `${sql} < ${pushParam(params, n)}` };
      case "lte":
        return { sql: `${sql} <= ${pushParam(params, n)}` };
      case "between": {
        const n2 = Number(cond.valueTo);
        if (!Number.isFinite(n2)) return { error: `Invalid "to" value for column "${cond.columnId}".` };
        return { sql: `${sql} BETWEEN ${pushParam(params, n)} AND ${pushParam(params, n2)}` };
      }
      default:
        return { error: `Unsupported number filter operator "${cond.op}" for column "${cond.columnId}".` };
    }
  }

  // date
  switch (cond.op) {
    case "today":
      return { sql: `${sql} = CURRENT_DATE` };
    case "thisWeek":
      return { sql: `${sql} BETWEEN date_trunc('week', CURRENT_DATE)::date AND (date_trunc('week', CURRENT_DATE) + INTERVAL '6 days')::date` };
    case "thisMonth":
      return { sql: `${sql} BETWEEN date_trunc('month', CURRENT_DATE)::date AND (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::date` };
    case "thisFY":
      return { sql: `${sql} BETWEEN ${pushParam(params, fy.fyStart)}::date AND ${pushParam(params, fy.fyEnd)}::date` };
    case "lastFY":
      // FY-anchored one year back, e.g. FY 2026-27 -> FY 2025-26 — matches this app's
      // fixed one-year FY convention (fyStart/fyEnd are always a year apart).
      return {
        sql: `${sql} BETWEEN (${pushParam(params, fy.fyStart)}::date - INTERVAL '1 year')::date AND (${pushParam(params, fy.fyEnd)}::date - INTERVAL '1 year')::date`
      };
  }
  const dateStr = z.string().regex(DATE_RE).safeParse(cond.value);
  if (!dateStr.success) return { error: `Invalid date value for column "${cond.columnId}".` };
  switch (cond.op) {
    case "equals":
      return { sql: `${sql} = ${pushParam(params, dateStr.data)}::date` };
    case "before":
      return { sql: `${sql} < ${pushParam(params, dateStr.data)}::date` };
    case "after":
      return { sql: `${sql} > ${pushParam(params, dateStr.data)}::date` };
    case "between": {
      const toStr = z.string().regex(DATE_RE).safeParse(cond.valueTo);
      if (!toStr.success) return { error: `Invalid "to" date for column "${cond.columnId}".` };
      return { sql: `${sql} BETWEEN ${pushParam(params, dateStr.data)}::date AND ${pushParam(params, toStr.data)}::date` };
    }
    default:
      return { error: `Unsupported date filter operator "${cond.op}" for column "${cond.columnId}".` };
  }
}

// SQL fragment appended to assets.ts's `calc` CTE, computing every filter-only column
// this registry can reference beyond the raw `assets.*` passthrough — the two
// far_calc_component() composites, plus the handful of derived fields
// (effective_location/last_date_of_transaction/expiry dates/total_wdv/profit_loss) that
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
    ) AS last_date_of_transaction,
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
