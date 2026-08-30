import { describe, expect, it } from "vitest";
import { centerScopeSql, isCenterInScope, outOfScopeCenters } from "./centerScope.js";

describe("isCenterInScope", () => {
  it("is always true when unscoped (centerScope: null)", () => {
    expect(isCenterInScope({ centerScope: null }, "Center-001")).toBe(true);
    expect(isCenterInScope({ centerScope: null }, "Anything")).toBe(true);
  });

  it("is true only for a center actually in the scoped set", () => {
    const user = { centerScope: new Set(["Center-001", "Center-002"]) };
    expect(isCenterInScope(user, "Center-001")).toBe(true);
    expect(isCenterInScope(user, "Center-002")).toBe(true);
    expect(isCenterInScope(user, "Center-003")).toBe(false);
  });

  it("is always false when scoped to an empty set (locked out of every center)", () => {
    const user = { centerScope: new Set<string>() };
    expect(isCenterInScope(user, "Center-001")).toBe(false);
  });

  it("matches exact canonical casing only — no case-folding", () => {
    const user = { centerScope: new Set(["Center-001"]) };
    expect(isCenterInScope(user, "center-001")).toBe(false);
  });
});

describe("outOfScopeCenters", () => {
  it("returns an empty array when unscoped, regardless of input", () => {
    expect(outOfScopeCenters({ centerScope: null }, ["Center-001", "Center-999"])).toEqual([]);
  });

  it("returns only the centers outside scope, deduped, in first-seen order", () => {
    const user = { centerScope: new Set(["Center-001"]) };
    expect(outOfScopeCenters(user, ["Center-002", "Center-001", "Center-003", "Center-002"])).toEqual([
      "Center-002",
      "Center-003"
    ]);
  });

  it("returns an empty array when every center is in scope", () => {
    const user = { centerScope: new Set(["Center-001", "Center-002"]) };
    expect(outOfScopeCenters(user, ["Center-001", "Center-002"])).toEqual([]);
  });
});

describe("centerScopeSql", () => {
  it("returns null (no filter) and pushes nothing when unscoped", () => {
    const params: unknown[] = ["existing-param"];
    const sql = centerScopeSql({ centerScope: null }, "COALESCE(revised_location, location)", params);
    expect(sql).toBeNull();
    expect(params).toEqual(["existing-param"]);
  });

  it("pushes the scope array and returns a correctly-indexed ANY($n) placeholder", () => {
    const params: unknown[] = ["existing-param"];
    const sql = centerScopeSql({ centerScope: new Set(["Center-001", "Center-002"]) }, "COALESCE(revised_location, location)", params);
    expect(sql).toBe("COALESCE(revised_location, location) = ANY($2)");
    expect(params).toEqual(["existing-param", ["Center-001", "Center-002"]]);
  });

  it("still produces a valid (always-false) filter when scoped to an empty set", () => {
    const params: unknown[] = [];
    const sql = centerScopeSql({ centerScope: new Set<string>() }, "COALESCE(revised_location, location)", params);
    expect(sql).toBe("COALESCE(revised_location, location) = ANY($1)");
    expect(params).toEqual([[]]);
  });
});
