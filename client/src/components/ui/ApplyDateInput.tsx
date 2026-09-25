import { useEffect, useState } from "react";

// A native <input type="date"> whose changes are STAGED until the user applies them — for
// every date that drives a fetch (the header's "Figures as of", report period/date pickers,
// log date filters). Picking a day in the browser's calendar, its Today/Clear buttons, and
// typing all only change the draft; nothing loads until Apply (or Enter). Escape reverts.
// Why: an accidental pick while browsing, or a year typed digit by digit (which passes
// through dates like 0002-09-25), used to fire a request per change — and on Vercel an
// uncached date is a multi-minute recalculation.
//
// The calendar popup itself is drawn by the browser, not this app, so a button can't live
// inside it; the Apply button appears next to the field whenever the draft differs from
// the value in effect.
export function ApplyDateInput({
  value,
  onApply,
  allowEmpty = false,
  id,
  min,
  max,
  disabled,
  className = "",
  applyClassName = "rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover",
  testId
}: {
  value: string;
  onApply: (value: string) => void | Promise<void>;
  /** Whether applying an empty value (clearing the filter) is allowed. */
  allowEmpty?: boolean;
  id?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  applyClassName?: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Follow the applied value when it changes from outside (a reset button, Settings load).
  useEffect(() => setDraft(value), [value]);

  const inRange = draft === "" || ((!min || draft >= min) && (!max || draft <= max));
  const canApply = draft !== value && inRange && (draft !== "" || allowEmpty) && !disabled;
  const apply = () => {
    if (canApply) void onApply(draft);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <input
        id={id}
        type="date"
        data-testid={testId}
        className={className}
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          if (e.key === "Escape") setDraft(value);
        }}
      />
      {canApply && (
        <button type="button" className={applyClassName} onClick={apply}>
          Apply
        </button>
      )}
    </span>
  );
}
