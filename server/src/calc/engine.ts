import { daysHeldInclusive, isAfter, isOnOrBefore, maxIsoDate } from "./dates.js";
import type {
  AssetCalculationResult,
  AssetInput,
  ComponentResult,
  FySettings,
  TransferRecord
} from "./types.js";

interface ComponentInput {
  openingCost: number;
  additions: number;
  dateOfAddition: string | null;
  usefulLifeYears: number;
  dateOfDisposal: string | null;
  deletionsCost: number;
  saleValue: number;
  accDepOpening: number;
}

/**
 * Implements calculation-logic steps 1-11 of FAR_Developer_Requirements.md for a single
 * cost component (C1 or C2). Applied identically and independently to each component.
 */
export function computeComponent(input: ComponentInput, fy: FySettings): ComponentResult {
  const { asAt, fyStart, daysInFy } = fy;

  // Step 1: Effective End Date
  const disposalEffective =
    input.dateOfDisposal !== null && isOnOrBefore(input.dateOfDisposal, asAt);
  const effectiveEndDate = disposalEffective ? input.dateOfDisposal! : asAt;

  // Step 2: Days Held
  const daysHeldOpening = Math.max(0, daysHeldInclusive(fyStart, effectiveEndDate));

  const additionApplies =
    input.additions !== 0 &&
    input.dateOfAddition !== null &&
    !isAfter(input.dateOfAddition, effectiveEndDate);
  const daysHeldAddition = additionApplies
    ? Math.max(0, daysHeldInclusive(input.dateOfAddition!, effectiveEndDate))
    : 0;

  const usefulLife = input.usefulLifeYears;
  const hasUsefulLife = usefulLife > 0;

  // Step 3: Depreciation on Opening
  const depOnOpening = hasUsefulLife
    ? (input.openingCost / usefulLife) * (daysHeldOpening / daysInFy)
    : 0;

  // Step 4: Depreciation on Additions
  const depOnAdditions =
    hasUsefulLife && additionApplies
      ? (input.additions / usefulLife) * (daysHeldAddition / daysInFy)
      : 0;

  // Full cost basis (Opening Cost + Additions), i.e. Gross Block before any disposal
  // write-off. Used as the depreciable ceiling in step 5 and as the denominator in step 7,
  // matching step 7's own explicit "(Opening Cost + Additions)" wording. Using the
  // *net-of-disposal* figure here instead would zero out an asset's entire in-year
  // depreciation whenever it happens to be fully disposed in the same period — including
  // wiping out the depreciation charge already accrued up to the disposal date, which
  // would also make Closing Accumulated Depreciation go negative. See engine.test.ts's
  // "added and disposed within the same period" case.
  const costBase = input.openingCost + input.additions;

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
  // opening/addition SLM shape as steps 3-4, but cut off at Disposal Date instead of AS_AT,
  // then scales the result by the Disposed Ratio to isolate the disposed portion's share
  // (the Deletions fields don't record whether the disposed cost came from the opening
  // balance or from an in-year addition, so this proportional split is the closest
  // consistent reading of "depreciation on the disposed portion").
  let depOnDisposedPortion = 0;
  if (disposalEffective && hasUsefulLife) {
    const disposalDate = input.dateOfDisposal!;
    const openingDaysAtDisposal = Math.max(0, daysHeldInclusive(fyStart, disposalDate));
    const openingDepAtDisposal = (input.openingCost / usefulLife) * (openingDaysAtDisposal / daysInFy);

    const additionAppliesAtDisposal =
      input.additions !== 0 && input.dateOfAddition !== null && !isAfter(input.dateOfAddition, disposalDate);
    const additionDaysAtDisposal = additionAppliesAtDisposal
      ? Math.max(0, daysHeldInclusive(input.dateOfAddition!, disposalDate))
      : 0;
    const additionDepAtDisposal = additionAppliesAtDisposal
      ? (input.additions / usefulLife) * (additionDaysAtDisposal / daysInFy)
      : 0;

    depOnDisposedPortion = disposedRatio * (openingDepAtDisposal + additionDepAtDisposal);
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

export function computeAsset(
  asset: AssetInput,
  fy: FySettings,
  transfers: TransferRecord[]
): AssetCalculationResult {
  const c1 = computeComponent(
    {
      openingCost: asset.c1OpeningCost,
      additions: asset.additionsC1,
      dateOfAddition: asset.dateOfAddition,
      usefulLifeYears: asset.usefulLifeC1Years,
      dateOfDisposal: asset.dateOfDisposal,
      deletionsCost: asset.deletionsC1,
      saleValue: asset.saleValue,
      accDepOpening: asset.accDepC1Opening
    },
    fy
  );

  const c2 = computeComponent(
    {
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

  return { farId: asset.farId, c1, c2, effectiveLocation };
}
