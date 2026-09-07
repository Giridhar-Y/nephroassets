// Excel-style per-column custom filter conditions — the client-side mirror of
// server/src/routes/assetColumnFilters.ts's operator sets. Kept as plain string unions
// (not a shared package — client/server are separate TS builds, same convention as
// columns.ts's own comment about assetsExport.ts's parallel column list) so the server
// is the single source of truth for which operator does what; this file only needs to
// agree on the *names*.
export type TextFilterOp =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "beginsWith"
  | "endsWith"
  | "blank"
  | "notBlank";

export type NumberFilterOp = "equals" | "notEquals" | "gt" | "gte" | "lt" | "lte" | "between" | "blank" | "notBlank";

export type DateFilterOp =
  | "equals"
  | "before"
  | "after"
  | "between"
  | "today"
  | "thisWeek"
  | "thisMonth"
  | "thisFY"
  | "lastFY"
  | "blank"
  | "notBlank";

export type ColumnFilterType = "text" | "number" | "date";

export interface ColumnCondition {
  columnId: string;
  type: ColumnFilterType;
  op: TextFilterOp | NumberFilterOp | DateFilterOp;
  value?: string;
  valueTo?: string;
}

export const TEXT_OPERATORS: Array<{ value: TextFilterOp; label: string }> = [
  { value: "equals", label: "Equals" },
  { value: "notEquals", label: "Does not equal" },
  { value: "contains", label: "Contains" },
  { value: "notContains", label: "Does not contain" },
  { value: "beginsWith", label: "Begins with" },
  { value: "endsWith", label: "Ends with" },
  { value: "blank", label: "Blank" },
  { value: "notBlank", label: "Not blank" }
];

export const NUMBER_OPERATORS: Array<{ value: NumberFilterOp; label: string }> = [
  { value: "equals", label: "Equals" },
  { value: "notEquals", label: "Does not equal" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "Greater than or equal to" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "Less than or equal to" },
  { value: "between", label: "Between" },
  { value: "blank", label: "Blank" },
  { value: "notBlank", label: "Not blank" }
];

export const DATE_OPERATORS: Array<{ value: DateFilterOp; label: string }> = [
  { value: "equals", label: "On" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "between", label: "Between" },
  { value: "today", label: "Today" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "thisFY", label: "This financial year" },
  { value: "lastFY", label: "Last financial year" },
  { value: "blank", label: "Blank" },
  { value: "notBlank", label: "Not blank" }
];

export const OPERATORS_BY_TYPE: Record<ColumnFilterType, Array<{ value: ColumnCondition["op"]; label: string }>> = {
  text: TEXT_OPERATORS,
  number: NUMBER_OPERATORS,
  date: DATE_OPERATORS
};

/** Operators that take no value at all — the condition is complete the moment one of
 *  these is picked. */
export const NO_VALUE_OPS = new Set<string>(["blank", "notBlank", "today", "thisWeek", "thisMonth", "thisFY", "lastFY"]);

/** Operators that take two values (a range). */
export const TWO_VALUE_OPS = new Set<string>(["between"]);

/** A condition is only worth sending to the server once it has everything its operator
 *  needs — an operator picked mid-typing with no value yet (or a `between` missing its
 *  second value) is a draft, not a filter, and gets dropped rather than sent as a
 *  vacuous/broken WHERE clause. */
export function isConditionComplete(c: ColumnCondition | undefined): c is ColumnCondition {
  if (!c) return false;
  if (NO_VALUE_OPS.has(c.op)) return true;
  if (c.value === undefined || c.value === "") return false;
  if (TWO_VALUE_OPS.has(c.op) && (c.valueTo === undefined || c.valueTo === "")) return false;
  return true;
}
