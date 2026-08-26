const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// DD-MM-YYYY — a plain string rearrangement of the ISO "YYYY-MM-DD" storage format (no
// Date object, no timezone risk). Used for the Register's grouped-header column labels
// and the "as at ..." date placeholders, matching the reference export's date style —
// deliberately not `formatDate` above, which stays "21 Aug 2026" everywhere else in the
// app; this task only asked for DD-MM-YYYY on what it's building new, not to unify dates.
export function formatDateDDMMYYYY(value: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-");
  return `${d}-${m}-${y}`;
}

// Estimated end of useful life: Capitalization Date + Useful Life (Years) — a display
// convenience, not a figure the calc engine depreciates against (it only ever uses
// usefulLifeYears as a divisor, never converts it to a calendar date). Whole years add
// calendar-correct via setUTCFullYear; a fractional remainder (e.g. 3.5 years) adds as an
// approximate day count (365.25/yr) since there's no single "correct" day-precise answer
// for a fractional year. usefulLifeYears <= 0 has no meaningful expiry.
export function addYearsToIsoDate(date: string, years: number): string | null {
  if (years <= 0) return null;
  const whole = Math.floor(years);
  const fraction = years - whole;
  const d = new Date(date + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + whole);
  if (fraction > 0) {
    d.setUTCDate(d.getUTCDate() + Math.round(fraction * 365.25));
  }
  return d.toISOString().slice(0, 10);
}
