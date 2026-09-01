import { describe, expect, it } from "vitest";
import { computeAsset, computeComponent, computeEffectiveLocation, computeLastDateOfTransaction } from "./engine.js";
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
// End-of-life taper (step 5) — ported from the reference Excel workbook's own
// separately-verified formula. The four canonical scenarios used there.
// ---------------------------------------------------------------------------
describe("End-of-life taper (step 5)", () => {
  it("(a) normal mid-life asset, no additions — unchanged from flat-rate behavior", () => {
    // eol = 2020-01-01 + 10yr ≈ 2029-12, well past fyEnd (2026-03-31) — flat-rate branch,
    // identical to what the old (pre-taper) formula already produced for this input.
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 20000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBeCloseTo(5013.698630136986, 6);
  });

  it("(b) eol falls within the current FY, no additions — tapers to exactly zero NBV", () => {
    // dateAcquired 2021-10-01 + 4yr useful life -> eol = 2025-09-30, inside FY 2025-26
    // (fyStart 2025-04-01, fyEnd 2026-03-31). AS_AT (2026-01-15) is past eol, so the
    // remaining taperNbv (100000 - 30000 = 70000) is fully written off by eol, not the
    // old flat-rate/cap behavior that would have kept accruing a small amount per period.
    const r = computeComponent(
      {
        dateAcquired: "2021-10-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 4,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 30000
      },
      fy({ asAt: "2026-01-15" })
    );
    expect(r.periodDepreciation).toBeCloseTo(70000, 6);
    expect(r.closingAccDep).toBeCloseTo(100000, 6);
    expect(r.nbv).toBeCloseTo(0, 6);
  });

  it("(c) same as (b) but with an addition this year — additions-first branch order takes flat-rate, not taper", () => {
    // Same asset as (b) plus a same-year addition (20000 @ 2025-06-01). Per the FAR FY
    // 2026-27 Excel workbook's Z/AA formula (confirmed cell-by-cell, 2026-08-27): the
    // additions check (O>0) is evaluated BEFORE the eol check, so an addition this period
    // always takes flat-rate depreciation on cost+additions (capped at NBV), and the
    // taper branch never fires here even though eol falls within this FY — the opposite
    // of the order this app shipped in the prior deploy (which checked eol first and
    // wrote off the combined NBV in one shot; see the git history of this test for that
    // prior expectation).
    //
    // 2026-09-01 addition-window fix: both terms now use the SAME eff-fyStart+1 window
    // (290 days, fyStart..asAt), matching the FAR FY 2026-27 "V2" workbook's Z/AA formula
    // literally, rather than the addition's own 229-day dateOfAddition..asAt window:
    //   periodDepreciation = ((100000+20000)/4) * (290/365) = 23835.616438356163
    // well under taperNbv (90000) so the cap doesn't bind — still NOT the taper branch's
    // 90000 (full write-off) from before the 2026-08-27 branch-order reversion, and no
    // longer the 23000 the pre-2026-09-01 own-dateOfAddition window gave either.
    const r = computeComponent(
      {
        dateAcquired: "2021-10-01",
        openingCost: 100000,
        additions: 20000,
        dateOfAddition: "2025-06-01",
        usefulLifeYears: 4,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 30000
      },
      fy({ asAt: "2026-01-15" })
    );
    expect(r.periodDepreciation).toBeCloseTo(23835.616438356163, 6);
    expect(r.closingAccDep).toBeCloseTo(53835.616438356163, 6);
    expect(r.nbv).toBeCloseTo(66164.38356164384, 6);
  });

  it("(d) eol in a prior FY, stale leftover NBV — fully written off in one period", () => {
    // eol = 2015-01-01 + 5yr = 2019-12-31, well before fyStart (2025-04-01) — remLife <= 0,
    // so the entire remaining taperNbv (100000 - 60000 = 40000) is written off this one
    // period rather than continuing a flat rate indefinitely past end-of-life.
    const r = computeComponent(
      {
        dateAcquired: "2015-01-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 60000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBeCloseTo(40000, 6);
    expect(r.closingAccDep).toBeCloseTo(100000, 6);
    expect(r.nbv).toBeCloseTo(0, 6);
  });

  it("(e) flat-rate branch: a mid-year addition now prorates over the same fyStart..asAt window as opening cost, matching Excel's Z/AA formula literally", () => {
    // eol = 2020-01-01 + 10yr, safely past fyEnd (2026-03-31) — flat-rate branch, reached
    // here via the additions-first check now (additionsAt > 0, since dateOfAddition
    // 2025-07-01 <= asAt) rather than via "eol not within FY" as it would have been
    // before the 2026-08-27 branch-order reversion — same destination branch as then.
    //
    // 2026-09-01 addition-window fix: depOnOpening/depOnAdditions (steps 2-4,
    // splitTranche) — which prorate the addition from its own dateOfAddition, not
    // fyStart — no longer feed periodDepreciation in this branch at all; kept below only
    // as their own independent step-2-4 assertions, unchanged from before. What actually
    // drives periodDepreciation now is a fresh flat-rate calc using the SAME
    // fyStart..asAt window (275 days) for both terms:
    //   periodDepreciation = ((50000+20000)/10) * (275/365) = 5273.972602739726
    // This is exactly the literal-formula figure this test previously rejected (see git
    // history) — matching Excel's Z/AA formula was evaluated and rejected once before
    // (pre-2026-08-28) as a regression (overstates a mid-year addition's first-period
    // dep), then reinstated 2026-09-01 via explicit user sign-off after a fresh
    // reconciliation against the FAR FY 2026-27 "V2" workbook (ADD001 test case) found
    // the code diverging from it. See engine.ts's step-5 comment for the full history.
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 50000,
        additions: 20000,
        dateOfAddition: "2025-07-01",
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 5000
      },
      fy({ asAt: "2025-12-31" })
    );
    // Steps 2-4 (splitTranche) still compute these independently — unchanged, no longer
    // fed into periodDepreciation for this branch:
    expect(r.depOnOpening).toBeCloseTo(3767.123287671233, 6);
    expect(r.depOnAdditions).toBeCloseTo(1008.219178082192, 6);
    expect(r.periodDepreciation).toBeCloseTo(5273.972602739726, 6);
  });

  it("(f) disposed after useful life had already expired — step 8 stays flat-rate, reopening the Audit Reconciliation gap", () => {
    // eol = 2020-01-01 + 5yr = 2024-12-30, before fyStart (2025-04-01) — remLife <= 0, so
    // step 5's periodDepreciation is this component's entire remaining taperNbv
    // (50000 - 10000 = 40000). Step 8 (accDepOnDisposed) was reverted 2026-08-27 to a
    // flat-rate form fully independent of step 5's taper, per the FAR FY 2026-27 Excel
    // workbook's AB/AC formula (confirmed cell-by-cell) — a component whose useful life
    // had already run out before disposal now gets flat-rate SLM in step 8 regardless of
    // step 5's taper. This deliberately reopens the Audit Reconciliation dep-check gap
    // for exactly this combination (an asset disposed post-expiry): accDepOpening +
    // periodDepreciation - accDepOnDisposed no longer equals closingAccDep. Confirmed
    // explicitly by finance as an accepted consequence, since the Excel file itself has
    // this same gap.
    //
    // depOnDisposedPortion = (50000/5) * (62 days fyStart..disposalDate / 365) =
    // 1698.6301369863013; accDepOnDisposed = 10000 (accDepOpening, disposedRatio=1) +
    // 1698.6301369863013 = 11698.630136986301.
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 50000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: "2025-06-01",
        deletionsCost: 50000,
        saleValue: 5000,
        accDepOpening: 10000
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.periodDepreciation).toBeCloseTo(40000, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(11698.630136986301, 6);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    // The reconciliation identity Audit Reconciliation checks (accDepOpening is 10000,
    // per the fixture above) no longer holds — the whole point of this reversion:
    expect(10000 + r.periodDepreciation - r.accDepOnDisposed).not.toBeCloseTo(r.closingAccDep, 2);
    expect(r.wdvAtDisposal).toBeCloseTo(38301.369863013699, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-33301.369863013699, 6);
  });

  it("(g) taper branch: a not-yet-happened addition doesn't inflate taperNbv (ongoing asset)", () => {
    // eol = 2020-01-01 + 3yr ≈ 2022-12-31, well before fyStart — remLife <= 0, taper
    // branch. dateOfAddition (2026-01-01) is AFTER asAt (2025-09-30), so it hasn't
    // happened yet as of this view — taperNbv must be 10000 - 2000 = 8000 (opening only),
    // NOT 15000 - 2000 = 13000 (opening + not-yet-happened addition). Found via a real
    // seed-data case with the same shape but for a disposed asset (test (h) below) — this
    // is the same bug's simpler, non-disposal form: the taper spec's literal nbv formula
    // doesn't date-gate additions at all, unlike costBase/depOnAdditions elsewhere in this
    // engine, which already correctly exclude a tranche that hasn't happened yet.
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 10000,
        additions: 5000,
        dateOfAddition: "2026-01-01",
        usefulLifeYears: 3,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 2000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBeCloseTo(8000, 6);
  });

  it("(h) step 5's taper branch still gates a future-dated addition; step 8's own date-gating now does the same job independently", () => {
    // Same shape as (g), but disposed instead of ongoing — the exact pattern found in
    // real seed data (an addition dated after its own asset's disposal date). eol is well
    // before fyStart (remLife <= 0); dateOfAddition (2025-08-01) is after dateOfDisposal
    // (2025-06-01), so as of the disposal it hasn't happened yet — step 5's taperNbv gate
    // still correctly excludes it (10000 - 2000 = 8000, opening only, not 15000 - 2000 =
    // 13000). This is the future-dated-addition-gating fix from before the taper work —
    // unrelated to either the 2026-08-27 reversion or the 2026-08-28 additions-window
    // correction, kept intact.
    //
    // Step 8, corrected 2026-08-28: the additions-portion term is date-gated again (via
    // MAX(0, disposalDate - dateOfAddition + 1)), so the future-dated addition here
    // contributes exactly 0 to it — same outcome as before this correction, but for a
    // different reason (previously step 8 didn't look at dateOfAddition at all; now it
    // does, and correctly zeroes out a not-yet-happened one). What DOES change: the
    // opening-portion term's ratio is openingCost/(openingCost+additions) = 10000/15000,
    // not 1 — this fixture's deletionsCost (10000) was deliberately set to only the
    // opening amount (a bulk-upload-style historical row, not what this app's own full-
    // disposal write path would ever produce, which always sets deletionsCost to the full
    // combined cost) — so part of that 10000 gets attributed to the (zeroed-out)
    // additions share and is simply not recovered, rather than being fully attributed to
    // the opening share. depOnDisposedOpening = 10000 * (10000/15000) * (62 days
    // fyStart..disposalDate / (3*365)) = 377.47337278106509; depOnDisposedAdditions = 0
    // (date-gated). accDepOnDisposed = 2000 (accDepOpening) + 377.47337278106509 =
    // 2377.4733637747336 — down from 2566.2100456621005 before this correction, per
    // test (f) above the reconciliation identity still doesn't hold for a post-expiry
    // disposal (unrelated to this fix, still accepted).
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 10000,
        additions: 5000,
        dateOfAddition: "2025-08-01",
        usefulLifeYears: 3,
        dateOfDisposal: "2025-06-01",
        deletionsCost: 10000,
        saleValue: 3000,
        accDepOpening: 2000
      },
      fy({ asAt: "2025-12-31" })
    );
    expect(r.periodDepreciation).toBeCloseTo(8000, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(2377.4733637747336, 6);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    expect(2000 + r.periodDepreciation - r.accDepOnDisposed).not.toBeCloseTo(r.closingAccDep, 2);
  });

  // Additional regression coverage (2026-08-27, second round): the Excel workbook's own
  // sample rows (6-12) are all old, fully-depreciated assets with zero additions and zero
  // disposals — they never exercise the additions branch, the taper branch, or step 8's
  // math at all, so they were never a real test of this reversion. This test uses
  // realistically-shaped asset data (not the round demo numbers above) to independently
  // confirm the branch-order reversal, hand-derived the same way as (a)-(h). (A matching
  // realistic-shape test for step 8 — an addition disposed within the same FY — lands in
  // the next commit, alongside step 8's own reversion.)
  it("(i) realistic shape: a mid-year addition in the same FY useful life expires — additions-first order still overrides the taper, not just for round numbers", () => {
    // dateAcquired 2021-01-01 + 5yr useful life -> eol = 2025-12-31, inside this FY
    // (fyStart 2025-04-01, fyEnd 2026-03-31) — would hit the taper branch and fully write
    // off taperNbv if there were no addition (asAt 2026-02-01 is after eol, so remLife<=
    // daysUsed and the taper branch would return taperNbv exactly: 134202). Instead, the
    // 45000 addition on 2025-09-01 means additionsAt > 0, so per the reordering this stays
    // in the flat-rate branch regardless of eol.
    //
    // 2026-09-01 addition-window fix: both terms use the SAME 307-day fyStart..asAt
    // window, matching Excel's Z/AA formula literally (steps 2-4's own 154-day
    // dateOfAddition..asAt window, asserted below, no longer feeds periodDepreciation):
    //   periodDepreciation = ((439202+45000)/5) * (307/365) = 81452.06246575342
    // still well under taperNbv (134202), so the cap doesn't bind — still NOT the taper
    // branch's 134202 a full write-off would have given, and no longer the
    // own-dateOfAddition window's 77679.45972602739 either.
    const r = computeComponent(
      {
        dateAcquired: "2021-01-01",
        openingCost: 439202,
        additions: 45000,
        dateOfAddition: "2025-09-01",
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 350000
      },
      fy({ asAt: "2026-02-01" })
    );
    expect(r.depOnOpening).toBeCloseTo(73882.19945205479, 6);
    expect(r.depOnAdditions).toBeCloseTo(3797.2602739726026, 6);
    expect(r.periodDepreciation).toBeCloseTo(81452.06246575342, 6);
    expect(r.periodDepreciation).not.toBeCloseTo(134202, 0);
    expect(r.grossBlock).toBe(484202);
    expect(r.closingAccDep).toBeCloseTo(431452.06246575341, 6);
    expect(r.nbv).toBeCloseTo(52749.93753424659, 6);
  });

  it("(j) fractional useful life: taper branch keeps remLife as a fraction of a day, not rounded — regression for a real Excel-verified figure (TEST-101/C2)", () => {
    // 2.5yr useful life -> eolDaysFromAcquired = 2.5*365 = 912.5, a genuine half-day. A
    // prior version rounded this to 913 whole days first, giving remLife=184 instead of
    // the correct 183.5 and a periodDepreciation off by ~₹180 from the Excel workbook's
    // own figure for this exact row (verified live against TEST-101/C2, 2026-08-28):
    // remLife = 912.5 - 730 (dateAcquired..fyStart) + 1 = 183.5
    // daysUsedAt = min(daysHeldInclusive(fyStart, asAt)=122, remLife=183.5) = 122
    // periodDepreciation = (100000 * 122) / 183.5 = 66485.0136... -> Excel's ₹66,485.01
    const r = computeComponent(
      {
        dateAcquired: "2024-04-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 2.5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2026-07-31", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 })
    );
    expect(r.periodDepreciation).toBeCloseTo(66485.0136239782, 6);
    expect(r.closingAccDep).toBeCloseTo(66485.0136239782, 6);
    expect(r.nbv).toBeCloseTo(33514.9863760218, 6);
    // The bug's exact wrong answer, so a future regression that reintroduces rounding
    // would be caught even if the correct-value assertions above were loosened.
    expect(r.periodDepreciation).not.toBeCloseTo(66304.35, 1);
  });

  it("(k) fractional useful life on the flat-rate branch (eol well past FY end) — unaffected by the taper fix, since this branch never reads eol/remLife", () => {
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 7.75,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 20000
      },
      fy({ asAt: "2025-09-30" })
    );
    expect(r.periodDepreciation).toBeCloseTo(6469.288555015467, 6);
    expect(r.closingAccDep).toBeCloseTo(26469.288555015467, 6);
    expect(r.nbv).toBeCloseTo(73530.71144498453, 6);
  });

  it("(l) ADD001 regression: FAR FY 2026-27 V2 workbook reconciliation (2026-09-01) — real Excel-computed figures for a mid-year addition, both components", () => {
    // Built live in Excel (real .xlsb, COM automation) during the 2026-09-01
    // reconciliation session as a purpose-built test row (the workbook's own two data
    // rows never exercise the addition branch) — dateAcquired 2018-01-01, addition
    // 2026-06-01, AS_AT 2026-07-31, FY_ST 2026-04-01, FY_EN 2027-03-31, DAYS_FY 365.
    // Excel's Z9/AA9/AD9/AE9/AL9/AM9 (full precision, calculated values not formulas):
    //   C1: periodDep=12478.5388127854, closingAccDep=112478.538812785, nbv=447521.461187215
    //   C2: periodDep=4735.1598173516,  closingAccDep=34735.1598173516,  nbv=135264.840182648
    // This is the exact case that revealed the pre-2026-09-01 code diverging from Excel
    // (see engine.ts's step-5 comment for the full history) — permanent regression
    // coverage for the fix, pinned to Excel's own computed numbers rather than a hand
    // derivation.
    const fy2627: FySettings = { asAt: "2026-07-31", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 };
    const c1 = computeComponent(
      {
        dateAcquired: "2018-01-01",
        openingCost: 500000,
        additions: 60000,
        dateOfAddition: "2026-06-01",
        usefulLifeYears: 15,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 100000
      },
      fy2627
    );
    const c2 = computeComponent(
      {
        dateAcquired: "2018-01-01",
        openingCost: 150000,
        additions: 20000,
        dateOfAddition: "2026-06-01",
        usefulLifeYears: 12,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 30000
      },
      fy2627
    );
    expect(c1.periodDepreciation).toBeCloseTo(12478.5388127854, 6);
    expect(c1.closingAccDep).toBeCloseTo(112478.538812785, 6);
    expect(c1.nbv).toBeCloseTo(447521.461187215, 6);
    expect(c2.periodDepreciation).toBeCloseTo(4735.1598173516, 6);
    expect(c2.closingAccDep).toBeCloseTo(34735.1598173516, 6);
    expect(c2.nbv).toBeCloseTo(135264.840182648, 6);
  });
});

