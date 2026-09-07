import { useState } from "react";
import type { useColumnPrefs } from "../lib/useColumnPrefs.js";
import { COLUMN_GROUPS } from "../lib/columns.js";
import { ChevronDownIcon, ChevronUpIcon, ColumnsIcon } from "../lib/icons.js";

export function ColumnPicker({ prefs }: { prefs: ReturnType<typeof useColumnPrefs> }) {
  const [open, setOpen] = useState(false);
  const { draft, isDirty, hasSavedView, allColumns, toggleColumn, toggleGroup, moveColumn, saveView, resetToDefault } = prefs;

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:border-accent hover:text-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <ColumnsIcon fontSize={14} />
        Columns
        {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Unsaved changes" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
            <div className="max-h-96 space-y-3 overflow-y-auto px-1 py-1">
              {COLUMN_GROUPS.map((group) => {
                const groupColumns = draft.order
                  .map((id) => allColumns.find((c) => c.id === id))
                  .filter((c): c is (typeof allColumns)[number] => !!c && c.group === group.id);
                const visibleCount = groupColumns.filter((c) => draft.visible.includes(c.id)).length;
                const allVisible = visibleCount === groupColumns.length;
                const someVisible = visibleCount > 0 && !allVisible;

                return (
                  <div key={group.id}>
                    <label className="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-1.5 py-1 text-[11px] font-bold uppercase tracking-wide text-gray-600">
                      <input
                        type="checkbox"
                        checked={allVisible}
                        ref={(el) => {
                          if (el) el.indeterminate = someVisible;
                        }}
                        onChange={() => toggleGroup(group.id)}
                        className="accent-accent"
                      />
                      {group.label}
                      <span className="ml-auto font-normal normal-case text-gray-500">
                        {visibleCount}/{groupColumns.length}
                      </span>
                    </label>
                    <ul className="mt-0.5 space-y-0.5">
                      {groupColumns.map((col) => {
                        const visible = draft.visible.includes(col.id);
                        return (
                          <li key={col.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-50">
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={visible}
                                onChange={() => toggleColumn(col.id)}
                                className="accent-accent"
                              />
                              {col.label}
                            </label>
                            <span className="flex gap-1">
                              <button
                                type="button"
                                aria-label={`Move ${col.label} up`}
                                className="grid place-items-center text-gray-400 hover:text-ink"
                                onClick={() => moveColumn(col.id, -1)}
                              >
                                <ChevronUpIcon fontSize={14} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${col.label} down`}
                                className="grid place-items-center text-gray-400 hover:text-ink"
                                onClick={() => moveColumn(col.id, 1)}
                              >
                                <ChevronDownIcon fontSize={14} />
                              </button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-left text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-ink"
                onClick={resetToDefault}
              >
                Reset to Default View
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={saveView}
                disabled={!isDirty}
              >
                {hasSavedView ? "Save My View" : "Save as My View"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
