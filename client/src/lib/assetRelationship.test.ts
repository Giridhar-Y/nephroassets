import { describe, expect, it } from "vitest";
import { describeAssetRelationship } from "./assetRelationship.js";
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

describe("describeAssetRelationship", () => {
  it("returns null for a plain asset with no parent/child relationship", () => {
    const item = asset({ farId: "A1" });
    expect(describeAssetRelationship(item, [item])).toBeNull();
  });

  it("labels a child with its parent's FAR ID", () => {
    const child = asset({ farId: "C1", parentFarId: "P1" });
    expect(describeAssetRelationship(child, [child])).toBe("Child of P1");
  });

  it("labels a parent with a count of its children present in the same selection", () => {
    const parent = asset({ farId: "P1", hasChildren: true });
    const c1 = asset({ farId: "C1", parentFarId: "P1" });
    const c2 = asset({ farId: "C2", parentFarId: "P1" });
    const selection = [parent, c1, c2];
    expect(describeAssetRelationship(parent, selection)).toBe("Parent — 2 children included");
  });

  it("uses singular wording for exactly one included child", () => {
    const parent = asset({ farId: "P1", hasChildren: true });
    const c1 = asset({ farId: "C1", parentFarId: "P1" });
    expect(describeAssetRelationship(parent, [parent, c1])).toBe("Parent — 1 child included");
  });

  it("labels a parent as plain 'Parent' when none of its children are in this selection", () => {
    const parent = asset({ farId: "P1", hasChildren: true });
    expect(describeAssetRelationship(parent, [parent])).toBe("Parent");
  });

  it("only counts children that share the exact parentFarId, not an unrelated asset", () => {
    const parent = asset({ farId: "P1", hasChildren: true });
    const unrelated = asset({ farId: "M1" });
    const otherChild = asset({ farId: "C1", parentFarId: "P2" });
    expect(describeAssetRelationship(parent, [parent, unrelated, otherChild])).toBe("Parent");
  });
});
