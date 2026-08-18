import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FilterIcon } from "../lib/icons.js";

/** Excel-style filter: a small icon button in a column header that toggles a popover
 *  holding the actual control. `active` highlights the icon so users can see at a glance
 *  which columns are filtered. `children` gets a `close` callback so controls that
 *  resolve in one click (a `<select>`) can dismiss the popover themselves — text/date
 *  inputs typically ignore it and rely on the click-outside handler instead. */
export function ColumnFilterPopover({
  label,
  active,
  children
}: {
  label: string;
  active: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-label={`Filter ${label}`}
        className={`flex items-center rounded p-0.5 normal-case ${
          active ? "text-accent" : "text-gray-400 hover:text-gray-600"
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        <FilterIcon fontSize={13} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-gray-200 bg-white p-3 normal-case shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const FIELD_LABEL_CLASS = "text-[10px] font-bold uppercase tracking-wide text-gray-400";
const FIELD_INPUT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export function TextFilterPanel({
  label,
  placeholder,
  value,
  onChange
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoFocus
        placeholder={placeholder}
        className={FIELD_INPUT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function SelectFilterPanel({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      <select id={id} className={FIELD_INPUT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DateRangeFilterPanel({
  fromLabel,
  toLabel,
  from,
  to,
  onChangeFrom,
  onChangeTo
}: {
  fromLabel: string;
  toLabel: string;
  from: string;
  to: string;
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className={FIELD_LABEL_CLASS}>
          {fromLabel}
        </label>
        <input
          id={fromId}
          type="date"
          className={FIELD_INPUT_CLASS}
          value={from}
          onChange={(e) => onChangeFrom(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className={FIELD_LABEL_CLASS}>
          {toLabel}
        </label>
        <input id={toId} type="date" className={FIELD_INPUT_CLASS} value={to} onChange={(e) => onChangeTo(e.target.value)} />
      </div>
    </div>
  );
}
