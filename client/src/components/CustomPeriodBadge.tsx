// Shared by every report page that lets a date/period be overridden away from the
// app-wide "Figures as of" setting (Audit Reconciliation, Depreciation Posting) — same
// pill + reset-link visual so a custom override reads the same way everywhere.
export const DATE_INPUT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export function CustomPeriodBadge({
  label,
  resetLabel,
  onReset
}: {
  label: string;
  resetLabel: string;
  onReset: () => void;
}) {
  return (
    <>
      <span className="mb-0.5 rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold text-white">{label}</span>
      <button type="button" className="mb-0.5 text-[11px] font-medium text-accent hover:underline" onClick={onReset}>
        {resetLabel}
      </button>
    </>
  );
}
