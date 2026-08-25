import { describe, expect, it } from "vitest";
import { toggleRegisterSelection, type SelectionState } from "./registerSelection.js";
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

const empty: SelectionState = { selected: new Set(), autoSelected: new Set() };

describe("toggleRegisterSelection", () => {
  it("checking a parent auto-checks its active children", () => {
    const items = [
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "C1", parentFarId: "P1" }),
      asset({ farId: "C2", parentFarId: "P1" })
    ];
    const next = toggleRegisterSelection(items, "P1", empty);
    expect(next.selected).toEqual(new Set(["P1", "C1", "C2"]));
    expect(next.autoSelected).toEqual(new Set(["C1", "C2"]));
  });

  it("unchecking the parent drops only the children it auto-selected, not ones explicitly checked first", () => {
    const items = [
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "C1", parentFarId: "P1" }),
      asset({ farId: "C2", parentFarId: "P1" })
    ];
    // C1 is checked explicitly first, then the parent is checked (C2 gets auto-added).
    const afterExplicitChild = toggleRegisterSelection(items, "C1", empty);
    const afterParentOn = toggleRegisterSelection(items, "P1", afterExplicitChild);
    expect(afterParentOn.selected).toEqual(new Set(["C1", "P1", "C2"]));
    expect(afterParentOn.autoSelected).toEqual(new Set(["C2"]));

    const afterParentOff = toggleRegisterSelection(items, "P1", afterParentOn);
    // P1 and the auto-added C2 drop; the explicitly-checked C1 survives.
    expect(afterParentOff.selected).toEqual(new Set(["C1"]));
    expect(afterParentOff.autoSelected).toEqual(new Set());
  });

  it("does not auto-select a child that's already disposed", () => {
    const items = [
      asset({ farId: "P1", hasChildren: true }),
      asset({ farId: "C1", parentFarId: "P1", dateOfDisposal: "2026-01-01" })
    ];
    const next = toggleRegisterSelection(items, "P1", empty);
    expect(next.selected).toEqual(new Set(["P1"]));
  });

  it("directly checking a child removes it from autoSelected even if it was auto-added first", () => {
    const items = [asset({ farId: "P1", hasChildren: true }), asset({ farId: "C1", parentFarId: "P1" })];
    const afterParentOn = toggleRegisterSelection(items, "P1", empty);
    expect(afterParentOn.autoSelected).toEqual(new Set(["C1"]));

    // Toggling C1 directly now (unchecking it) should just remove it plainly — and
    // re-checking it afterward must not re-mark it auto-selected.
    const afterChildOff = toggleRegisterSelection(items, "C1", afterParentOn);
    expect(afterChildOff.selected).toEqual(new Set(["P1"]));
    expect(afterChildOff.autoSelected).toEqual(new Set());

    const afterChildOnAgain = toggleRegisterSelection(items, "C1", afterChildOff);
    expect(afterChildOnAgain.selected).toEqual(new Set(["P1", "C1"]));
    expect(afterChildOnAgain.autoSelected).toEqual(new Set());
  });

  it("a plain asset with no children just toggles itself", () => {
    const items = [asset({ farId: "A1" })];
    const on = toggleRegisterSelection(items, "A1", empty);
    expect(on.selected).toEqual(new Set(["A1"]));
    const off = toggleRegisterSelection(items, "A1", on);
    expect(off.selected).toEqual(new Set());
  });
});