// ---------------------------------------------------------------------------
// Step 6: Gross Block as at AS_AT
// ---------------------------------------------------------------------------
describe("Gross Block as at AS_AT (step 6)", () => {
  it("normal case: opening cost plus additions, no disposal", () => {
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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

  it("edge case (doc): asset added and disposed within the same period never goes negative, and no longer needs the floor to get there", () => {
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
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
    // Since the 2026-08-27 reversion, this hits step 5's flat-rate branch (additionsAt >
    // 0: the addition is dated 2025-05-01, before the 2025-08-31 disposal) rather than
    // the taper branch — eol (2024-12-30) being before fyStart no longer matters once
    // there's an addition this period.
    //
    // 2026-09-01 addition-window fix: step 5's flat-rate branch now uses the SAME
    // eff-fyStart+1 window (153 days, fyStart..disposalDate) for both the opening and
    // addition terms, matching the FAR FY 2026-27 "V2" workbook's Z/AA formula literally
    // (see engine.ts's step-5 comment). With openingCost=0, only the addition term
    // matters: periodDepreciation = (50000/5) * (153/365) = 4191.780821917808 — this is
    // the exact FY-Start-window figure the 2026-08-28 step-8 fix's own comment once cited
    // as "before this correction", now reinstated deliberately for step 5 (not step 8).
    //
    // Step 8's depOnDisposedPortion is UNCHANGED by this fix (out of scope per this
    // round's explicit sign-off) — it still uses its own dateOfAddition-based 123-day
    // window: depOnDisposedPortion = 50000 * 1 * (123/(5*365)) = 3369.863013698630.
    // periodDepreciation and depOnDisposedPortion are consequently NO LONGER identical
    // (they were, briefly, between the 2026-08-28 step-8 fix and this round) — accDepOpening
    // (0) + periodDepreciation (4191.78) - accDepOnDisposed (3369.86) = 821.92, no longer
    // exactly 0. closingAccDep still correctly lands at 0, but now via the Math.min(...,
    // grossBlock) CAP (grossBlock is 0 here, fully disposed) rather than the raw value
    // already being 0 — a different mechanism reaching the same right answer.
    expect(r.periodDepreciation).toBeCloseTo(4191.780821917808, 6);
    expect(r.depOnDisposedPortion).toBeCloseTo(3369.863013698630, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(3369.863013698630, 6);
    expect(r.grossBlock).toBe(0);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    expect(r.closingAccDep).toBeGreaterThanOrEqual(0);
    expect(r.nbv).toBeCloseTo(0, 6);
    expect(r.wdvAtDisposal).toBeCloseTo(46630.136986301370, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-1630.136986301370, 6);
  });

  // Additional regression coverage (2026-08-27, second round; recomputed 2026-08-28): a
  // realistically-shaped, long-owned asset (dateAcquired well before FY Start) with a
  // mid-year addition fully disposed later the same FY.
  it("(j) realistic shape: opening cost + mid-year addition fully disposed the same FY — step 8 no longer matches step 5 exactly (2026-09-01 addition-window fix); grossBlock cap keeps closingAccDep at 0 instead", () => {
    // dateAcquired 2015-01-01, 10yr useful life -> eol is 2025-01-01, before this FY starts
    // (2025-04-01) -- but that's irrelevant here since there IS an addition, so step 5
    // never even reaches the eol check (additions-first order, per (c) and (i) above).
    //
    // 2026-09-01 addition-window fix: step 5's flat-rate branch now uses the SAME
    // eff-fyStart+1 window (244 days, fyStart..disposalDate) for both terms, matching the
    // FAR FY 2026-27 "V2" workbook's Z/AA formula literally:
    //   periodDepreciation = ((250000+60000)/10) * (244/365) = 20723.28767123288
    //   (taperNbv 260000 doesn't cap it) — this is the exact figure the 2026-08-28 step-8
    //   fix's own comment once cited as "before this correction", now reinstated
    //   deliberately for step 5 (not step 8).
    //
    // Step 8's depOnDisposedPortion is UNCHANGED by this fix (out of scope per this
    // round's explicit sign-off) — it still uses each tranche's own dateOfAddition-based
    // window:
    //   depOnDisposedOpening = 310000 * (250000/310000) * (244/(10*365)) = 16712.32876712329
    //   depOnDisposedAdditions = 310000 * (60000/310000) * (153/(10*365)) = 2515.068493150685
    //   depOnDisposedPortion = their sum = 19227.39726027397
    //
    // periodDepreciation and depOnDisposedPortion are consequently NO LONGER identical
    // (they briefly were, between the 2026-08-28 step-8 fix and this round) — the
    // reconciliation identity's raw value is now accDepOpening(50000) +
    // periodDepreciation(20723.28767123288) - accDepOnDisposed(50000 + 19227.39726027397)
    // = 1495.8904109589057, not 0. closingAccDep still correctly lands at 0, but now via
    // the Math.min(..., grossBlock) CAP (grossBlock is 0, fully disposed) rather than the
    // raw value already being 0 — a different mechanism reaching the same right answer.
    const r = computeComponent(
      {
        dateAcquired: "2015-01-01",
        openingCost: 250000,
        additions: 60000,
        dateOfAddition: "2025-07-01",
        usefulLifeYears: 10,
        dateOfDisposal: "2025-11-30",
        deletionsCost: 310000,
        saleValue: 20000,
        accDepOpening: 50000
      },
      fy({ asAt: "2025-11-30" })
    );
    expect(r.depOnOpening).toBeCloseTo(16712.32876712329, 6);
    expect(r.depOnAdditions).toBeCloseTo(2515.068493150685, 6);
    expect(r.periodDepreciation).toBeCloseTo(20723.28767123288, 6);
    expect(r.depOnDisposedPortion).toBeCloseTo(19227.39726027397, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(69227.39726027397, 6);
    // Raw reconciliation value is no longer 0 — the grossBlock cap below is what keeps
    // closingAccDep at 0, not this identity holding on its own:
    expect(50000 + r.periodDepreciation - r.accDepOnDisposed).toBeCloseTo(1495.8904109589057, 6);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    expect(r.nbv).toBeCloseTo(0, 6);
    expect(r.wdvAtDisposal).toBeCloseTo(240772.60273972602, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-220772.60273972602, 6);
  });

  // Additional regression coverage (2026-08-28): the additions-window correction above
  // doesn't eliminate the floor's need in general — it narrows WHEN it's needed. Proven
  // by sweeping many opening cost / additions / accDepOpening / useful-life combinations
  // for a long-owned asset (dateAcquired well before FY Start): the raw pre-floor value
  // never goes negative there, confirming the floor really is dead for that shape now.
  // But an asset CAPITALIZED mid-year (dateAcquired after FY Start) and disposed later
  // the same FY still triggers it — with or without any "additions" field at all — because
  // step 8's opening-portion term unconditionally uses FY Start (per the literal Excel
  // formula), while step 5 (via splitTranche's FY-rollover classification, unchanged)
  // correctly uses the asset's own dateAcquired once that falls inside the current FY.
  // Same mismatch shape as the additions bug just fixed, just on the opening-cost field
  // instead of the additions field — and this one is NOT something Excel's own formula
  // structure avoids by construction, since Excel's file has no rows that are both
  // capitalized and disposed in the same period to reveal it.
  it("(k) realistic shape: asset CAPITALIZED mid-year (no addition at all) and disposed later the same FY — floor still engages", () => {
    // dateAcquired 2026-05-01 is one month after this FY's Start (2026-04-01), so
    // splitTranche classifies it as an addition-tranche for step 5's purposes — its
    // depreciation window runs from dateAcquired, not FY Start:
    //   depOnOpening = 0 (the opening-cost field's own tranche is classified as
    //     "during FY", so its depreciation lands in depOnAdditions instead — a quirk of
    //     splitTranche's naming, not a second real addition)
    //   depOnAdditions = (80000/5) * (214 days dateAcquired..disposalDate / 365) = 9380.82191780822
    //   periodDepreciation = 9380.82191780822 (taperNbv 80000 doesn't cap it)
    //
    // Step 8's opening-portion term, per the Excel formula, always starts from FY Start
    // regardless of dateAcquired:
    //   depOnDisposedOpening = 80000 * (80000/80000) * (244 days fyStart..disposalDate /
    //     (5*365)) = 10695.890410958904 (no additions field at all, so no additions term)
    //
    // Raw closing: 0 + 9380.82191780822 - 10695.890410958904 = -1315.068493150684 —
    // negative, by exactly (80000/5) * (30 days fyStart..dateAcquired / 365) = 1315.07,
    // the extra month step 8 counts before the asset even existed. Floored to 0.
    const r = computeComponent(
      {
        dateAcquired: "2026-05-01",
        openingCost: 80000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: "2026-11-30",
        deletionsCost: 80000,
        saleValue: 10000,
        accDepOpening: 0
      },
      { asAt: "2026-11-30", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    );
    expect(r.depOnOpening).toBeCloseTo(0, 6);
    expect(r.depOnAdditions).toBeCloseTo(9380.82191780822, 6);
    expect(r.periodDepreciation).toBeCloseTo(9380.82191780822, 6);
    expect(r.depOnDisposedPortion).toBeCloseTo(10695.890410958904, 6);
    expect(r.accDepOnDisposed).toBeCloseTo(10695.890410958904, 6);
    // The reconciliation identity's raw value is negative before the floor:
    expect(0 + r.periodDepreciation - r.accDepOnDisposed).toBeLessThan(0);
    expect(r.closingAccDep).toBeCloseTo(0, 6);
    expect(r.closingAccDep).toBeGreaterThanOrEqual(0);
    expect(r.nbv).toBeCloseTo(0, 6);
    expect(r.wdvAtDisposal).toBeCloseTo(69304.1095890411, 6);
    expect(r.profitLossOnDisposal).toBeCloseTo(-59304.109589041094, 6);
  });

  it("edge case (doc): no additions and no disposal leaves WDV/P&L null, not zero", () => {
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01",
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
    // depOnOpening (step 3, unchanged) still matches the old flat-rate figure — it's an
    // intermediate value the taper formula no longer uses for periodDepreciation, kept
    // only for Gross Block reporting. closingAccDep/nbv, downstream of periodDepreciation
    // (step 5), do change: dateAcquired + 6yr puts eol at 2025-12-30, within this FY
    // (fyEnd 2026-03-31) — the taper branch depreciates the remaining taperNbv (60000 −
    // 10000 = 50000) over daysUsed/remLife (183/274 days) instead of the old flat rate.
    expect(r.depOnOpening).toBeCloseTo(5013.698630136986, 6);
    expect(r.closingAccDep).toBeCloseTo(43394.16058394161, 6);
    expect(r.nbv).toBeCloseTo(16605.83941605839, 6);
    expect(r.wdvAtDisposal).toBeNull();
    expect(r.profitLossOnDisposal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Disposal must zero Gross Block/Acc Dep/NBV by computing them from AS_AT and the
// stored Disposal Date — never by the caller mutating openingCost/additions/
// accDepOpening. Same componentInput object reused across every assertion below
// specifically to prove that: nothing about the input changes, only AS_AT does.
// ---------------------------------------------------------------------------
describe("Disposal zeroes closing figures via computation, not by erasing historical inputs", () => {
  it("same asset, same inputs: full pre-disposal history stays correct before disposal, zeroes out at and after it, and the FY-start snapshot never changes", () => {
    const input = {
      dateAcquired: "2020-01-01",
      openingCost: 100000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 10,
      dateOfDisposal: "2025-09-30",
      deletionsCost: 100000,
      saleValue: 30000,
      accDepOpening: 20000
    };

    const before = computeComponent(input, fy({ asAt: "2025-08-01" }));
    expect(before.disposalEffective).toBe(false);
    expect(before.grossBlock).toBe(100000);
    expect(before.nbv).toBeGreaterThan(0);
    expect(before.wdvAtDisposal).toBeNull();

    const atDisposal = computeComponent(input, fy({ asAt: "2025-09-30" }));
    expect(atDisposal.disposalEffective).toBe(true);
    expect(atDisposal.grossBlock).toBe(0);
    expect(atDisposal.closingAccDep).toBeCloseTo(0, 6);
    expect(atDisposal.nbv).toBeCloseTo(0, 6);

    const wellAfter = computeComponent(input, fy({ asAt: "2026-03-31" }));
    expect(wellAfter.disposalEffective).toBe(true);
    expect(wellAfter.grossBlock).toBe(0);
    expect(wellAfter.closingAccDep).toBeCloseTo(0, 6);
    expect(wellAfter.nbv).toBeCloseTo(0, 6);

    // The FY-start snapshot (openingGrossBlock/openingNbv) is disposal-independent —
    // identical across all three AS_AT dates above, computed purely from the same
    // unmodified openingCost/dateAcquired/accDepOpening inputs every time.
    for (const r of [before, atDisposal, wellAfter]) {
      expect(r.openingGrossBlock).toBe(100000);
      expect(r.openingNbv).toBe(80000);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 12: Effective Location
// ---------------------------------------------------------------------------
describe("NBV as at FY start (openingNbv)", () => {
  it("normal case: opening cost minus opening accumulated depreciation", () => {
    const result = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 100000,
        additions: 50000,
        dateOfAddition: "2025-06-01",
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 30000
      },
      FY
    );
    expect(result.openingNbv).toBe(70000);
  });

  it("edge case: unaffected by additions, disposal, or AS_AT — it's fixed at FY start", () => {
    const withAddition = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 100000,
        additions: 999999,
        dateOfAddition: "2025-06-01",
        usefulLifeYears: 10,
        dateOfDisposal: "2025-07-01",
        deletionsCost: 100000,
        saleValue: 5000,
        accDepOpening: 30000
      },
      fy({ asAt: "2026-01-01" })
    );
    expect(withAddition.openingNbv).toBe(70000);
  });

  it("boundary case: fully depreciated at opening still reports the (zero) opening NBV, not the cap", () => {
    const result = computeComponent(
      {
        dateAcquired: "2020-01-01",
        openingCost: 100000,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 5,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 100000
      },
      FY
    );
    expect(result.openingNbv).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Opening vs Addition reclassification (FY-rollover fix) — the two cost tranches
// (openingCost @ dateAcquired, additions @ dateOfAddition) are classified live against
// the *current* fyStart, not by which field they were entered into. A tranche dated on
// or before fyStart is Opening (an asset capitalized exactly on FY Start day was on the
// books the whole year); strictly after is an Addition. Numbers chosen so days-held
// divides cleanly, so every expected figure below is hand-checkable.
// ---------------------------------------------------------------------------
describe("Opening vs Addition reclassification (cost-side FY-rollover fix)", () => {
  it("an asset acquired exactly on FY Start is classified as Opening, not an Addition", () => {
    const r = computeComponent(
      {
        dateAcquired: "2025-04-01", // == fyStart: on or before it, so this is Opening
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
    expect(r.openingGrossBlock).toBe(36500);
    expect(r.additionsGrossBlock).toBe(0);
    expect(r.depOnOpening).toBeCloseTo(10, 6); // 36500/10 * 1/365
    expect(r.depOnAdditions).toBe(0);
    expect(r.grossBlock).toBe(36500);
    expect(r.openingNbv).toBe(36500);
  });

  it("an asset acquired one day after FY Start is still classified as an Addition", () => {
    const r = computeComponent(
      {
        dateAcquired: "2025-04-02", // one day after fyStart -> Addition
        openingCost: 36500,
        additions: 0,
        dateOfAddition: null,
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-04-02" })
    );
    expect(r.openingGrossBlock).toBe(0);
    expect(r.additionsGrossBlock).toBe(36500);
    expect(r.depOnOpening).toBe(0);
    expect(r.depOnAdditions).toBeCloseTo(10, 6); // 36500/10 * 1/365
    expect(r.grossBlock).toBe(36500);
    expect(r.openingNbv).toBe(0);
  });

  it("an addition dated before the current FY Start (a rolled-over prior-FY addition) now counts as Opening", () => {
    const r = computeComponent(
      {
        dateAcquired: "2020-01-01", // long-owned, genuinely opening, but contributes 0 (openingCost=0)
        openingCost: 0,
        additions: 36500,
        dateOfAddition: "2025-01-01", // before fyStart 2025-04-01 — last FY's addition
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 5000
      },
      fy({ asAt: "2025-04-01" })
    );
    expect(r.additionsGrossBlock).toBe(0); // no longer "this FY's addition"
    expect(r.openingGrossBlock).toBe(36500); // rolled into Opening automatically
    expect(r.depOnAdditions).toBe(0);
    expect(r.depOnOpening).toBeCloseTo(10, 6); // 36500/10 * 1/365, dated from fyStart not dateOfAddition
    expect(r.openingNbv).toBe(36500 - 5000);
  });

  it("mixed: opening cost and addition each reclassify to the opposite side of FY Start", () => {
    const r = computeComponent(
      {
        dateAcquired: "2025-04-02", // one day after fyStart -> Addition
        openingCost: 36500,
        additions: 73000,
        dateOfAddition: "2024-01-01", // well before fyStart -> Opening
        usefulLifeYears: 10,
        dateOfDisposal: null,
        deletionsCost: 0,
        saleValue: 0,
        accDepOpening: 0
      },
      fy({ asAt: "2025-04-02" })
    );
    expect(r.openingGrossBlock).toBe(73000); // from the "additions" field
    expect(r.additionsGrossBlock).toBe(36500); // from the "opening cost" field
    expect(r.depOnOpening).toBeCloseTo(40, 6); // 73000/10 * 2/365 (fyStart to asAt, inclusive)
    expect(r.depOnAdditions).toBeCloseTo(10, 6); // 36500/10 * 1/365
    expect(r.grossBlock).toBe(109500);
    expect(r.openingNbv).toBe(73000);
  });

  it("rolling FY Start forward reclassifies the same data with no changes to the asset itself", () => {
    const input = {
      dateAcquired: "2020-01-01",
      openingCost: 100000,
      additions: 40000,
      dateOfAddition: "2025-08-15", // mid-FY addition for the FY25 view below
      usefulLifeYears: 10,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 30000
    };

    // Viewed still within FY25 (fyStart 2025-04-01): the addition is still "this FY's".
    const duringFy25 = computeComponent(input, fy({ asAt: "2025-12-31" }));
    expect(duringFy25.openingGrossBlock).toBe(100000);
    expect(duringFy25.additionsGrossBlock).toBe(40000);

    // Same asset, same stored fields, FY Start now advanced to FY26 (2026-04-01) — the
    // exact same dateOfAddition (2025-08-15) is now *before* the new FY Start, so it
    // reclassifies into Opening automatically. No edit, no migration.
    const duringFy26 = computeComponent(
      input,
      { asAt: "2026-09-30", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    );
    expect(duringFy26.additionsGrossBlock).toBe(0);
    expect(duringFy26.openingGrossBlock).toBe(140000); // 100000 + the rolled-forward addition
  });
});

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
// Last Date of Transaction: max(Date Acquired, Date of Addition, Transfers, Date of
// Disposal), each only if it applies on or before AS_AT.
// ---------------------------------------------------------------------------
describe("Last Date of Transaction", () => {
  const asset: AssetInput = {
    farId: "A1",
    subClassification: "Test-Sub",
    assetDescription: "Test",
    serialNo: "SN-1",
    qty: 1,
    status: "Active",
    dateAcquired: "2024-01-01",
    location: "Center-A",
    revisedLocation: null,
    lastDateOfTransaction: null,
    parentFarId: null,
    disposedViaParentFarId: null,
    hasChildren: false,
    usefulLifeC1Years: 5,
    usefulLifeC2Years: 5,
    c1OpeningCost: 10000,
    c2OpeningCost: 10000,
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

  it("normal case: no addition, transfer, or disposal yet — falls back to Date Acquired", () => {
    expect(computeLastDateOfTransaction(asset, [], "2025-09-30")).toBe("2024-01-01");
  });

  it("normal case: picks the latest of Date Acquired, Date of Addition, and a Transfer", () => {
    const withAddition = { ...asset, dateOfAddition: "2025-05-01" };
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2025-06-15", location: "Center-B" }];
    expect(computeLastDateOfTransaction(withAddition, transfers, "2025-09-30")).toBe("2025-06-15");
  });

  it("normal case: Date of Disposal wins when it's the latest qualifying event", () => {
    const disposed = { ...asset, dateOfAddition: "2025-05-01", dateOfDisposal: "2025-08-01" };
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2025-06-15", location: "Center-B" }];
    expect(computeLastDateOfTransaction(disposed, transfers, "2025-09-30")).toBe("2025-08-01");
  });

  it("boundary case: an event dated exactly on AS_AT counts", () => {
    const withAddition = { ...asset, dateOfAddition: "2025-09-30" };
    expect(computeLastDateOfTransaction(withAddition, [], "2025-09-30")).toBe("2025-09-30");
  });

  it("edge case: a future-dated disposal (after AS_AT) is excluded, not counted early", () => {
    const disposed = { ...asset, dateOfDisposal: "2025-12-01" };
    expect(computeLastDateOfTransaction(disposed, [], "2025-09-30")).toBe("2024-01-01");
  });

  it("edge case: ignores transfers belonging to a different FAR ID", () => {
    const transfers: TransferRecord[] = [{ farId: "OTHER", transactionDate: "2025-06-15", location: "Center-B" }];
    expect(computeLastDateOfTransaction(asset, transfers, "2025-09-30")).toBe("2024-01-01");
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
    parentFarId: null,
    disposedViaParentFarId: null,
    hasChildren: false,
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

  it("wires lastDateOfTransaction through to the top-level result", () => {
    const transfers: TransferRecord[] = [
      { farId: "FAR-0001", transactionDate: "2025-06-01", location: "Center-Z" }
    ];
    const result = computeAsset(baseAsset, fy({ asAt: "2025-09-30" }), transfers);
    expect(result.lastDateOfTransaction).toBe("2025-06-01");
  });

  it("assetProfitLossOnDisposal counts saleValue once against the combined WDV, unlike summing the per-component fields", () => {
    // Verified against the reference workbook's Methodology sheet ("Profit/(Loss) =
    // Sale Value − Total WDV at Disposal") — saleValue used once, not once per component.
    const disposedAsset: AssetInput = {
      ...baseAsset,
      usefulLifeC1Years: 10,
      usefulLifeC2Years: 10,
      c1OpeningCost: 60000,
      c2OpeningCost: 40000,
      dateOfDisposal: "2026-08-01",
      deletionsC1: 60000,
      deletionsC2: 40000,
      saleValue: 9000,
      accDepC1Opening: 54000,
      accDepC2Opening: 36000
    };
    const result = computeAsset(
      disposedAsset,
      fy({ asAt: "2026-08-01", fyStart: "2026-04-01", fyEnd: "2027-03-31" }),
      []
    );

    expect(result.c1.wdvAtDisposal).toBeCloseTo(3978.0821917808207, 6);
    expect(result.c2.wdvAtDisposal).toBeCloseTo(2652.054794520547, 6);
    expect(result.assetProfitLossOnDisposal).toBeCloseTo(2369.863013698632, 6);

    // Per-component fields stay available for anyone who genuinely needs the
    // breakdown — each independently uses the full saleValue, which is why summing
    // them (the bug this field replaces) doesn't equal assetProfitLossOnDisposal.
    expect(result.c1.profitLossOnDisposal).toBeCloseTo(5021.917808219179, 6);
    expect(result.c2.profitLossOnDisposal).toBeCloseTo(6347.945205479453, 6);
    expect(result.c1.profitLossOnDisposal! + result.c2.profitLossOnDisposal!).not.toBeCloseTo(
      result.assetProfitLossOnDisposal!,
      2
    );
  });

  it("assetProfitLossOnDisposal is null when the asset hasn't been disposed", () => {
    const result = computeAsset(baseAsset, fy({ asAt: "2025-09-30" }), []);
    expect(result.assetProfitLossOnDisposal).toBeNull();
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
        dateAcquired: "2020-01-01",
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
