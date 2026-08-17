import { describe, expect, it } from "vitest";
import { computeAsset, computeComponent, computeEffectiveLocation } from "./engine.js";
import type { AssetInput, FySettings, TransferRecord } from "./types.js";

const FY: FySettings = {
  asAt: "2025-09-30",
  fyStart: "2025-04-01",
  fyEnd: "2026-03-31",
  daysInFy: 365
};

function fy(overrides: Partial<FySettings>): FySettings {
  return { ...FY, ...overrides };
}

// ---------------------------------------------------------------------------
// Step 3: Depreciation on Opening
// ---------------------------------------------------------------------------
describe("Depreciation on Opening (step 3)", () => {
  it("normal case: mid-year AS_AT over a full opening balance", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.daysHeldOpening).toBe(183);
    expect(r.depOnOpening).toBeCloseTo(5013.698630136986, 6);
  });

  it("boundary case: AS_AT equals FY start (1 day held)", () => {
    const r = computeComponent(
      {
        openingCost: 36500,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-04-01" })
    );
    expect(r.daysHeldOpening).toBe(1);
    expect(r.depOnOpening).toBeCloseTo(10, 6);
  });

  it("edge case: zero useful life never divides by zero, yields zero depreciation", () => {
    const r = computeComponent(
      {
        openingCost: 50000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 0,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.depOnOpening).toBe(0);
    expect(r.periodDepreciation).toBe(0);
    expect(Number.isFinite(r.nbv)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 4: Depreciation on Additions
// ---------------------------------------------------------------------------
describe("Depreciation on Additions (step 4)", () => {
  it("normal case: addition partway through the year", () => {
    const r = computeComponent(
      {
        openingCost: 0,
        additions: 50000,
        dateOfAddition: "2025-05-01",
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.daysHeldAddition).toBe(245);
    expect(r.depOnAdditions).toBeCloseTo(6712.328767123287, 6);
  });

  it("boundary case: addition date equals AS_AT (1 day held)", () => {
    const r = computeComponent(
      {
        openingCost: 0,
        additions: 36500,
        dateOfAddition: "2025-06-15",
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-06-15" })
    );
    expect(r.daysHeldAddition).toBe(1);
    expect(r.depOnAdditions).toBeCloseTo(10, 6);
  });

  it("edge case: addition dated after AS_AT is not yet effective", () => {
    const r = computeComponent(
      {
        openingCost: 0,
        additions: 40000,
        dateOfAddition: "2026-01-15",
        usefulLifeYears: 8,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.daysHeldAddition).toBe(0);
    expect(r.depOnAdditions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 5: Period Depreciation cap
// ---------------------------------------------------------------------------
describe("Period Depreciation cap (step 5)", () => {
  it("normal case: raw depreciation is below the remaining depreciable value", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 90000
      },
      fy({ asAt: "2025-09-30" })
    );
    // remaining depreciable value = 100000 - 90000 = 10000, raw dep ~5013.70 stays uncapped
    expect(r.periodDepreciation).toBeCloseTo(5013.698630136986, 6);
  });

  it("boundary case: opening accumulated depreciation already exceeds cost, cap floors at zero", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 120000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBe(0);
  });

  it("edge case (doc): fully depreciated asset shows zero further depreciation, NBV stays zero not negative", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 100000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBe(0);
    expect(r.closingAccDep).toBe(100000);
    expect(r.nbv).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 6: Gross Block as at AS_AT
// ---------------------------------------------------------------------------
describe("Gross Block as at AS_AT (step 6)", () => {
  it("normal case: opening cost plus additions, no disposal", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 20000,
        dateOfAddition: "2025-07-01",
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.grossBlock).toBe(120000);
  });

  it("boundary case: full disposal brings Gross Block to zero", () => {
    const r = computeComponent(
      {
        openingCost: 50000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2025-06-01",
        deletionsCost: 50000,
        saleValue: 10000,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.grossBlock).toBe(0);
  });

  it("edge case (doc): disposal date after AS_AT is ignored for this AS_AT", () => {
    const r = computeComponent(
      {
        openingCost: 80000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2026-02-01",
        deletionsCost: 80000,
        saleValue: 5000,
        accDepOpening: 0
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.disposalEffective).toBe(false);
    expect(r.grossBlock).toBe(80000);
    expect(r.wdvAtDisposal).toBeNull();
    expect(r.profitLossOnDisposal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 7: Disposed Ratio
// ---------------------------------------------------------------------------
describe("Disposed Ratio (step 7)", () => {
  it("normal case: partial disposal ratio", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2025-09-30",
        deletionsCost: 40000,
        saleValue: 25000,
        accDepOpening: 20000
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.disposedRatio).toBeCloseTo(0.4, 10);
  });

  it("boundary case: zero cost base guards against division by zero", () => {
    const r = computeComponent(
      {
        openingCost: 0,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.disposedRatio).toBe(0);
    expect(Number.isFinite(r.disposedRatio)).toBe(true);
  });

  it("edge case: full disposal gives a ratio of 1", () => {
    const r = computeComponent(
      {
        openingCost: 50000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2025-06-01",
        deletionsCost: 50000,
        saleValue: 10000,
        accDepOpening: 0
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.disposedRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Steps 8-11: Disposal accounting (Acc Dep on Disposed, Closing Acc Dep, NBV, WDV, P/L)
// ---------------------------------------------------------------------------
describe("Disposal accounting (steps 8-11)", () => {
  it("normal case: partial disposal mid-year with opening accumulated depreciation", () => {
    const r = computeComponent(
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2025-09-30",
        deletionsCost: 40000,
        saleValue: 25000,
        accDepOpening: 20000
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.depOnDisposedPortion).toBeCloseTo(2005.4794520547944, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(10005.479452054794, 6);
    expect(r.closingAccDep).toBeCloseTo(15008.219178082192, 6);
    expect(r.nbv).toBeCloseTo(44991.780821917808, 6);
    expect(r.wdvAtDisposal).toBeCloseTo(29994.520547945206, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-4994.520547945206, 6);
  });

  it("edge case (doc): asset added and disposed within the same period never goes negative", () => {
    const r = computeComponent(
      {
        openingCost: 0,
        additions: 50000,
        dateOfAddition: "2025-05-01",
        usefulLifeYears: 5,
        dateOfDisposal: "2025-08-31",
        deletionsCost: 50000,
        saleValue: 45000,
        accDepOpening: 0
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.periodDepreciation).toBeCloseTo(3369.863013698630, 6);
    expect(r.grossBlock).toBe(0);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    expect(r.closingAccDep).toBeGreaterThanOrEqual(0);
    expect(r.nbv).toBeCloseTo(0, 6);
    expect(r.wdvAtDisposal).toBeCloseTo(46630.136986301370, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-1630.136986301370, 6);
  });

  it("edge case (doc): no additions and no disposal leaves WDV/P&L null, not zero", () => {
    const r = computeComponent(
      {
        openingCost: 60000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 6,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 10000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.depOnOpening).toBeCloseTo(5013.698630136986, 6);
    expect(r.closingAccDep).toBeCloseTo(15013.698630136986, 6);
    expect(r.nbv).toBeCloseTo(44986.301369863014, 6);
    expect(r.wdvAtDisposal).toBeNull();
    expect(r.profitLossOnDisposal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 12: Effective Location
// ---------------------------------------------------------------------------
describe("Effective Location (step 12)", () => {
  const transfers: TransferRecord[] = [
    { farId: "A1", transactionDate: "2025-05-01", location: "Center-B" },
    { farId: "A1", transactionDate: "2025-08-01", location: "Center-C" }
  ];

  it("normal case: picks the most recent transfer on or before AS_AT", () => {
    expect(computeEffectiveLocation("A1", "Center-A", transfers, "2025-09-30")).toBe("Center-C");
  });

  it("boundary case: a transfer dated exactly on AS_AT counts", () => {
    const t: TransferRecord[] = [{ farId: "A1", transactionDate: "2025-09-30", location: "Center-D" }];
    expect(computeEffectiveLocation("A1", "Center-A", t, "2025-09-30")).toBe("Center-D");
  });

  it("edge case: no transfer on or before AS_AT falls back to original Location", () => {
    const t: TransferRecord[] = [{ farId: "A1", transactionDate: "2026-01-01", location: "Center-E" }];
    expect(computeEffectiveLocation("A1", "Center-A", t, "2025-09-30")).toBe("Center-A");
  });
});

// ---------------------------------------------------------------------------
// computeAsset: C1/C2 independence and end-to-end wiring
// ---------------------------------------------------------------------------
describe("computeAsset", () => {
  const baseAsset: AssetInput = {
    farId: "FAR-0001",
    subClassification: "Dialysis Machines",
    assetDescription: "Test Asset",
    serialNo: "SN-1",
    qty: 1,
    status: "Active",
    dateAcquired: "2024-01-01",
    location: "Center-A",
    revisedLocation: null,
    lastDateOfTransaction: null,
    usefulLifeC1Years: 10,
    usefulLifeC2Years: 5,
    c1OpeningCost: 100000,
    c2OpeningCost: 20000,
    additionsC1: 0,
    additionsC2: 0,
    dateOfAddition: null,
    dateOfDisposal: null,
    deletionsC1: 0,
    deletionsC2: 0,
    saleValue: 0,
    accDepC1Opening: 0,
    accDepC2Opening: 0
  };

  it("computes C1 and C2 independently using their own useful lives and costs", () => {
    const result = computeAsset(baseAsset, fy({ asAt: "2025-09-30" }), []);
    expect(result.c1.depOnOpening).toBeCloseTo(5013.698630136986, 6);
    expect(result.c2.depOnOpening).toBeCloseTo(20000 / 5 * (183 / 365), 6);
    expect(result.c1.depOnOpening).not.toBeCloseTo(result.c2.depOnOpening, 2);
  });

  it("falls back to the asset's Location when no transfer applies", () => {
    const result = computeAsset(baseAsset, fy({ asAt: "2025-09-30" }), []);
    expect(result.effectiveLocation).toBe("Center-A");
  });

  it("uses the transfer's location when one applies", () => {
    const transfers: TransferRecord[] = [
      { farId: "FAR-0001", transactionDate: "2025-06-01", location: "Center-Z" }
    ];
    const result = computeAsset(baseAsset, fy({ asAt: "2025-09-30" }), transfers);
    expect(result.effectiveLocation).toBe("Center-Z");
  });
});

// ---------------------------------------------------------------------------
// Invariants the Audit Reconciliation report depends on
// ---------------------------------------------------------------------------
describe("reconciliation invariants", () => {
  const fixtures: Array<[string, Parameters<typeof computeComponent>[0], FySettings]> = [
    [
      "no disposal, cap not binding",
      {
        openingCost: 60000,
        additions: 15000,
        dateOfAddition: "2025-07-01",
        usefulLifeYears: 6,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 10000
      },
      fy({ asAt: "2025-12-31" })
    ],
    [
      "partial disposal mid-year",
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: "2025-09-30",
        deletionsCost: 40000,
        saleValue: 25000,
        accDepOpening: 20000
      },
      fy({ asAt: "2025-12-31" })
    ],
    [
      "fully depreciated, no disposal",
      {
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 100000
      },
      fy({ asAt: "2025-09-30" })
    ],
    [
      "added and fully disposed same period",
      {
        openingCost: 0,
        additions: 50000,
        dateOfAddition: "2025-05-01",
        usefulLifeYears: 5,
        dateOfDisposal: "2025-08-31",
        deletionsCost: 50000,
        saleValue: 45000,
        accDepOpening: 0
      },
      fy({ asAt: "2025-12-31" })
    ]
  ];

  it.each(fixtures)("%s: Opening+Additions-Deletions=Closing (cost) ties out", (_label, input, settings) => {
    const r = computeComponent(input, settings);
    const effectiveDeletions = r.disposalEffective ? input.deletionsCost : 0;
    const expectedClosing = input.openingCost + input.additions - effectiveDeletions;
    expect(r.grossBlock).toBeCloseTo(expectedClosing, 6);
  });

  it.each(fixtures)("%s: Closing Acc Dep never exceeds Gross Block and NBV never negative", (_label, input, settings) => {
    const r = computeComponent(input, settings);
    expect(r.closingAccDep).toBeLessThanOrEqual(r.grossBlock + 1e-9);
    expect(r.nbv).toBeGreaterThanOrEqual(-1e-9);
    expect(r.closingAccDep).toBeGreaterThanOrEqual(-1e-9);
  });
});
