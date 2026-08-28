import { addDaysToIsoDate, daysHeldInclusive, isAfter, isOnOrBefore, maxIsoDate } from "./dates.js";
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
  // The flat-rate branch's additions term still uses depOnOpening/depOnAdditions from
  // steps 2-4 above (splitTranche, dated from the addition's own dateOfAddition), NOT a
  // flat eff-fyStart+1 window for both — this part is UNCHANGED and orthogonal to the
  // branch-order question above: it was evaluated and rejected as a real regression of
  // the prior FY-rollover fix when the taper formula first shipped, and that decision
  // still stands.
  //
  // NOTE (step 8 coupling): step 8 below still calls this same depreciationAsOf function
  // in this commit, so its output changes too wherever an addition and a disposal
  // coincide — that's expected here, and gets superseded in the very next commit, which
  // reverts step 8 to a flat-rate form that no longer calls this function at all.
  const eol = hasUsefulLife
    ? addDaysToIsoDate(input.dateAcquired, Math.round(usefulLife * daysInFy))
    : input.dateAcquired;
  const remLife = daysHeldInclusive(fyStart, eol);
  const eolWithinFy = isOnOrBefore(eol, fyEnd);

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
      // capped at NBV, unconditionally. The taper branch below never fires here.
      return Math.min(depOnOpeningAt + depOnAdditionsAt, taperNbvAt);
    }
    if (eolWithinFy) {
      // Taper branch: no addition this period, and useful life ends within (or before)
      // the current FY — depreciate the rest of taperNbvAt over the days actually held
      // up to viewEnd, reaching exactly zero NBV at end-of-life instead of stopping
      // short (flat-rate) or overshooting (previously only the generic cap prevented
      // that).
      const cappedEffAt = isAfter(effAt, eol) ? eol : effAt;
      const daysUsedAt = Math.max(0, daysHeldInclusive(fyStart, cappedEffAt));
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

  // Step 8: Depreciation on the disposed portion, up to Disposal Date — per the FAR FY
  // 2026-27 Excel workbook's AB/AC formula, fully independent of step 5's end-of-life
  // taper: a component whose useful life had already run out before disposal still gets
  // flat-rate SLM here, even though step 5 above would taper it. Confirmed explicitly by
  // finance as intentional; known, accepted consequence: this reopens the Audit
  // Reconciliation roll-forward gap for an asset disposed after its useful life had
  // already expired — that gap exists in the Excel file itself, so it's not a regression
  // to route around.
  //
  // Corrected 2026-08-28: the additions-portion day-count window uses the addition's own
  // dateOfAddition, NOT FY Start. The "FY_ST for both terms" reading from the prior round
  // was a misdiagnosis — it was checked against a version of the workbook with only one
  // usable data row, and a stray same-looking reference was assumed to be the intended
  // formula. A newer version of the file (two consistent data rows) plus its own
  // "Methodology & Notes" sheet confirm explicitly: "Start date for additions: Date of
  // Addition", and for this specific calc, "FY dep on deleted cost from FY_Start (or
  // Add_Date) to Disposal Date." The opening-portion term is unchanged (FY Start), per
  // the same note's "Start date for opening balance assets: FY Start".
  //
  // M and O below are the RAW openingCost/additions input fields (not the FY-rollover-
  // reclassified openingGrossBlockAsAt/additionsGrossBlock from steps 2-4) — the Excel
  // formula's (openingCost + additions) denominator is a direct two-cell reference with
  // no reclassification concept of its own, and step 8 has been independent of step 5's
  // FY-rollover machinery since the reversion two rounds ago. Each term is still
  // separately date-gated (MAX(0, ...)) so a not-yet-happened addition (dateOfAddition
  // after Disposal Date) still contributes zero, matching the rest of this engine's
  // future-dated-tranche handling — without needing step 5's reclassification to do it.
  let depOnDisposedPortion = 0;
  const disposedCombinedCost = input.openingCost + input.additions;
  if (disposalEffective && hasUsefulLife && disposedCombinedCost !== 0) {
    const disposalDate = input.dateOfDisposal!;
    const cappedDisposalDate = isAfter(disposalDate, fyEnd) ? fyEnd : disposalDate;
    const daysOpeningToDisposal = Math.max(0, daysHeldInclusive(fyStart, cappedDisposalDate));
    const depOnDisposedOpening =
      input.deletionsCost * (input.openingCost / disposedCombinedCost) * (daysOpeningToDisposal / (usefulLife * daysInFy));

    let depOnDisposedAdditions = 0;
    if (input.additions !== 0) {
      const daysAdditionToDisposal = Math.max(0, daysHeldInclusive(input.dateOfAddition!, cappedDisposalDate));
      depOnDisposedAdditions =
        input.deletionsCost * (input.additions / disposedCombinedCost) * (daysAdditionToDisposal / (usefulLife * daysInFy));
    }

    depOnDisposedPortion = depOnDisposedOpening + depOnDisposedAdditions;
  }

  const accDepOnDisposed = disposalEffective
    ? Math.min(disposedRatio * input.accDepOpening + depOnDisposedPortion, effectiveDisposedCost)
    : 0;

  // Step 9: Closing Accumulated Depreciation — floored at 0, not just capped at
  // grossBlock. Confirmed explicitly by finance (2026-08-27): negative accumulated
  // depreciation has no accounting meaning, floor it.
  //
  // Re-examined 2026-08-28 after step 8's additions-window correction above: that fix
  // eliminated the floor's ORIGINAL trigger (a long-owned asset's mid-year addition,
  // disposed the same FY — proven by an exhaustive sweep over cost/accDep/useful-life
  // combinations for that shape: the raw pre-floor value never goes negative there
  // anymore, and closing engine.test.ts's (j) confirms it lands at exactly 0, not merely
  // ≥0). The floor is NOT dead code, though — it's still load-bearing for a different,
  // narrower case: an asset CAPITALIZED mid-year (dateAcquired after FY Start, with or
  // without any addition at all) and disposed later the same FY. See engine.test.ts's
  // (k) for the hand-derived proof. The mechanism is the same shape as the additions bug
  // just fixed, just on the opening-cost field: step 8's opening-portion term
  // unconditionally uses FY Start (per the literal Excel formula), while step 5 (via
  // splitTranche's FY-rollover classification, unchanged) correctly uses the asset's own
  // dateAcquired once that falls inside the current FY — a shorter window, so step 8
  // over-attributes days the asset didn't exist yet.
  //
  // This is a NephroAssets-specific safety net, not something the Excel workbook itself
  // needs or has: the file's own sample rows have no asset both capitalized and disposed
  // in the same period to reveal this, so its formulas never had to confront it. This
  // same floor also applies to the accepted post-expiry-disposal reconciliation gap (see
  // step 8's comment) — a no-op there in every case checked so far.
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
    depOnDisposedPortion,
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
