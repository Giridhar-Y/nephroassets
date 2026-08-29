import { describe, expect, it } from "vitest";
import { allScopedC1Only, C2_COLUMN_IDS, hideC2Columns, scopedSubClassificationNames } from "./columns.js";
import type { ColumnCondition } from "./columnFilters.js";
import type { SubClassificationOption } from "../api/client.js";

const SUB_CLASSES: SubClassificationOption[] = [
  { name: "C1-Only", hasComponent2: false },
  { name: "C1-Only-2", hasComponent2: false },
  { name: "Full", hasComponent2: true }
];

describe("scopedSubClassificationNames", () => {
  it("returns the multi-select array when it has values, ignoring conditions", () => {
    expect(scopedSubClassificationNames(["A", "B"], [])).toEqual(["A", "B"]);
  });

  it("falls back to an 'equals' condition on subClassification when there's no multi-select", () => {
    const conditions: ColumnCondition[] = [{ columnId: "subClassification", type: "text", op: "equals", value: "A" }];
    expect(scopedSubClassificationNames(undefined, conditions)).toEqual(["A"]);
  });

  it("returns null for an empty multi-select and no matching condition", () => {
    expect(scopedSubClassificationNames([], [])).toBeNull();
    expect(scopedSubClassificationNames(undefined, [])).toBeNull();
  });

  it("returns null for a broader condition operator (e.g. contains) — not an exact name", () => {
    const conditions: ColumnCondition[] = [{ columnId: "subClassification", type: "text", op: "contains", value: "A" }];
    expect(scopedSubClassificationNames(undefined, conditions)).toBeNull();
  });

  it("ignores a condition on a different column", () => {
    const conditions: ColumnCondition[] = [{ columnId: "farId", type: "text", op: "equals", value: "FAR-1" }];
    expect(scopedSubClassificationNames(undefined, conditions)).toBeNull();
  });
});

describe("allScopedC1Only", () => {
  it("is false when the scope is null (unfiltered)", () => {
    expect(allScopedC1Only(null, SUB_CLASSES)).toBe(false);
  });

  it("is true when every scoped name is C1-only", () => {
    expect(allScopedC1Only(["C1-Only", "C1-Only-2"], SUB_CLASSES)).toBe(true);
  });

  it("is false when even one scoped name has Component 2", () => {
    expect(allScopedC1Only(["C1-Only", "Full"], SUB_CLASSES)).toBe(false);
  });

  it("is false for an unrecognized name (defaults to 'has Component 2' like everywhere else)", () => {
    expect(allScopedC1Only(["Unknown-Class"], SUB_CLASSES)).toBe(false);
  });
});

describe("hideC2Columns", () => {
  it("drops every id in C2_COLUMN_IDS and keeps everything else", () => {
    const cols = [{ id: "farId" }, { id: "c2OpeningCost" }, { id: "c1OpeningCost" }, { id: "c2Nbv" }];
    const result = hideC2Columns(cols);
    expect(result.map((c) => c.id)).toEqual(["farId", "c1OpeningCost"]);
  });

  it("is a no-op when nothing in the list is a C2 column", () => {
    const cols = [{ id: "farId" }, { id: "assetDescription" }];
    expect(hideC2Columns(cols)).toEqual(cols);
  });

  it("C2_COLUMN_IDS has no accidental C1 entries", () => {
    for (const id of C2_COLUMN_IDS) {
      expect(id.toLowerCase()).not.toMatch(/c1(?![a-z])/);
    }
  });
});
