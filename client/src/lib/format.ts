// currencySign: "accounting" — the one built-in Intl option for exactly this: a negative
// value renders in parentheses, "(₹1,000)", instead of a leading minus. Every other rule
// (grouping, precision) is untouched, so every existing positive-value call site is
// unaffected — this only changes how a negative one is signed.
const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  currencySign: "accounting",
  maximumFractionDigits: 0
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

/** True when a formatCurrency (or similarly accounting-signed) string represents a
 *  negative value — i.e. it's wrapped in parentheses. Lets a generic cell renderer that
 *  only has the formatted text (not the original number) apply the brand's negative-value
 *  color without re-deriving the sign itself. */
export function isNegativeFormattedCurrency(formatted: string): boolean {
  return formatted.startsWith("(");
}

// "150", "2.5K", "15K", "2.5L" — Indian numbering shorthand for a compact loaded/total
// counter (Register's toolbar). K at 1,000, L at 1,00,000 (a lakh), Cr at 1,00,00,000 (a
// crore) — matching how these figures are actually read/written in this app's own
// domain, not the Western "M"/"B" a generic compact formatter would reach for. One
// decimal place, trimmed when it's a whole number.
export function formatCompactIndianCount(n: number): string {
  const [divisor, suffix] = n >= 1_00_00_000 ? [1_00_00_000, "Cr"] : n >= 1_00_000 ? [1_00_000, "L"] : n >= 1_000 ? [1_000, "K"] : [1, ""];
  if (divisor === 1) return String(n);
  const value = Math.round((n / divisor) * 10) / 10;
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
}

// ₹-prefixed sibling of formatCompactIndianCount above, same K/L/Cr shorthand and 1
// decimal place — for a KPI headline figure inside a fixed-width card, where
// formatCurrency's full-precision string (e.g. "₹81,06,68,314") can genuinely overflow a
// bold, large-font tile and get silently clipped by `truncate`. Sign-aware: divisor
// selection above only ever matches non-negative magnitudes, so a negative value is
// formatted on its absolute value with the "-" re-applied after. Pair this with
// `title={formatCurrency(value)}` on the same element so the exact rupee figure is still
// one hover/tap away — this is a display fix, not a precision cut.
export function formatCurrencyCompact(value: number): string {
  return value < 0 ? `-₹${formatCompactIndianCount(-value)}` : `₹${formatCompactIndianCount(value)}`;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// A full ISO timestamp (e.g. an audit log's created_at), not a plain "YYYY-MM-DD" date —
// formatDate above appends its own "T00:00:00Z" and would mangle an already-complete
// timestamp into an invalid string. Local time (no timeZone override), since this is
// "when did this actually happen" for the person reading it, not a date-only figure.
export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
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
