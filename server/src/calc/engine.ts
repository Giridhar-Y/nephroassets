// CALCULATION-CRITICAL — DO NOT MODIFY without explicit sign-off.
//
// This logic is verified against the finance team's Excel reference formulas (FAR FY
// 2026-27 workbook) as of 2026-08-28 — taper logic, fractional useful-life support,
// step-8 additions-window fix, and the closingAccDep floor. Confirmed via live
// comparison at two different AS_AT dates (2026-07-31 and 2026-08-28), matching to the
// last decimal. Tagged `calc-engine-verified-2026-08-28`.
//
// Any change here requires: (a) a written formula justification, (b) updated
// engine.test.ts + sqlParity.test.ts coverage, (c) a fresh before/after impact
// comparison against production data, (d) explicit user approval before merge.
//
// SQL port: server/src/db/calcFunction.sql — kept in lock-step by sqlParity.test.ts.
import { daysHeldInclusive, isAfter, isOnOrBefore, maxIsoDate } from "./dates.js";
import type {
  AssetCalculationResult,
  AssetInput,
  ComponentResult,
  FySettings,
  IsoDate,
  TransferRecord
} from "./types.js";

interface ComponentInput {
  dateAcquired: IsoDate;
  openingCost: number;
  additions: number;
  dateOfAddition: IsoDate | null;
  usefulLifeYears: number;
  dateOfDisposal: IsoDate | null;
  deletionsCost: number;
  saleValue: number;
  accDepOpening: number;
}

interface TrancheSplit {
  openingAmount: number;
  additionAmount: number;
  openingDep: number;
  additionDep: number;
  /** Diagnostic only (surfaced via `daysHeldAddition`) — nothing else consumes it. */
  additionDaysHeld: number;
}

const ZERO_SPLIT: TrancheSplit = { openingAmount: 0, additionAmount: 0, openingDep: 0, additionDep: 0, additionDaysHeld: 0 };

/**
 * Classifies one dated cost tranche — an asset's original acquisition cost
 * (openingCost @ dateAcquired) or its one mid-life addition (additions @
 * dateOfAddition) — against the *current* FY Start, live, every time this runs. A
 * tranche dated on or before FY Start is Opening (an asset capitalized exactly on
 * FY Start day was on the books for the whole year, same as one acquired earlier);
 * strictly after FY Start (and on/before `viewEnd`) is an Addition "during FY"; after
 * `viewEnd` it hasn't happened yet as of this view and contributes nothing at all
 * (matching how Deletions/disposal are already date-gated below).
 *
 * This is the actual fix for the FY-rollover bug: nothing here trusts which form
 * field an amount was typed into. Capitalizing an asset mid-year correctly shows it
 * as an Addition this year; the moment FY Start advances (Settings), the exact same
 * dateAcquired now falls on or before the new FY Start, so it reclassifies as Opening
 * on its own — no manual re-entry, no "close year" migration step required.
 */
function splitTranche(
  amount: number,
  date: IsoDate | null,
  fyStart: IsoDate,
  viewEnd: IsoDate,
  usefulLife: number,
  daysInFy: number
): TrancheSplit {
  if (amount === 0 || date === null || isAfter(date, viewEnd)) return ZERO_SPLIT;
  const isOpening = isOnOrBefore(date, fyStart); // date <= fyStart
  const daysHeld = Math.max(0, daysHeldInclusive(isOpening ? fyStart : date, viewEnd));
  const dep = usefulLife > 0 ? (amount / usefulLife) * (daysHeld / daysInFy) : 0;
  return isOpening
    ? { openingAmount: amount, additionAmount: 0, openingDep: dep, additionDep: 0, additionDaysHeld: 0 }
    : { openingAmount: 0, additionAmount: amount, openingDep: 0, additionDep: dep, additionDaysHeld: daysHeld };
}

/** Whether a tranche's date falls on or before FY Start — used only for the FY-Start
 *  snapshot (openingGrossBlock/openingNbv), which is deliberately independent of
 *  AS_AT or a later disposal: what the asset was worth the moment the year began,
 *  not "as of today" and not "before it was sold off." */
