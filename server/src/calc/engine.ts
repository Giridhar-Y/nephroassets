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
 * tranche dated before FY Start is Opening; on/after FY Start (and on/before
 * `viewEnd`) is an Addition "during FY"; after `viewEnd` it hasn't happened yet as of
 * this view and contributes nothing at all (matching how Deletions/disposal are
 * already date-gated below).
 *
 * This is the actual fix for the FY-rollover bug: nothing here trusts which form
 * field an amount was typed into. Capitalizing an asset mid-year correctly shows it
 * as an Addition this year; the moment FY Start advances (Settings), the exact same
 * dateAcquired now falls before the new FY Start, so it reclassifies as Opening on
 * its own — no manual re-entry, no "close year" migration step required.
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
  const isOpening = isAfter(fyStart, date); // date < fyStart
  const daysHeld = Math.max(0, daysHeldInclusive(isOpening ? fyStart : date, viewEnd));
  const dep = usefulLife > 0 ? (amount / usefulLife) * (daysHeld / daysInFy) : 0;
  return isOpening
    ? { openingAmount: amount, additionAmount: 0, openingDep: dep, additionDep: 0, additionDaysHeld: 0 }
    : { openingAmount: 0, additionAmount: amount, openingDep: 0, additionDep: dep, additionDaysHeld: daysHeld };
}

/** Whether a tranche's date falls before FY Start — used only for the FY-Start
 *  snapshot (openingGrossBlock/openingNbv), which is deliberately independent of
 *  AS_AT or a later disposal: what the asset was worth the moment the year began,
 *  not "as of today" and not "before it was sold off." */
function isOpeningTranche(amount: number, date: IsoDate | null, fyStart: IsoDate): boolean {
  return amount !== 0 && date !== null && isAfter(fyStart, date);
}

/**
 * Implements calculation-logic steps 1-11 of FAR_Developer_Requirements.md for a single
 * cost component (C1 or C2). Applied identically and independently to each component.
 */
export function computeComponent(input: ComponentInput, fy: FySettings): ComponentResult {
  const { asAt, fyStart, daysInFy } = fy;
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

  // Step 5: Period Depreciation (final) — capped at the remaining depreciable value
  // (full cost basis minus what's already been depreciated), so NBV can never go negative
  // and a fully depreciated asset always shows zero further depreciation.
  const periodDepreciation = Math.min(
    depOnOpening + depOnAdditions,
    Math.max(costBase - input.accDepOpening, 0)
  );

  // Step 6: Gross Block as at AS_AT (net of disposal, if disposal is effective for AS_AT)
  const effectiveDisposedCost = disposalEffective ? input.deletionsCost : 0;
  const grossBlock = costBase - effectiveDisposedCost;

  // Step 7: Disposed Ratio
  const disposedRatio = costBase !== 0 ? effectiveDisposedCost / costBase : 0;

  // Step 8: Depreciation on the disposed portion, up to Disposal Date. Re-applies the same
  // per-tranche classification as steps 3-4, but cut off at Disposal Date instead of
  // AS_AT, then scales the result by the Disposed Ratio to isolate the disposed portion's
  // share (the Deletions fields don't record whether the disposed cost came from the
  // opening balance or from an in-year addition, so this proportional split is the closest
  // consistent reading of "depreciation on the disposed portion").
  let depOnDisposedPortion = 0;
  if (disposalEffective && hasUsefulLife) {
    const disposalDate = input.dateOfDisposal!;
    const acqAtDisposal = splitTranche(input.openingCost, input.dateAcquired, fyStart, disposalDate, usefulLife, daysInFy);
    const addAtDisposal = splitTranche(input.additions, input.dateOfAddition, fyStart, disposalDate, usefulLife, daysInFy);
    depOnDisposedPortion =
      disposedRatio * (acqAtDisposal.openingDep + acqAtDisposal.additionDep + addAtDisposal.openingDep + addAtDisposal.additionDep);
  }

  const accDepOnDisposed = disposalEffective
    ? Math.min(disposedRatio * input.accDepOpening + depOnDisposedPortion, effectiveDisposedCost)
    : 0;

  // Step 9: Closing Accumulated Depreciation
  const closingAccDep = Math.min(
    input.accDepOpening + periodDepreciation - accDepOnDisposed,
    grossBlock
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

  return { farId: asset.farId, c1, c2, effectiveLocation, lastDateOfTransaction };
}
