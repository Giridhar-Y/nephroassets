import type { IsoDate } from "./types.js";

/** Parses "YYYY-MM-DD" as a UTC midnight timestamp so day-diffs are DST-safe. */
export function parseIsoDate(date: IsoDate): number {
  const parts = date.split("-");
  if (parts.length !== 3) {
    throw new Error(`Invalid ISO date: "${date}"`);
  }
  const [y, m, d] = parts.map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

const MS_PER_DAY = 86_400_000;

/** Inclusive day count from `start` to `end` (end - start + 1). Negative if end < start. */
export function daysHeldInclusive(start: IsoDate, end: IsoDate): number {
  const diff = Math.round((parseIsoDate(end) - parseIsoDate(start)) / MS_PER_DAY);
  return diff + 1;
}

export function isOnOrBefore(a: IsoDate, b: IsoDate): boolean {
  return parseIsoDate(a) <= parseIsoDate(b);
}

export function isAfter(a: IsoDate, b: IsoDate): boolean {
  return parseIsoDate(a) > parseIsoDate(b);
}

export function maxIsoDate(dates: IsoDate[]): IsoDate {
  return dates.reduce((max, d) => (isAfter(d, max) ? d : max));
}

/** Adds a whole number of days to an ISO date, UTC-midnight arithmetic (same DST-safety
 *  as parseIsoDate). Used for the end-of-life taper's `eol = dateAcquired + usefulLife *
 *  daysInFy` — the caller rounds the day count first, since a fractional day has no
 *  single correct answer. */
export function addDaysToIsoDate(date: IsoDate, days: number): IsoDate {
  const d = new Date(parseIsoDate(date) + days * MS_PER_DAY);
  return d.toISOString().slice(0, 10);
}
