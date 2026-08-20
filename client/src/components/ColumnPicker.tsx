import { useState } from "react";
import type { useColumnPrefs } from "../lib/useColumnPrefs.js";
import { ChevronDownIcon, ChevronUpIcon, ColumnsIcon } from "../lib/icons.js";

export function ColumnPicker({ prefs }: { prefs: ReturnType<typeof useColumnPrefs> }) {
  const [open, setOpen] = useState(false);
  const { prefs: state, allColumns, toggleColumn, moveColumn, resetColumns } = prefs;

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:border-accent hover:text-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <ColumnsIcon fontSize={14} />
        Columns
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
            <ul className="max-h-80 space-y-0.5 overflow-y-auto">
              {state.order.map((id) => {
                const col = allColumns.find((c) => c.id === id);
                if (!col) return null;
                const visible = state.visible.includes(id);
                return (
                  <li key={id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-50">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={() => toggleColumn(id)}
                        className="accent-accent"
                      />
                      {col.label}
                    </label>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Move ${col.label} up`}
                        className="grid place-items-center text-gray-400 hover:text-ink"
                        onClick={() => moveColumn(id, -1)}
                      >
                        <ChevronUpIcon fontSize={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${col.label} down`}
                        className="grid place-items-center text-gray-400 hover:text-ink"
                        onClick={() => moveColumn(id, 1)}
                      >
                        <ChevronDownIcon fontSize={14} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-1 border-t border-gray-100 pt-1">
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-ink"
                onClick={resetColumns}
              >
                Reset to default columns, order &amp; widths
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
