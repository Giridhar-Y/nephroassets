import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FilterIcon } from "../lib/icons.js";
import {
  NO_VALUE_OPS,
  OPERATORS_BY_TYPE,
  TWO_VALUE_OPS,
  isConditionComplete,
  type ColumnCondition,
  type ColumnFilterType
} from "../lib/columnFilters.js";

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
        aria-label={active ? `Filter ${label} (filter applied)` : `Filter ${label}`}
        title={active ? "Filter applied — click to change or clear" : "Filter"}
        className={`flex items-center rounded-full p-1 normal-case ${
          active ? "bg-ink text-white" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
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

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="self-start text-[10px] font-semibold text-accent hover:underline" onClick={onClick}>
      Clear
    </button>
  );
}

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
      {value && <ClearButton onClick={() => onChange("")} />}
    </div>
  );
}

/** Pick any number of values — an empty selection means "All", same as the old
 *  single-select's blank option. Doesn't auto-close its popover (unlike the old
 *  single-select, which called `close()` on pick) since picking more than one option is
 *  the whole point; dismiss via click-outside or Escape like the text/date panels. The
 *  search box filters which options are *shown*, not the selection itself — a checked
 *  option stays checked even while scrolled out of view by a search term, same as
 *  Excel's autofilter search. */
export function SelectFilterPanel({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const id = useId();

  function toggle(option: string) {
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);
  }

  const visibleOptions = search
    ? options.filter((o) => o.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      {options.length > 8 && (
        <input
          id={id}
          type="text"
          autoFocus
          placeholder={`Search ${label.toLowerCase()}…`}
          className={FIELD_INPUT_CLASS}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="max-h-48 overflow-y-auto rounded-md border border-gray-300">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-gray-400">No options yet.</p>
        ) : visibleOptions.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-gray-400">No matches for "{search}".</p>
        ) : (
          visibleOptions.map((o) => (
            <label
              key={o}
              className="flex items-center gap-2 px-2 py-1 text-xs text-ink hover:bg-gray-50 first:rounded-t-md last:rounded-b-md"
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={value.includes(o)}
                onChange={() => toggle(o)}
              />
              {o}
            </label>
          ))
        )}
      </div>
      {value.length > 0 && <ClearButton onClick={() => onChange([])} />}
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
      {(from || to) && (
        <ClearButton
          onClick={() => {
            onChangeFrom("");
            onChangeTo("");
          }}
        />
      )}
    </div>
  );
}

/** Excel's "Text/Number/Date Filters" submenu: pick an operator, then supply however
 *  many values that operator needs (zero for e.g. "Blank"/"Today", one for most, two for
 *  "Between"). Holds its own local draft state rather than mirroring `condition` on every
 *  keystroke: picking an operator that needs a value (e.g. "Begins with") produces an
 *  incomplete condition until a value is typed, and the caller (RegisterPage) drops an
 *  incomplete condition from its committed filter list — if this component had no state
 *  of its own, that drop would erase the just-picked operator on the very next render,
 *  snapping the dropdown back to "Equals" before the user could type anything. Since
 *  ColumnFilterPopover only mounts its children while open (see its `{open && ...}`
 *  above), a fresh `useState` initializer already gives the right "reset to committed
 *  state when reopened" behavior with no extra sync effect needed. `onChange` still
 *  fires on every keystroke, same as before — it's just no longer this component's only
 *  memory of what's been picked so far. */
export function ConditionFilterPanel({
  label,
  columnId,
  type,
  condition,
  onChange
}: {
  label: string;
  columnId: string;
  type: ColumnFilterType;
  condition: ColumnCondition | undefined;
  onChange: (next: ColumnCondition | undefined) => void;
}) {
  const operators = OPERATORS_BY_TYPE[type];
  const [draft, setDraft] = useState<ColumnCondition>(
    () => condition ?? { columnId, type, op: operators[0]!.value, value: undefined, valueTo: undefined }
  );
  const needsValue = !NO_VALUE_OPS.has(draft.op);
  const needsSecondValue = TWO_VALUE_OPS.has(draft.op);
  const inputType = type === "date" ? "date" : type === "number" ? "number" : "text";
  const opId = useId();
  const valueId = useId();

  function commit(patch: Partial<Pick<ColumnCondition, "op" | "value" | "valueTo">>) {
    const next: ColumnCondition = { ...draft, ...patch };
    setDraft(next);
    onChange(isConditionComplete(next) ? next : undefined);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={opId} className={FIELD_LABEL_CLASS}>
          {label}
        </label>
        <select
          id={opId}
          className={FIELD_INPUT_CLASS}
          value={draft.op}
          onChange={(e) => commit({ op: e.target.value as ColumnCondition["op"], value: undefined, valueTo: undefined })}
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {needsValue && (
        <input
          id={valueId}
          type={inputType}
          autoFocus
          className={FIELD_INPUT_CLASS}
          value={draft.value ?? ""}
          onChange={(e) => commit({ value: e.target.value })}
        />
      )}
      {needsSecondValue && (
        <input
          type={inputType}
          placeholder="and…"
          className={FIELD_INPUT_CLASS}
          value={draft.valueTo ?? ""}
          onChange={(e) => commit({ valueTo: e.target.value })}
        />
      )}
      {(draft.value || draft.valueTo || draft.op !== operators[0]!.value) && (
        <ClearButton
          onClick={() => {
            const cleared: ColumnCondition = { columnId, type, op: operators[0]!.value, value: undefined, valueTo: undefined };
            setDraft(cleared);
            onChange(undefined);
          }}
        />
      )}
    </div>
  );
}

/** Excel's real per-column filter menu offers both at once: a checkbox list of distinct
 *  values, or a custom operator-based condition — picking one doesn't require abandoning
 *  the other, they're just two tabs on the same popover. Used for the handful of columns
 *  that have both a practical "distinct values" list (Sub Classification, Status, the two
 *  Location columns) and, like every other column, a full custom-condition mode. */
export function DualModeFilterPanel({
  label,
  columnId,
  type,
  options,
  selectValue,
  onSelectChange,
  condition,
  onConditionChange
}: {
  label: string;
  columnId: string;
  type: ColumnFilterType;
  options: string[];
  selectValue: string[];
  onSelectChange: (v: string[]) => void;
  condition: ColumnCondition | undefined;
  onConditionChange: (next: ColumnCondition | undefined) => void;
}) {
  const [mode, setMode] = useState<"values" | "custom">(condition ? "custom" : "values");
  const tabClass = (active: boolean) =>
    `text-[10px] font-bold uppercase tracking-wide ${active ? "text-accent underline" : "text-gray-400 hover:text-gray-600"}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className={tabClass(mode === "values")} onClick={() => setMode("values")}>
          Select Values
        </button>
        <span className="text-gray-300">·</span>
        <button type="button" className={tabClass(mode === "custom")} onClick={() => setMode("custom")}>
          Custom Filter
        </button>
      </div>
      {mode === "values" ? (
        <SelectFilterPanel label={label} options={options} value={selectValue} onChange={onSelectChange} />
      ) : (
        <ConditionFilterPanel label={label} columnId={columnId} type={type} condition={condition} onChange={onConditionChange} />
      )}
    </div>
  );
}
