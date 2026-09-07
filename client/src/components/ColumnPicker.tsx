import { useState, type ReactNode } from "react";
import type { useColumnPrefs } from "../lib/useColumnPrefs.js";
import { COLUMN_GROUPS } from "../lib/columns.js";
import { ChevronDownIcon, ChevronUpIcon, ColumnsIcon, DeleteIcon, EditIcon, SaveAsNewIcon, SaveIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

const NAME_INPUT_CLASS =
  "flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

/** Small icon-only action button for the view-management row — Save as new / Update /
 *  Rename / Delete all share this shape, differing only by icon/label/handler. `title`
 *  overrides the tooltip/aria-label (e.g. Update shows the active view's full name
 *  there) while keeping the visible `label` text short enough for four of these to fit
 *  in a 320px popover. */
function ViewActionButton({
  label,
  title,
  icon,
  disabled,
  onClick
}: {
  label: string;
  title?: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {icon}
      {label}
    </button>
  );
}

export function ColumnPicker({ prefs }: { prefs: ReturnType<typeof useColumnPrefs> }) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<null | "new" | "rename">(null);
  const [nameInput, setNameInput] = useState("");
  const { showToast } = useToast();
  const {
    draft,
    isDirty,
    views,
    activeView,
    allColumns,
    toggleColumn,
    toggleGroup,
    moveColumn,
    applyView,
    saveNewView,
    updateActiveView,
    renameActiveView,
    deleteView,
    resetToDefault,
    applySnapshot
  } = prefs;

  function startNaming(mode: "new" | "rename") {
    setNameInput(mode === "rename" ? (activeView?.name ?? "") : "");
    setNaming(mode);
  }

  // Same Undo-toast pattern AI Register Search's own Apply Filters already uses
  // (AiSearchPanel.tsx) — Reset to Default is otherwise a silent, irreversible action
  // (no confirmation dialog, matching this button's existing low-ceremony precedent),
  // so the toast is the one chance to walk it back.
  function handleResetToDefault() {
    const snapshot = { draft, activeViewId: activeView?.id ?? null };
    resetToDefault();
    showToast("Columns reset to default.", "success", { label: "Undo", onClick: () => applySnapshot(snapshot) });
  }

  function commitNaming() {
    if (naming === "new") saveNewView(nameInput);
    else if (naming === "rename") renameActiveView(nameInput);
    setNaming(null);
  }

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
            {/* View management — a "view" bundles column layout AND the current filters
                (see useColumnPrefs.ts's own comment). Selecting one from the dropdown
                applies both at once. */}
            <div className="space-y-1.5 border-b border-gray-100 px-1 pb-2">
              <label className={FIELD_LABEL_CLASS}>View</label>
              <select
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={activeView?.id ?? ""}
                onChange={(e) => (e.target.value ? applyView(e.target.value) : resetToDefault())}
              >
                <option value="">Default (unsaved)</option>
                {views.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id === activeView?.id ? "• " : ""}
                    {v.name}
                  </option>
                ))}
              </select>

              {naming ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    placeholder="View name"
                    maxLength={60}
                    className={NAME_INPUT_CLASS}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitNaming();
                      if (e.key === "Escape") setNaming(null);
                    }}
                  />
                  <button
                    type="button"
                    className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!nameInput.trim()}
                    onClick={commitNaming}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-gray-300 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
                    onClick={() => setNaming(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-0.5">
                  <ViewActionButton label="Save as new" icon={<SaveAsNewIcon fontSize={12} />} onClick={() => startNaming("new")} />
                  <ViewActionButton
                    label="Update"
                    title={activeView ? `Update "${activeView.name}"` : "Update"}
                    icon={<SaveIcon fontSize={12} />}
                    disabled={!activeView || !isDirty}
                    onClick={updateActiveView}
                  />
                  <ViewActionButton
                    label="Rename"
                    icon={<EditIcon fontSize={12} />}
                    disabled={!activeView}
                    onClick={() => startNaming("rename")}
                  />
                  <ViewActionButton
                    label="Delete"
                    icon={<DeleteIcon fontSize={12} />}
                    disabled={!activeView}
                    onClick={() => activeView && deleteView(activeView.id)}
                  />
                </div>
              )}
            </div>

            <div className="max-h-96 space-y-3 overflow-y-auto px-1 py-2">
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
                onClick={handleResetToDefault}
              >
                Reset to Default View
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const FIELD_LABEL_CLASS = "block text-[10px] font-bold uppercase tracking-wide text-gray-400";
