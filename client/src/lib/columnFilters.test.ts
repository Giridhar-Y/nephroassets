import { describe, expect, it } from "vitest";
import { isConditionComplete, type ColumnCondition } from "./columnFilters.js";

function cond(patch: Partial<ColumnCondition>): ColumnCondition {
  return { columnId: "farId", type: "text", op: "equals", ...patch };
}

describe("isConditionComplete", () => {
  it("is false for undefined — no condition drafted yet", () => {
    expect(isConditionComplete(undefined)).toBe(false);
  });

  it("a no-value operator (blank, today, ...) is complete the moment it's picked", () => {
    expect(isConditionComplete(cond({ op: "blank" }))).toBe(true);
    expect(isConditionComplete(cond({ op: "notBlank" }))).toBe(true);
    expect(isConditionComplete(cond({ type: "date", op: "today" }))).toBe(true);
    expect(isConditionComplete(cond({ type: "date", op: "thisFY" }))).toBe(true);
  });

  it("a single-value operator needs a non-empty value", () => {
    expect(isConditionComplete(cond({ op: "equals" }))).toBe(false);
    expect(isConditionComplete(cond({ op: "equals", value: "" }))).toBe(false);
    expect(isConditionComplete(cond({ op: "equals", value: "FAR-1" }))).toBe(true);
  });

  it("between needs both value and valueTo", () => {
    expect(isConditionComplete(cond({ type: "number", op: "between", value: "10" }))).toBe(false);
    expect(isConditionComplete(cond({ type: "number", op: "between", value: "10", valueTo: "" }))).toBe(false);
    expect(isConditionComplete(cond({ type: "number", op: "between", value: "10", valueTo: "20" }))).toBe(true);
  });
});
