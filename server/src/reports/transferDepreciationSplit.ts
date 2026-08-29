// Reporting-layer only — reads an asset's already-computed C1/C2 period depreciation
// (from the locked calc engine, engine.ts) and allocates each component across the
// locations the asset physically sat in during the period, weighted by days held at
// each. Never recomputes depreciation itself, and never touches
// engine.ts/calcFunction.sql.
import { daysHeldInclusive, isOnOrBefore, parseIsoDate } from "../calc/dates.js";
import type { IsoDate, TransferRecord } from "../calc/types.js";

export interface LocationTimeSegment {
  location: string;
  fromDate: IsoDate;
  toDate: IsoDate;
  daysHeld: number;
}

export interface LocationSegment extends LocationTimeSegment {
  c1Depreciation: number;
  c2Depreciation: number;
  /** c1Depreciation + c2Depreciation — Register's own convention (see
   *  DepreciationPostingBreakdown.total): the combined figure is derived from the two
   *  already-rounded component figures, not independently rounded from a raw combined
   *  float, so it's always exactly their sum. */
  depreciation: number;
}

const MS_PER_DAY = 86_400_000;

function addDaysIso(date: IsoDate, delta: number): IsoDate {
  return new Date(parseIsoDate(date) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

// Money is reconciled at paisa precision — matching the existing convention (see
// compareTaperImpact.ts) — display-layer rounding to whole rupees happens separately,
// same as every other currency figure in the app. Exported: callers must round a raw
// engine total to the paisa at the SAME point this module does, before treating it as
// "the real total" anywhere else (e.g. combining it with another already-rounded
// figure) — rounding twice at different points for what's meant to be the same number
// is exactly how a whole-database reconciliation can drift by a few paise even though
// every individual split is internally exact (see reports.ts for where this matters).
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The location(s) an asset occupied between `periodStart` and `periodEnd`
 * (inclusive), with days held at each — purely a function of transfer history and the
 * period bounds, independent of any depreciation amount. `transfers` should be every
 * transfer for this one asset, in any order — this function sorts them itself.
 *
 * A transfer on or before `periodStart` only matters for determining where the asset
 * already was when the period began (same "latest transfer wins" rule as the calc
 * engine's `computeEffectiveLocation`), not as a segment boundary of its own. Two (or
 * more) transfers on the very same date collapse naturally: the earlier same-day
 * segment's day count comes out to zero (and is dropped), so only the location the
 * asset ended that day at ever appears.
 */
export function computeLocationSegments(
  originalLocation: string,
  transfers: TransferRecord[],
  periodStart: IsoDate,
  periodEnd: IsoDate
): LocationTimeSegment[] {
  if (parseIsoDate(periodStart) > parseIsoDate(periodEnd)) return [];

  const sorted = [...transfers].sort((a, b) => parseIsoDate(a.transactionDate) - parseIsoDate(b.transactionDate));

  let currentLocation = originalLocation;
  for (const t of sorted) {
    if (isOnOrBefore(t.transactionDate, periodStart)) currentLocation = t.location;
  }

  const withinPeriod = sorted.filter(
    (t) => parseIsoDate(t.transactionDate) > parseIsoDate(periodStart) && isOnOrBefore(t.transactionDate, periodEnd)
  );

  const raw: { location: string; fromDate: IsoDate; toDate: IsoDate }[] = [];
  let segmentStart = periodStart;
  for (const t of withinPeriod) {
    const segmentEnd = addDaysIso(t.transactionDate, -1);
    if (parseIsoDate(segmentEnd) >= parseIsoDate(segmentStart)) {
      raw.push({ location: currentLocation, fromDate: segmentStart, toDate: segmentEnd });
    }
    currentLocation = t.location;
    segmentStart = t.transactionDate;
  }
  raw.push({ location: currentLocation, fromDate: segmentStart, toDate: periodEnd });

  return raw.map((s) => ({ ...s, daysHeld: daysHeldInclusive(s.fromDate, s.toDate) }));
}

/**
 * Allocates `totalAmount` across `segments` in proportion to each segment's
 * `daysHeld`. Every segment except the chronologically last (segments are assumed
 * already in chronological order) is rounded normally to the paisa; the last absorbs
 * whatever's left, so the returned amounts always sum to exactly `round2(totalAmount)`
 * — never approximately, per the correctness requirement this report exists to
 * satisfy. Called independently per depreciation component (C1, C2) so each
 * reconciles exactly on its own, not just their combined total.
 */
export function allocateByDays(segments: LocationTimeSegment[], totalAmount: number): number[] {
  const totalDays = segments.reduce((sum, s) => sum + s.daysHeld, 0);
  const target = round2(totalAmount);

  const amounts: number[] = [];
  let allocated = 0;
  segments.forEach((s, i) => {
    const isLast = i === segments.length - 1;
    const amount = isLast ? round2(target - allocated) : round2(totalDays > 0 ? (totalAmount * s.daysHeld) / totalDays : 0);
    allocated = round2(allocated + amount);
    amounts.push(amount);
  });
  return amounts;
}

/**
 * Splits an asset's C1 and C2 period depreciation across the location(s) it occupied
 * during the period — each component allocated independently (so each reconciles
 * exactly to its own total), sharing the same location/date/days-held boundaries
 * (those depend only on transfer history, not on the amounts being split).
 */
export function splitDepreciationByLocation(
  originalLocation: string,
  transfers: TransferRecord[],
  periodStart: IsoDate,
  periodEnd: IsoDate,
  c1Total: number,
  c2Total: number
): LocationSegment[] {
  const boundaries = computeLocationSegments(originalLocation, transfers, periodStart, periodEnd);
  const c1Amounts = allocateByDays(boundaries, c1Total);
  const c2Amounts = allocateByDays(boundaries, c2Total);

  return boundaries.map((s, i) => {
    const c1Depreciation = c1Amounts[i]!;
    const c2Depreciation = c2Amounts[i]!;
    return { ...s, c1Depreciation, c2Depreciation, depreciation: round2(c1Depreciation + c2Depreciation) };
  });
}
