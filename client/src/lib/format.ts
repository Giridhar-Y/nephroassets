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
