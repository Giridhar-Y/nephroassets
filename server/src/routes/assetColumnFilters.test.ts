import { describe, expect, it } from "vitest";
import { buildConditionSql, conditionsQuerySchema } from "./assetColumnFilters.js";

const FY = { fyStart: "2026-04-01", fyEnd: "2027-03-31" };

describe("buildConditionSql: text operators", () => {
  it("equals binds the raw value", () => {
    const params: unknown[] = [];
    const built = buildConditionSql({ columnId: "farId", op: "equals", value: "FAR-1" }, params, FY);
    expect(built).toEqual({ sql: "far_id = $1" });
    expect(params).toEqual(["FAR-1"]);
  });

  it("notEquals uses IS DISTINCT FROM so a NULL column still counts as not-equal", () => {
    const params: unknown[] = [];
    const built = buildConditionSql({ columnId: "parentFarId", op: "notEquals", value: "P-1" }, params, FY);
    expect(built).toEqual({ sql: "parent_far_id IS DISTINCT FROM $1" });
  });

  it("contains/notContains/beginsWith/endsWith wrap the value with wildcards", () => {
    const params: unknown[] = [];
    expect(buildConditionSql({ columnId: "assetDescription", op: "contains", value: "pump" }, params, FY)).toEqual({
      sql: "asset_description ILIKE $1"
    });
    expect(params).toEqual(["%pump%"]);

    const params2: unknown[] = [];
    expect(buildConditionSql({ columnId: "assetDescription", op: "beginsWith", value: "Dia" }, params2, FY)).toEqual({
      sql: "asset_description ILIKE $1"
    });
    expect(params2).toEqual(["Dia%"]);

    const params3: unknown[] = [];
    expect(buildConditionSql({ columnId: "assetDescription", op: "endsWith", value: "Machine" }, params3, FY)).toEqual({
      sql: "asset_description ILIKE $1"
    });
    expect(params3).toEqual(["%Machine"]);
  });

  it("blank/notBlank treat both NULL and empty string as blank", () => {
    const params: unknown[] = [];
    expect(buildConditionSql({ columnId: "serialNo", op: "blank" }, params, FY)).toEqual({
      sql: "(serial_no IS NULL OR serial_no = '')"
    });
    expect(buildConditionSql({ columnId: "serialNo", op: "notBlank" }, params, FY)).toEqual({
      sql: "(serial_no IS NOT NULL AND serial_no <> '')"
    });
    expect(params).toEqual([]);
  });

  it("rejects a number-only operator on a text column", () => {
    const built = buildConditionSql({ columnId: "farId", op: "gt", value: "1" }, [], FY);
    expect(built).toHaveProperty("error");
  });
});

describe("buildConditionSql: number operators", () => {
  it("between pushes both bounds in order", () => {
    const params: unknown[] = [];
    const built = buildConditionSql({ columnId: "c1Nbv", op: "between", value: "1000", valueTo: "5000" }, params, FY);
    expect(built).toEqual({ sql: "(c1).nbv BETWEEN $1 AND $2" });
    expect(params).toEqual([1000, 5000]);
  });

  it("rejects a non-numeric value", () => {
    const built = buildConditionSql({ columnId: "qty", op: "equals", value: "not-a-number" }, [], FY);
    expect(built).toHaveProperty("error");
  });

  it("blank/notBlank need no value — for nullable computed fields like WDV on a non-disposed asset", () => {
    const params: unknown[] = [];
    expect(buildConditionSql({ columnId: "c1Wdv", op: "blank" }, params, FY)).toEqual({ sql: "(c1).wdv_at_disposal IS NULL" });
    expect(params).toEqual([]);
  });

  it("gt/gte/lt/lte map to the matching SQL operator", () => {
    expect(buildConditionSql({ columnId: "qty", op: "gt", value: "5" }, [], FY)).toEqual({ sql: "qty > $1" });
    expect(buildConditionSql({ columnId: "qty", op: "gte", value: "5" }, [], FY)).toEqual({ sql: "qty >= $1" });
    expect(buildConditionSql({ columnId: "qty", op: "lt", value: "5" }, [], FY)).toEqual({ sql: "qty < $1" });
    expect(buildConditionSql({ columnId: "qty", op: "lte", value: "5" }, [], FY)).toEqual({ sql: "qty <= $1" });
  });
});

describe("buildConditionSql: date operators", () => {
  it("equals/before/after cast to ::date", () => {
    expect(buildConditionSql({ columnId: "dateAcquired", op: "equals", value: "2026-01-01" }, [], FY)).toEqual({
      sql: "date_acquired = $1::date"
    });
    expect(buildConditionSql({ columnId: "dateAcquired", op: "before", value: "2026-01-01" }, [], FY)).toEqual({
      sql: "date_acquired < $1::date"
    });
    expect(buildConditionSql({ columnId: "dateAcquired", op: "after", value: "2026-01-01" }, [], FY)).toEqual({
      sql: "date_acquired > $1::date"
    });
  });

  it("rejects a malformed date value", () => {
    const built = buildConditionSql({ columnId: "dateAcquired", op: "equals", value: "01/01/2026" }, [], FY);
    expect(built).toHaveProperty("error");
  });

  it("thisFY/lastFY bind the current FY's own bounds, offsetting lastFY by a year", () => {
    const params: unknown[] = [];
    const thisFy = buildConditionSql({ columnId: "dateAcquired", op: "thisFY" }, params, FY);
    expect(thisFy).toEqual({ sql: "date_acquired BETWEEN $1::date AND $2::date" });
    expect(params).toEqual([FY.fyStart, FY.fyEnd]);

    const params2: unknown[] = [];
    const lastFy = buildConditionSql({ columnId: "dateAcquired", op: "lastFY" }, params2, FY);
    expect(lastFy).toEqual({
      sql: "date_acquired BETWEEN ($1::date - INTERVAL '1 year')::date AND ($2::date - INTERVAL '1 year')::date"
    });
    expect(params2).toEqual([FY.fyStart, FY.fyEnd]);
  });

  it("today/thisWeek/thisMonth need no bound params at all", () => {
    for (const op of ["today", "thisWeek", "thisMonth"] as const) {
      const params: unknown[] = [];
      const built = buildConditionSql({ columnId: "dateAcquired", op }, params, FY);
      expect(built).not.toHaveProperty("error");
      expect(params).toEqual([]);
    }
  });
});

describe("buildConditionSql: unknown column", () => {
  it("reports an error rather than building a SQL fragment for an unrecognized columnId", () => {
    const built = buildConditionSql({ columnId: "notARealColumn", op: "equals", value: "x" }, [], FY);
    expect(built).toEqual({ error: 'Unknown filter column "notARealColumn".' });
  });
});

describe("conditionsQuerySchema", () => {
  it("parses a JSON-encoded array from the query string", () => {
    const result = conditionsQuerySchema.safeParse(JSON.stringify([{ columnId: "farId", op: "equals", value: "FAR-1" }]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([{ columnId: "farId", op: "equals", value: "FAR-1" }]);
  });

  it("defaults to an empty array when omitted", () => {
    const result = conditionsQuerySchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    const result = conditionsQuerySchema.safeParse("{not json");
    expect(result.success).toBe(false);
  });

  it("rejects a non-array payload", () => {
    const result = conditionsQuerySchema.safeParse(JSON.stringify({ columnId: "farId" }));
    expect(result.success).toBe(false);
  });
});
