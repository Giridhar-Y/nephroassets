import { DismissIcon } from "../../lib/icons.js";

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

// One removable pill per active filter — a leftover filter from an earlier task is easy
// to miss with only a count badge, and easy to misread the data because of, especially
// on a finance tool. Renders nothing when there's nothing active.
export function FilterChips({ chips }: { chips: FilterChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-white px-6 py-2">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full bg-accent-light py-1 pl-2.5 pr-1.5 text-xs font-medium text-accent-hover"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={chip.onRemove}
            className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full hover:bg-black/10"
          >
            <DismissIcon fontSize={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
