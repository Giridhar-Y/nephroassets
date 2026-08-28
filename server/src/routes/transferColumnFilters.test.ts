import { describe, expect, it } from "vitest";
import { buildTransferConditionSql, TRANSFER_COLUMNS, transferConditionsQuerySchema } from "./transferColumnFilters.js";

const FY = { fyStart: "2026-04-01", fyEnd: "2027-03-31" };

describe("buildTransferConditionSql: resolves every Transfer Log column to its own, non-colliding SQL expression", () => {
  it("farId / assetDescription / transactionDate / fromLocation / toLocation", () => {
    expect(buildTransferConditionSql({ columnId: "farId", op: "beginsWith", value: "FAR-0" }, [], FY)).toEqual({
      sql: "far_id ILIKE $1"
    });
    expect(buildTransferConditionSql({ columnId: "assetDescription", op: "contains", value: "pump" }, [], FY)).toEqual({
      sql: "asset_description ILIKE $1"
    });
    expect(buildTransferConditionSql({ columnId: "transactionDate", op: "after", value: "2026-01-01" }, [], FY)).toEqual({
      sql: "transaction_date > $1::date"
    });
    // The two location columns must resolve to genuinely different SQL — a copy-paste
    // slip mapping both to the same column would silently make one of the two filters
    // dead weight.
    expect(buildTransferConditionSql({ columnId: "fromLocation", op: "equals", value: "Center-A" }, [], FY)).toEqual({
      sql: "from_location = $1"
    });
    expect(buildTransferConditionSql({ columnId: "toLocation", op: "equals", value: "Center-A" }, [], FY)).toEqual({
      sql: "location = $1"
    });
  });

  it("rejects an unknown column", () => {
    expect(buildTransferConditionSql({ columnId: "notARealColumn", op: "equals", value: "x" }, [], FY)).toEqual({
      error: 'Unknown filter column "notARealColumn".'
    });
  });

  it("TRANSFER_COLUMNS has exactly the 5 columns the Transfer Log UI offers a filter for", () => {
    expect(Object.keys(TRANSFER_COLUMNS).sort()).toEqual(
      ["assetDescription", "farId", "fromLocation", "toLocation", "transactionDate"].sort()
    );
  });
});

describe("transferConditionsQuerySchema", () => {
  it("parses a JSON-encoded array from the query string", () => {
    const result = transferConditionsQuerySchema.safeParse(JSON.stringify([{ columnId: "farId", op: "equals", value: "FAR-1" }]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([{ columnId: "farId", op: "equals", value: "FAR-1" }]);
  });

  it("defaults to an empty array when omitted", () => {
    const result = transferConditionsQuerySchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    expect(transferConditionsQuerySchema.safeParse("{not json").success).toBe(false);
  });
});