function isOpeningTranche(amount: number, date: IsoDate | null, fyStart: IsoDate): boolean {
  return amount !== 0 && date !== null && isOnOrBefore(date, fyStart);
}

/**
 * Implements calculation-logic steps 1-11 of FAR_Developer_Requirements.md for a single
 * cost component (C1 or C2). Applied identically and independently to each component.
 */
export function computeComponent(input: ComponentInput, fy: FySettings): ComponentResult {
  const { asAt, fyStart, fyEnd, daysInFy } = fy;
  const usefulLife = input.usefulLifeYears;
  const hasUsefulLife = usefulLife > 0;

  // Step 1: Effective End Date
  const disposalEffective =
    input.dateOfDisposal !== null && isOnOrBefore(input.dateOfDisposal, asAt);
  const effectiveEndDate = disposalEffective ? input.dateOfDisposal! : asAt;

  // Opening Gross Block / NBV as at FY start — a fixed snapshot for the whole FY,
  // independent of AS_AT, additions, or disposal: whichever tranche(s) are dated
  // before FY Start. accDepOpening stays the stored/entered value as-is (not
  // re-derived via SLM-since-acquisition) — see the comment on `accDepOpening` below
  // for why, and how this doubles as a future "locked opening balance" hook.
  const openingGrossBlock =
    (isOpeningTranche(input.openingCost, input.dateAcquired, fyStart) ? input.openingCost : 0) +
    (isOpeningTranche(input.additions, input.dateOfAddition, fyStart) ? input.additions : 0);
  const openingNbv = openingGrossBlock - input.accDepOpening;

  // Steps 2-4: per-tranche days held / depreciation, live-classified against FY Start
  // as of `effectiveEndDate` (AS_AT, or an earlier Disposal Date).
  const acq = splitTranche(input.openingCost, input.dateAcquired, fyStart, effectiveEndDate, usefulLife, daysInFy);
  const add = splitTranche(input.additions, input.dateOfAddition, fyStart, effectiveEndDate, usefulLife, daysInFy);

  const daysHeldOpening = Math.max(0, daysHeldInclusive(fyStart, effectiveEndDate));
  const daysHeldAddition = add.additionDaysHeld;

  const depOnOpening = acq.openingDep + add.openingDep;
  const depOnAdditions = acq.additionDep + add.additionDep;

  // Additions Gross Block "during FY" — gated by effectiveEndDate: a tranche dated
  // after it (whether AS_AT or an earlier disposal) hasn't happened yet as of this
  // view, so it contributes nothing, same as a Deletion dated after AS_AT below.
  const additionsGrossBlock = acq.additionAmount + add.additionAmount;
  const openingGrossBlockAsAt = acq.openingAmount + add.openingAmount;

  // Full cost basis as at `effectiveEndDate`, i.e. Gross Block before any disposal
  // write-off. Used as the depreciable ceiling in step 5 and as the denominator in step 7,
  // matching step 7's own explicit "(Opening Cost + Additions)" wording. Using the
  // *net-of-disposal* figure here instead would zero out an asset's entire in-year
  // depreciation whenever it happens to be fully disposed in the same period — including
  // wiping out the depreciation charge already accrued up to the disposal date, which
  // would also make Closing Accumulated Depreciation go negative. See engine.test.ts's
  // "added and disposed within the same period" case.
  const costBase = openingGrossBlockAsAt + additionsGrossBlock;

  // Step 5: Period Depreciation (final) — end-of-life taper, per the FAR FY 2026-27
  // Excel workbook's Z/AA formula (rows 6-12, verified cell-by-cell). eol/taperNbv/
  // remLife name-match that formula's own eol/nbv/remLife ("taperNbv" avoids colliding
  // with this function's own *closing* `nbv`, computed later at step 10) and are
  // asset-level: fixed once, independent of which date we're asking "how much
  // depreciation by" (below).
  //
  // Branch order: the Excel formula checks "is there an addition this period" BEFORE
  // checking "does useful life end within this FY" — whenever there's an addition, flat-
  // rate depreciation on cost+additions (capped at NBV) applies unconditionally, and the
  // taper branch below never fires, regardless of eol. This was confirmed explicitly by
  // finance as intentional (2026-08-27) and reverses the eol-first order shipped in the
  // prior deploy — don't re-flip this order without re-confirming with finance.
  //
  // The flat-rate branch's additions term uses the SAME eff-fyStart+1 window as the
  // opening term (both openingCost and additionsAt divided by usefulLife, multiplied by
  // the same daysHeldAtEff/daysInFy) — matching the FAR FY 2026-27 "V2" workbook's Z/AA
  // formula literally. Reinstated 2026-09-01 after a fresh reconciliation against that
  // workbook (its Methodology & Notes sheet, plus a live ADD001 numeric test case built
  // for this) found the code diverging here: engine.ts computed periodDep=11810.05 vs
  // Excel's 12478.54 on identical inputs, because the code was instead using each
  // tranche's own days-held (depOnOpening/depOnAdditions from steps 2-4 above,
  // splitTranche, dated from the addition's own dateOfAddition). That prior approach was
  // deliberately chosen once before (pre-2026-08-28) BECAUSE the literal Excel reading was
  // evaluated and rejected as a regression: it overstates first-period depreciation on a
  // mid-year addition, charging it the full-FY proportional rate instead of only the days
  // it was actually held. That overstatement is confined to the addition's first FY —
  // accDepOpening carries the inflated figure forward, so later years' remaining-NBV math
  // self-corrects. Confirmed intentional this round via explicit user sign-off
  // (2026-09-01 reconciliation session, ADD001 test case) regardless of that known,
  // accepted consequence — the workbook is the source of truth for this reconciliation.
  //
  // NOTE (step 8 coupling): step 8 below still calls this same depreciationAsOf function
  // in this commit, so its output changes too wherever an addition and a disposal
  // coincide — that's expected here, and gets superseded in the very next commit, which
  // reverts step 8 to a flat-rate form that no longer calls this function at all.
  // eol/remLife are kept as fractional day-counts *from dateAcquired*, never converted
  // to an IsoDate — a fractional useful life (e.g. 2.5 years) needs a fractional eol
  // (e.g. "day 912.5 of ownership"), which a whole-day calendar date can't represent. A
  // prior version rounded usefulLife*daysInFy to the nearest whole day before computing
  // eol, which silently mis-tapered any non-whole useful life (confirmed against a real
  // Excel row: 2.5yr useful life computed remLife=184 instead of the correct 183.5,
  // producing a periodDepreciation off by ~₹180). daysAcquiredToFyStart/FyEnd stay plain
  // integers (real calendar dates on both sides), so only usefulLife*daysInFy itself
  // needs to carry the fraction.
  const daysAcquiredToFyStart = daysHeldInclusive(input.dateAcquired, fyStart) - 1;
  const daysAcquiredToFyEnd = daysHeldInclusive(input.dateAcquired, fyEnd) - 1;
  const eolDaysFromAcquired = hasUsefulLife ? usefulLife * daysInFy : 0;
  const remLife = eolDaysFromAcquired - daysAcquiredToFyStart + 1;
  const eolWithinFy = eolDaysFromAcquired <= daysAcquiredToFyEnd;

  // taperNbv is computed HERE (per viewEnd), not once at the top — it gates `additions`
  // by whether dateOfAddition has actually happened by viewEnd, same as the additions-
  // present check below that now drives branch order. Found via a real seed-data case:
  // an addition dated AFTER the asset's own disposal date was still inflating taperNbv
  // (and would equally inflate an ongoing, non-disposed asset's periodDepreciation for
  // any addition dated after AS_AT) — the Excel formula's literal O/nbv references don't
  // date-gate at all (a static per-FY spreadsheet has no AS_AT-before-addition-date case
  // to worry about), unlike costBase/depOnAdditions above, which already correctly
  // exclude a tranche that "hasn't happened yet as of this view" (see splitTranche).
  // openingCost isn't similarly gated by dateAcquired: the app never computes a
  // component for an AS_AT before its own capitalization date (assets.ts filters
  // `date_acquired <= asAt` upstream), so that case can't reach here in practice.
  function depreciationAsOf(viewEnd: IsoDate, depOnOpeningAt: number, depOnAdditionsAt: number): number {
    const effAt = isAfter(viewEnd, fyEnd) ? fyEnd : viewEnd;
    const additionsAt = input.dateOfAddition !== null && isOnOrBefore(input.dateOfAddition, viewEnd) ? input.additions : 0;
    const taperNbvAt = Math.max(0, input.openingCost + additionsAt - input.accDepOpening);
    if (additionsAt > 0) {
      // An addition happened this period (Excel's O>0) — flat-rate SLM on cost+additions,
      // capped at NBV, unconditionally. The taper branch below never fires here. Both
      // terms share the same eff-fyStart+1 day window (see the comment above this
      // function) — NOT depOnOpeningAt/depOnAdditionsAt, which are dated from each
      // tranche's own start date via splitTranche.
      const daysHeldAtEff = Math.max(0, daysHeldInclusive(fyStart, effAt));
      const flatOpeningDep = (input.openingCost / usefulLife) * (daysHeldAtEff / daysInFy);
      const flatAdditionDep = (additionsAt / usefulLife) * (daysHeldAtEff / daysInFy);
      return Math.min(flatOpeningDep + flatAdditionDep, taperNbvAt);
    }
    if (eolWithinFy) {
      // Taper branch: no addition this period, and useful life ends within (or before)
      // the current FY — depreciate the rest of taperNbvAt over the days actually held
      // up to viewEnd, reaching exactly zero NBV at end-of-life instead of stopping
      // short (flat-rate) or overshooting (previously only the generic cap prevented
      // that).
      // Equivalent to daysHeldInclusive(fyStart, MIN(effAt, eol)) without ever needing a
      // fractional eol as a real date: remLife already equals (eol - fyStart + 1), so
      // capping the inclusive day count at remLife is the same comparison in day-count
      // space, and effAt itself is always a whole calendar date.
      const daysUsedAt = Math.max(0, Math.min(daysHeldInclusive(fyStart, effAt), remLife));
      return remLife <= 0 ? taperNbvAt : (taperNbvAt * daysUsedAt) / remLife;
    }
    // Flat-rate SLM, no addition this period and useful life not yet expired this FY.
    return Math.min(depOnOpeningAt + depOnAdditionsAt, taperNbvAt);
  }

  const periodDepreciation = hasUsefulLife ? depreciationAsOf(effectiveEndDate, depOnOpening, depOnAdditions) : 0;

  // Step 6: Gross Block as at AS_AT (net of disposal, if disposal is effective for AS_AT)
  const effectiveDisposedCost = disposalEffective ? input.deletionsCost : 0;
  const grossBlock = costBase - effectiveDisposedCost;

  // Step 7: Disposed Ratio
  const disposedRatio = costBase !== 0 ? effectiveDisposedCost / costBase : 0;

  // Step 8: Acc Dep on Disposed — matches the FAR FY 2026-27 Excel workbook's AB/AC
  // formula literally: `(S/(M+O))*(X+Z)`, i.e. disposedRatio × (Opening Acc Dep + Period
  // Depreciation), using the SAME taper-aware periodDepreciation already computed in
  // step 5 above — not a separately-derived flat-rate term. Capped at
  // effectiveDisposedCost so WDV at Disposal can never go negative.
  //
  // Reinstated 2026-09-01 (second round) after this reconciliation session's ME0161-04
  // finding: a real production asset (dialysis machine, useful life nearly run out at
  // disposal) showed the code's flat-rate substitute diverging from Excel by ~₹6,656 on
  // a single asset. A production-wide sweep found this isn't rare — 146 of 303 disposed
  // assets (48.2%) have at least one component disposed on/after that component's useful
  // life had already elapsed, exactly the shape where flat-rate and taper pull apart
  // hardest. Explicit user sign-off: match Excel exactly.
  //
  // History for context: a flat-rate substitute (computed independently of step 5,
  // ignoring the taper) was deliberately chosen in an earlier round (pre-2026-08-28)
  // specifically BECAUSE using the taper-aware Period Dep here reopens a known,
  // accepted gap — Audit Reconciliation's roll-forward identity (accDepOpening +
  // periodDepreciation - accDepOnDisposed = closingAccDep) no longer holds exactly for
  // an asset disposed after its useful life had already expired. That gap exists in the
  // Excel workbook itself (its own formulas produce the same non-identity), so it was
  // already accepted as a pre-existing characteristic of the source of truth, not a
  // regression — this round's decision is simply to also accept it here, now that its
  // real-money impact is known and sized.
  const accDepOnDisposed = disposalEffective
    ? Math.min(disposedRatio * (input.accDepOpening + periodDepreciation), effectiveDisposedCost)
    : 0;

  // Step 9: Closing Accumulated Depreciation — floored at 0, not just capped at
  // grossBlock. Confirmed explicitly by finance (2026-08-27): negative accumulated
  // depreciation has no accounting meaning, floor it.
  //
  // Re-examined 2026-09-01 (second round) after step 8 switched to
  // disposedRatio * (accDepOpening + periodDepreciation) (see step 8's comment): this
  // eliminated every remaining trigger for the floor found so far, not just the
  // additions-window one from the prior round. Algebraically, the raw pre-floor value
  // reduces to (1 - disposedRatio) * (accDepOpening + periodDepreciation) — since
  // periodDepreciation is always >= 0 (every depreciationAsOf branch returns a
  // non-negative number), accDepOpening is an entered fact assumed >= 0, and
  // disposedRatio is <= 1 for any well-formed disposal (effectiveDisposedCost no larger
  // than costBase), this product is always >= 0. Every disposal scenario in
  // engine.test.ts — including (k), an asset CAPITALIZED mid-year and disposed the same
  // FY, the prior round's last surviving trigger — now reconciles to exactly 0 without
  // the floor doing anything.
  //
  // The floor is NOT dead code, though: it remains a safety net for malformed data where
  // deletionsCost exceeds the component's own cost base (disposedRatio > 1, e.g. a bad
  // bulk-upload row), which would otherwise make the raw value negative. No such case
  // exists in this app's own write paths (which always derive deletionsCost from the
  // asset's own cost fields), so this is defense-in-depth against bad data, not a
  // scenario this app's UI can produce.
  //
  // This remains a NephroAssets-specific safety net, not something the Excel workbook
  // itself needs: its own sample rows never combine a malformed deletionsCost with a
  // disposal to reveal whether it needs one.
  const closingAccDep = Math.max(
    0,
    Math.min(input.accDepOpening + periodDepreciation - accDepOnDisposed, grossBlock)
  );

  // Step 10: Net Book Value
  const nbv = grossBlock - closingAccDep;

  // Step 11: WDV at Disposal / Profit(Loss) on Disposal
  const wdvAtDisposal = disposalEffective ? effectiveDisposedCost - accDepOnDisposed : null;
  const profitLossOnDisposal =
    disposalEffective && wdvAtDisposal !== null ? input.saleValue - wdvAtDisposal : null;

  return {
    effectiveEndDate,
    disposalEffective,
    daysHeldOpening,
    daysHeldAddition,
    openingGrossBlock,
    additionsGrossBlock,
    openingNbv,
    depOnOpening,
    depOnAdditions,
    periodDepreciation,
    grossBlock,
    disposedRatio,
    accDepOnDisposed,
    closingAccDep,
    nbv,
    wdvAtDisposal,
    profitLossOnDisposal
  };
}

