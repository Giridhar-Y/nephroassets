// Reporting-layer only — reads an asset's already-computed total period depreciation
// (from the locked calc engine, engine.ts) and allocates it across the locations the
// asset physically sat in during the period, weighted by days held at each. Never
// recomputes depreciation itself, and never touches engine.ts/calcFunction.sql.
import { daysHeldInclusive, isOnOrBefore, parseIsoDate } from "../calc/dates.js";
import type { IsoDate, TransferRecord } from "../calc/types.js";

export interface LocationSegment {
  location: string;
  fromDate: IsoDate;
  toDate: IsoDate;
  daysHeld: number;
  depreciation: number;
}

const MS_PER_DAY = 86_400_000;

function addDaysIso(date: IsoDate, delta: number): IsoDate {
  return new Date(parseIsoDate(date) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

// Money is reconciled at paisa precision — matching the existing convention (see
// compareTaperImpact.ts) — display-layer rounding to whole rupees happens separately,
// same as every other currency figure in the app.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Splits `totalDepreciation` across the location(s) an asset occupied between
 * `periodStart` and `periodEnd` (inclusive), in proportion to days held at each.
 *
 * `transfers` should be every transfer for this one asset, in any order — this
 * function sorts them itself. Only a transfer's *location* and *transactionDate* are
 * used; a transfer on or before `periodStart` only matters for determining where the
 * asset already was when the period began (same "latest transfer wins" rule as the
 * calc engine's `computeEffectiveLocation`), not as a segment boundary of its own.
 *
 * Rounding: every segment except the chronologically last is rounded normally to the
 * paisa; the last segment absorbs whatever's left so the segments always sum to
 * exactly `round2(totalDepreciation)` — never approximately, per the correctness
 * requirement this report exists to satisfy. Two (or more) transfers on the very same
 * date collapse naturally: the earlier same-day segment's day count comes out to zero
 * (and is dropped), so only the location the asset ended that day at ever appears.
 */
export function splitDepreciationByLocation(
  originalLocation: string,
  transfers: TransferRecord[],
  periodStart: IsoDate,
  periodEnd: IsoDate,
  totalDepreciation: number
): LocationSegment[] {
  if (parseIsoDate(periodStart) > parseIsoDate(periodEnd)) return [];

  const sorted = [...transfers].sort((a, b) => parseIsoDate(a.transactionDate) - parseIsoDate(b.transactionDate));

  // Location the asset was already at when the period began: the latest transfer on or
  // before periodStart (ties broken by keeping the last one in input order, same as
  // computeEffectiveLocation), falling back to the asset's original location.
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

  const withDays = raw.map((s) => ({ ...s, daysHeld: daysHeldInclusive(s.fromDate, s.toDate) }));
  const totalDays = withDays.reduce((sum, s) => sum + s.daysHeld, 0);
  const target = round2(totalDepreciation);

  const segments: LocationSegment[] = [];
  let allocated = 0;
  withDays.forEach((s, i) => {
    const isLast = i === withDays.length - 1;
    const dep = isLast ? round2(target - allocated) : round2(totalDays > 0 ? (totalDepreciation * s.daysHeld) / totalDays : 0);
    allocated = round2(allocated + dep);
    segments.push({ location: s.location, fromDate: s.fromDate, toDate: s.toDate, daysHeld: s.daysHeld, depreciation: dep });
  });

  return segments;
}
