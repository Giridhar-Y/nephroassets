import { z } from "zod";

// Registry-agnostic core of the Excel-style column-condition filtering used by both
// Register (assetColumnFilters.ts) and the Transfer Log (transferColumnFilters.ts) —
// the operator SQL-generation logic here has nothing Register-specific about it, it
// just turns {columnId, op, value} + a resolved SQL expression into a WHERE fragment.
// Extracted out once a second caller needed the exact same operator set, rather than
// hand-copying ~150 lines of text/number/date SQL generation a second time — that kind
// of duplication is exactly how the two implementations would quietly drift (a fixed
// bug in one, still present in the other).
export type ColumnFilterType = "text" | "number" | "date";

const rawConditionSchema = z.object({
  columnId: z.string(),
  op: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
  valueTo: z.union([z.string(), z.number()]).optional()
});
export type RawCondition = z.infer<typeof rawConditionSchema>;

/** A JSON-encoded array in one query param (`conditions=<json>`), same idea as the
 *  comma-joined multi-value params elsewhere but for structured objects a flat string
 *  can't represent. `maxConditions` should be the caller's own column count — there's
 *  never a legitimate reason to send more than one condition per column. */
export function makeConditionsQuerySchema(maxConditions: number) {
  return z
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
      const result = z.array(rawConditionSchema).max(maxConditions).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "conditions must be an array of {columnId, op, value?, valueTo?}." });
        return z.NEVER;
      }
      return result.data;
    });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/** Builds one SQL boolean expression for a single condition, given the column's already
 *  -resolved `type` and `sql` expression — pushes any bind values onto `params` (which
 *  may already have earlier params on it; indices continue from wherever it currently
 *  stands). Returns an error message instead of throwing so the caller's route can turn
 *  it into a 400 with normal control flow. */
export function buildConditionSqlCore(
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

/** Wires a plain `{columnId: type}` registry + `{columnId: sqlExpression}` map into a
 *  `buildConditionSql`-shaped function, the way both assetColumnFilters.ts and
 *  transferColumnFilters.ts want to expose it. Looks up the column, then delegates the
 *  actual operator SQL to buildConditionSqlCore above. */
export function makeConditionBuilder(registry: Record<string, ColumnFilterType>, sqlMap: Record<string, string>) {
  return function buildConditionSql(
    cond: RawCondition,
    params: unknown[],
    fy: { fyStart: string; fyEnd: string }
  ): { sql: string } | { error: string } {
    const type = registry[cond.columnId];
    if (!type) return { error: `Unknown filter column "${cond.columnId}".` };
    const sql = sqlMap[cond.columnId]!;
    return buildConditionSqlCore(type, sql, cond, params, fy);
  };
}
