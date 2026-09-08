import { useEffect, useId, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { DismissIcon, FilterIcon } from "../lib/icons.js";
import { SEARCH_DEBOUNCE_MS } from "../hooks/useDebouncedValue.js";
import {
  MAX_IN_VALUES,
  MULTI_VALUE_OPS,
  NO_VALUE_OPS,
  OPERATORS_BY_TYPE,
  TWO_VALUE_OPS,
  isConditionComplete,
  type ColumnCondition,
  type ColumnFilterType
} from "../lib/columnFilters.js";

// Splits a paste on newlines/tabs (an Excel column or row copies as either, depending on
// how many cells were selected) into trimmed, non-empty tokens — 2+ tokens is what
// triggers the "is any of" auto-switch; a single-line paste behaves exactly like typing.
function parsePastedList(text: string): string[] {
  return text
    .split(/[\r\n\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  const isMulti = MULTI_VALUE_OPS.has(draft.op);
  const inputType = type === "date" ? "date" : type === "number" ? "number" : "text";
  const opId = useId();
  const valueId = useId();
  const [chipDraft, setChipDraft] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(debounceRef.current ?? undefined), []);

  function commit(patch: Partial<Pick<ColumnCondition, "op" | "value" | "valueTo">>) {
    clearTimeout(debounceRef.current ?? undefined);
    const next: ColumnCondition = { ...draft, ...patch };
    setDraft(next);
    onChange(isConditionComplete(next) ? next : undefined);
  }

  // Same as commit() above, but debounced — draft (what the input displays) still
  // updates immediately, so typing never lags; only onChange (which flows to
  // RegisterPage's setCondition -> setFilter -> useAssetList's fetch) waits for typing to
  // pause, so a 10-character value doesn't fire 10 rapid-fire queries against a 220k-row
  // table. Used only by the two raw-text/number value inputs below — every other commit()
  // call site (the operator dropdown, "is any of" chip add/remove) is a single, deliberate
  // action that should still apply instantly, not lag behind an artificial delay.
  function commitValueDebounced(patch: Partial<Pick<ColumnCondition, "value" | "valueTo">>) {
    const next: ColumnCondition = { ...draft, ...patch };
    setDraft(next);
    clearTimeout(debounceRef.current ?? undefined);
    debounceRef.current = setTimeout(() => onChange(isConditionComplete(next) ? next : undefined), SEARCH_DEBOUNCE_MS);
  }

  // Numbers only keep tokens that actually parse — a stray non-numeric line in a pasted
  // list is silently dropped rather than blocking the whole paste (an empty token was
  // already filtered out by parsePastedList); text columns keep every token as-is.
  function cleanTokens(tokens: string[]): string[] {
    return type === "number" ? tokens.filter((t) => Number.isFinite(Number(t))) : tokens;
  }

  function addValues(newValues: string[]) {
    const existing = Array.isArray(draft.value) ? draft.value : [];
    const merged = Array.from(new Set([...existing, ...cleanTokens(newValues)]));
    if (merged.length === 0) return;
    if (merged.length > MAX_IN_VALUES) {
      setPasteError(`That's ${merged.length} values — the limit is ${MAX_IN_VALUES}. Trim the list and try again.`);
      return;
    }
    setPasteError(null);
    commit({ op: "in", value: merged });
  }

  // Pasting 2+ newline/tab-separated values into ANY value field (not just once already
  // in "is any of" mode) auto-detects the list and switches modes — this is the "paste a
  // column copied from Excel" entry point the plain single-value input doesn't otherwise
  // have a reason to special-case.
  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const tokens = parsePastedList(e.clipboardData.getData("text"));
    if (tokens.length < 2) return;
    e.preventDefault();
    addValues(tokens);
  }

  const multiValues = isMulti && Array.isArray(draft.value) ? draft.value : [];
  const isDirty = isMulti ? multiValues.length > 0 : Boolean(draft.value) || Boolean(draft.valueTo) || draft.op !== operators[0]!.value;

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
          onChange={(e) => {
            setPasteError(null);
            commit({ op: e.target.value as ColumnCondition["op"], value: undefined, valueTo: undefined });
          }}
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {needsValue && isMulti && (
        <div className="flex flex-col gap-1">
          <div className="flex min-h-[2rem] flex-wrap gap-1 rounded-md border border-gray-300 p-1.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
            {multiValues.map((v) => (
              <span key={v} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-ink">
                {v}
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  className="text-gray-400 hover:text-ink"
                  onClick={() => commit({ op: "in", value: multiValues.filter((x) => x !== v) })}
                >
                  <DismissIcon fontSize={10} />
                </button>
              </span>
            ))}
            <input
              type="text"
              aria-label={`${label} value`}
              autoFocus
              className="min-w-[100px] flex-1 border-none p-0 text-xs outline-none focus:ring-0"
              placeholder={multiValues.length === 0 ? "Paste or type values…" : "Add another…"}
              value={chipDraft}
              onChange={(e) => setChipDraft(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !chipDraft.trim()) return;
                e.preventDefault();
                addValues([chipDraft.trim()]);
                setChipDraft("");
              }}
            />
          </div>
          {pasteError && <p className="text-[10px] font-medium text-accent-hover">{pasteError}</p>}
        </div>
      )}
      {needsValue && !isMulti && (
        <input
          id={valueId}
          type={inputType}
          aria-label={`${label} value`}
          autoFocus
          className={FIELD_INPUT_CLASS}
          value={typeof draft.value === "string" ? draft.value : ""}
          onChange={(e) => commitValueDebounced({ value: e.target.value })}
          onPaste={handlePaste}
        />
      )}
      {needsSecondValue && (
        <input
          type={inputType}
          aria-label={`${label} value (to)`}
          placeholder="and…"
          className={FIELD_INPUT_CLASS}
          value={draft.valueTo ?? ""}
          onChange={(e) => commitValueDebounced({ valueTo: e.target.value })}
        />
      )}
      {isDirty && (
        <ClearButton
          onClick={() => {
            const cleared: ColumnCondition = { columnId, type, op: operators[0]!.value, value: undefined, valueTo: undefined };
            setDraft(cleared);
            setChipDraft("");
            setPasteError(null);
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
