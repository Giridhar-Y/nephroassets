import { describe, expect, it } from "vitest";
import { buildConditionSql, buildFilterSummaryText, conditionsQuerySchema, describeCondition } from "./assetColumnFilters.js";

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

  // D365-style "is any of" — the paste-multiple-values feature. value is an array only
  // for this op; every other op above still sends (and still gets tested with) a plain
  // string, so this is additive.
  it("in binds an array param for = ANY(...)", () => {
    const params: unknown[] = [];
    const built = buildConditionSql({ columnId: "farId", op: "in", value: ["FAR-1", "FAR-2", "FAR-3"] }, params, FY);
    expect(built).toEqual({ sql: "far_id = ANY($1)" });
    expect(params).toEqual([["FAR-1", "FAR-2", "FAR-3"]]);
  });

  it("in rejects an empty or missing list rather than matching everything", () => {
    expect(buildConditionSql({ columnId: "farId", op: "in", value: [] }, [], FY)).toHaveProperty("error");
    expect(buildConditionSql({ columnId: "farId", op: "in" }, [], FY)).toHaveProperty("error");
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

  it("in coerces every list entry to a number and binds the array", () => {
    const params: unknown[] = [];
    const built = buildConditionSql({ columnId: "qty", op: "in", value: [1, "2", 3] }, params, FY);
    expect(built).toEqual({ sql: "qty = ANY($1)" });
    expect(params).toEqual([[1, 2, 3]]);
  });

  it("in rejects a list with a non-numeric entry", () => {
    const built = buildConditionSql({ columnId: "qty", op: "in", value: ["1", "not-a-number"] }, [], FY);
    expect(built).toHaveProperty("error");
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

describe("buildConditionSql: lastDateOfTransaction (regression — its SQL alias must never collide with the real `assets.last_date_of_transaction` column)", () => {
  it("resolves to the computed alias, not the raw denormalized column of the same name", () => {
    const built = buildConditionSql({ columnId: "lastDateOfTransaction", op: "after", value: "2026-01-01" }, [], FY);
    expect(built).toEqual({ sql: "computed_last_date_of_transaction > $1::date" });
    // The bug this pins: `assets` has its own real `last_date_of_transaction` column
    // (schema.sql) — resolving to that bare name here would make `SELECT assets.*`
    // (which pulls the raw column in unchanged) collide with the computed alias
    // buildCalcCteExtras defines, and Postgres rejects any later reference to it as
    // ambiguous (42702). This assertion fails immediately if that alias is ever renamed
    // back without checking for the collision again.
    expect((built as { sql: string }).sql).not.toContain(" last_date_of_transaction ");
    expect((built as { sql: string }).sql.startsWith("last_date_of_transaction")).toBe(false);
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

  // Regression coverage for the "in" op's schema change: value went from string|number
  // to string|number|(string|number)[] — an OLD saved link/condition with a plain scalar
  // value (every op except "in") must still parse exactly as before.
  it("still parses a plain scalar value (a saved link from before the 'in' op existed)", () => {
    const result = conditionsQuerySchema.safeParse(JSON.stringify([{ columnId: "c1Nbv", op: "gt", value: 500000 }]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([{ columnId: "c1Nbv", op: "gt", value: 500000 }]);
  });

  it("parses an array value for the 'in' op", () => {
    const result = conditionsQuerySchema.safeParse(JSON.stringify([{ columnId: "farId", op: "in", value: ["FAR-1", "FAR-2"] }]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([{ columnId: "farId", op: "in", value: ["FAR-1", "FAR-2"] }]);
  });

  it("rejects an 'in' list past the 500-value cap", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `FAR-${i}`);
    const result = conditionsQuerySchema.safeParse(JSON.stringify([{ columnId: "farId", op: "in", value: tooMany }]));
    expect(result.success).toBe(false);
  });
});

describe("describeCondition: plain-language filter descriptions for the export note", () => {
  it("text: equals/notEquals quote the value", () => {
    expect(describeCondition({ columnId: "status", op: "equals", value: "Active" })).toBe('Status: is "Active"');
    expect(describeCondition({ columnId: "status", op: "notEquals", value: "Active" })).toBe('Status: is not "Active"');
  });

  it("text: contains/beginsWith/endsWith", () => {
    expect(describeCondition({ columnId: "assetDescription", op: "contains", value: "pump" })).toBe(
      'Asset Description: contains "pump"'
    );
    expect(describeCondition({ columnId: "farId", op: "beginsWith", value: "FAR-0" })).toBe('FAR ID: begins with "FAR-0"');
  });

  it("text: blank/notBlank need no quoted value", () => {
    expect(describeCondition({ columnId: "serialNo", op: "blank" })).toBe("Serial No: is blank");
    expect(describeCondition({ columnId: "serialNo", op: "notBlank" })).toBe("Serial No: is not blank");
  });

  it("text: in lists every value when short, truncates with a count when long", () => {
    expect(describeCondition({ columnId: "farId", op: "in", value: ["FAR-1", "FAR-2"] })).toBe("FAR ID: is any of FAR-1, FAR-2");
    const many = Array.from({ length: 6 }, (_, i) => `FAR-${i}`);
    expect(describeCondition({ columnId: "farId", op: "in", value: many })).toBe(
      "FAR ID: is any of FAR-0, FAR-1, FAR-2, FAR-3 and 2 more"
    );
  });

  it("number: in formats every value like a single equals would", () => {
    expect(describeCondition({ columnId: "c1Nbv", op: "in", value: [100000, 200000] })).toBe(
      "C1 NBV: is any of ₹1,00,000, ₹2,00,000"
    );
  });

  it("number: money columns format as Indian-grouped rupees", () => {
    expect(describeCondition({ columnId: "c1Nbv", op: "gt", value: "200000" })).toBe("C1 NBV: greater than ₹2,00,000");
    expect(describeCondition({ columnId: "saleValue", op: "lte", value: "50000" })).toBe(
      "Sale Value: less than or equal to ₹50,000"
    );
  });

  it("number: non-money columns (Qty, Useful Life) stay plain numbers, no rupee symbol", () => {
    expect(describeCondition({ columnId: "qty", op: "gte", value: "5" })).toBe("Qty: greater than or equal to 5");
    expect(describeCondition({ columnId: "usefulLifeC1Years", op: "equals", value: "10" })).toBe(
      "Useful Life C1 (Years): equals 10"
    );
  });

  it("number: between formats both bounds", () => {
    expect(describeCondition({ columnId: "c1OpeningCost", op: "between", value: "10000", valueTo: "50000" })).toBe(
      "C1 Opening Gross Block: between ₹10,000 and ₹50,000"
    );
  });

  it("date: on/before/after format as DD-MM-YYYY", () => {
    expect(describeCondition({ columnId: "dateAcquired", op: "equals", value: "2026-01-15" })).toBe(
      "Date Acquired: on 15-01-2026"
    );
    expect(describeCondition({ columnId: "dateOfDisposal", op: "before", value: "2026-01-15" })).toBe(
      "Disposal Date: before 15-01-2026"
    );
  });

  it("date: between formats both bounds", () => {
    expect(describeCondition({ columnId: "dateOfAddition", op: "between", value: "2026-04-01", valueTo: "2026-06-30" })).toBe(
      "Addition Date: between 01-04-2026 and 30-06-2026"
    );
  });

  it("date: relative buckets and blank/notBlank need no value", () => {
    expect(describeCondition({ columnId: "dateAcquired", op: "thisFY" })).toBe("Date Acquired: this financial year");
    expect(describeCondition({ columnId: "dateAcquired", op: "lastFY" })).toBe("Date Acquired: last financial year");
    expect(describeCondition({ columnId: "dateOfDisposal", op: "notBlank" })).toBe("Disposal Date: is not blank");
  });
});

describe("buildFilterSummaryText: the export note's full summary line", () => {
  it("says 'No filters applied' when nothing is active", () => {
    expect(buildFilterSummaryText({}, [])).toBe("No filters applied");
  });

  it("describes named (non-condition) filters", () => {
    expect(buildFilterSummaryText({ status: ["Active", "Disposed"] }, [])).toBe("Status: Active, Disposed");
    expect(buildFilterSummaryText({ center: ["Center-A"] }, [])).toBe("Current Location: Center-A");
    expect(buildFilterSummaryText({ globalSearch: "dialysis" }, [])).toBe('Search: "dialysis"');
  });

  it("describes a Date Acquired range using whichever bound(s) are set", () => {
    expect(buildFilterSummaryText({ dateAcquiredFrom: "2026-04-01", dateAcquiredTo: "2026-06-30" }, [])).toBe(
      "Date Acquired: between 01-04-2026 and 30-06-2026"
    );
    expect(buildFilterSummaryText({ dateAcquiredFrom: "2026-04-01" }, [])).toBe("Date Acquired: after 01-04-2026");
    expect(buildFilterSummaryText({ dateAcquiredTo: "2026-06-30" }, [])).toBe("Date Acquired: before 30-06-2026");
  });

  it("combines named filters and conditions, semicolon-separated, in that order", () => {
    const text = buildFilterSummaryText({ status: ["Active"] }, [{ columnId: "c1Nbv", op: "gt", value: "200000" }]);
    expect(text).toBe("Status: Active; C1 NBV: greater than ₹2,00,000");
  });
});