/**
 * Step 12: Effective Location = location of the most recent Transfer record for this
 * asset with transaction date on or before AS_AT; falls back to the asset's original
 * Location if no such transfer exists.
 */
export function computeEffectiveLocation(
  farId: string,
  originalLocation: string,
  transfers: TransferRecord[],
  asAt: string
): string {
  const applicable = transfers.filter(
    (t) => t.farId === farId && isOnOrBefore(t.transactionDate, asAt)
  );
  if (applicable.length === 0) return originalLocation;
  const latestDate = maxIsoDate(applicable.map((t) => t.transactionDate));
  const candidates = applicable.filter((t) => t.transactionDate === latestDate);
  return candidates[candidates.length - 1]!.location;
}

/**
 * Latest of Date Acquired (Capitalization), Date of Addition, every Transfer date, and
 * Date of Disposal — whichever of those events actually apply on or before AS_AT (the
 * same "as at" cut-off every other figure in the register respects). Date Acquired is
 * always included as the floor: even an asset with no additions, transfers, or disposal
 * yet still has *a* last transaction date, the day it was capitalized.
 */
export function computeLastDateOfTransaction(
  asset: AssetInput,
  transfers: TransferRecord[],
  asAt: string
): IsoDate {
  const candidates: IsoDate[] = [];
  if (isOnOrBefore(asset.dateAcquired, asAt)) candidates.push(asset.dateAcquired);
  if (asset.dateOfAddition !== null && isOnOrBefore(asset.dateOfAddition, asAt)) {
    candidates.push(asset.dateOfAddition);
  }
  for (const t of transfers) {
    if (t.farId === asset.farId && isOnOrBefore(t.transactionDate, asAt)) candidates.push(t.transactionDate);
  }
  if (asset.dateOfDisposal !== null && isOnOrBefore(asset.dateOfDisposal, asAt)) {
    candidates.push(asset.dateOfDisposal);
  }
  // Falls back to Date Acquired even when it's after AS_AT (a future-dated asset) —
  // there's no earlier real event to report, and returning it un-filtered beats crashing
  // on an empty array.
  return candidates.length > 0 ? maxIsoDate(candidates) : asset.dateAcquired;
}

