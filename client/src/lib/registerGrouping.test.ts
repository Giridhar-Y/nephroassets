import { describe, expect, it } from "vitest";
import { groupParentChildRows } from "./registerGrouping.js";
import type { AssetInput, AssetListItem } from "./types.js";

function asset(overrides: Partial<AssetInput>): AssetListItem {
  const base: AssetInput = {
    farId: "X",
    subClassification: "Test-Sub",
    assetDescription: "Test Asset",
    serialNo: "",
    qty: 1,
    status: "Active",
    dateAcquired: "2026-01-01",
    location: "Center-A",
    revisedLocation: null,
    lastDateOfTransaction: null,
    parentFarId: null,
    disposedViaParentFarId: null,
    hasChildren: false,
    usefulLifeC1Years: 5,
    usefulLifeC2Years: 5,
    c1OpeningCost: 0,
    c2OpeningCost: 0,
    additionsC1: 0,
    additionsC2: 0,
    dateOfAddition: null,
    dateOfDisposal: null,
    deletionsC1: 0,
    deletionsC2: 0,
    saleValue: 0,
    accDepC1Opening: 0,
    accDepC2Opening: 0,
    ...overrides
  };
  return {
    asset: base,
    result: {
      farId: base.farId,
      c1: {} as AssetListItem["result"]["c1"],
      c2: {} as AssetListItem["result"]["c2"],
      effectiveLocation: base.location,
      lastDateOfTransaction: base.dateAcquired,
      assetProfitLossOnDisposal: null
    }
  };
}

function farIds(items: AssetListItem[]): string[] {
  return items.map((i) => i.asset.farId);
}

describe("groupParentChildRows", () => {
  it("leaves a list with no parent/child links untouched", () => {
    const items = [asset({ farId: "A1" }), asset({ farId: "A2" }), asset({ farId: "A3" })];
    expect(groupParentChildRows(items)).toBe(items);
  });

  it("pulls a child that sorted after its parent to sit directly beneath it (no-op case)", () => {
    const items = [
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "M1" }),
      asset({ farId: "C1", parentFarId: "P1" })
    ];
    expect(farIds(groupParentChildRows(items))).toEqual(["P1", "C1", "M1"]);
  });

  it("pulls a child that sorted BEFORE its parent forward to sit directly beneath it", () => {
    const items = [
      asset({ farId: "C1", parentFarId: "P1" }),
      asset({ farId: "M1" }),
      asset({ farId: "P1", hasChildren: true })
    ];
    expect(farIds(groupParentChildRows(items))).toEqual(["M1", "P1", "C1"]);
  });

  it("groups multiple children under one parent, preserving their own relative order", () => {
    const items = [
      asset({ farId: "C2", parentFarId: "P1" }),
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "M1" }),
      asset({ farId: "C1", parentFarId: "P1" })
    ];
    expect(farIds(groupParentChildRows(items))).toEqual(["P1", "C2", "C1", "M1"]);
  });

  it("handles several independent parent/child pairs at once", () => {
    const items = [
      asset({ farId: "C1", parentFarId: "P1" }),
      asset({ farId: "P2", hasChildren: true }),
      asset({ farId: "M1" }),
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "C2", parentFarId: "P2" })
    ];
    expect(farIds(groupParentChildRows(items))).toEqual(["P2", "C2", "M1", "P1", "C1"]);
  });

  it("leaves a child in its own sort position when its parent isn't in the loaded set", () => {
    const items = [asset({ farId: "M1" }), asset({ farId: "C1", parentFarId: "P-not-loaded" })];
    expect(farIds(groupParentChildRows(items))).toEqual(["M1", "C1"]);
  });

  it("does not reorder anything when the only loaded child's parent is missing (returns the same reference)", () => {
    const items = [asset({ farId: "M1" }), asset({ farId: "C1", parentFarId: "P-not-loaded" })];
    expect(groupParentChildRows(items)).toBe(items);
  });
});