export function computeAsset(
  asset: AssetInput,
  fy: FySettings,
  transfers: TransferRecord[]
): AssetCalculationResult {
  const c1 = computeComponent(
    {
      dateAcquired: asset.dateAcquired,
      openingCost: asset.c1OpeningCost,
      additions: asset.additionsC1,
      dateOfAddition: asset.dateOfAddition,
      usefulLifeYears: asset.usefulLifeC1Years,
      dateOfDisposal: asset.dateOfDisposal,
      deletionsCost: asset.deletionsC1,
      saleValue: asset.saleValue,
      // Not reclassified/re-derived by date, unlike Opening Gross Block above — this
      // stays exactly the stored/entered value, unconditionally. It's effectively
      // already the "locked opening balance" a future Close-FY feature would formalize:
      // there's no transaction ledger of historical depreciation charges to re-derive
      // it from (past useful-life changes, impairments, etc. wouldn't survive a clean
      // SLM-since-acquisition recompute), so it has to be an entered fact, not a
      // formula. When Close-FY ships, "locking" a year is just: this field already
      // works as an override — the only new part is *what writes it* at year-end.
      accDepOpening: asset.accDepC1Opening
    },
    fy
  );

  const c2 = computeComponent(
    {
      dateAcquired: asset.dateAcquired,
      openingCost: asset.c2OpeningCost,
      additions: asset.additionsC2,
      dateOfAddition: asset.dateOfAddition,
      usefulLifeYears: asset.usefulLifeC2Years,
      dateOfDisposal: asset.dateOfDisposal,
      deletionsCost: asset.deletionsC2,
      saleValue: asset.saleValue,
      accDepOpening: asset.accDepC2Opening
    },
    fy
  );

  const effectiveLocation = computeEffectiveLocation(
    asset.farId,
    asset.location,
    transfers,
    fy.asAt
  );

  const lastDateOfTransaction = computeLastDateOfTransaction(asset, transfers, fy.asAt);

  // Sale Value counted once against the combined WDV — see the doc comment on
  // `AssetCalculationResult.assetProfitLossOnDisposal`. Both components share the same
  // `disposalEffective`/`wdvAtDisposal` null-ness (they're driven by the same
  // asset-level dateOfDisposal), so checking c1 alone is sufficient.
  const assetProfitLossOnDisposal =
    c1.wdvAtDisposal !== null && c2.wdvAtDisposal !== null
      ? asset.saleValue - (c1.wdvAtDisposal + c2.wdvAtDisposal)
      : null;

  return { farId: asset.farId, c1, c2, effectiveLocation, lastDateOfTransaction, assetProfitLossOnDisposal };
}
