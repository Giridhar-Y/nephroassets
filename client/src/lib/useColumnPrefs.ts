import { useCallback, useState } from "react";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS, resolveColumns, type ColumnGroupId, type LabelContext, type RawColumnDef } from "./columns.js";

const STORAGE_KEY = "nephroassets.register.myView";
const MIN_COLUMN_WIDTH = 60;

interface SavedView {
  order: string[];
  visible: string[];
  widths: Record<string, number>;
}

function defaultView(): SavedView {
  return { order: ALL_COLUMNS.map((c) => c.id), visible: [...DEFAULT_VISIBLE_COLUMNS], widths: {} };
}

// A view saved before a column existed (e.g. one saved pre-upgrade) never silently
// hides that column forever — any id missing from the saved order/visible arrays is
// appended at the end, visible, so it's just as discoverable as it would be on a
// brand-new "My View".
function normalizeView(raw: Partial<SavedView>): SavedView {
  const knownIds = ALL_COLUMNS.map((c) => c.id);
  const known = new Set(knownIds);
  const savedOrder = (raw.order ?? []).filter((id) => known.has(id));
  const missing = knownIds.filter((id) => !savedOrder.includes(id));
  const savedVisible = (raw.visible ?? []).filter((id) => known.has(id));
  return {
    order: [...savedOrder, ...missing],
    visible: [...savedVisible, ...missing],
    widths: raw.widths ?? {}
  };
}

function loadSavedView(): SavedView | null {
  try {
    const rawText = localStorage.getItem(STORAGE_KEY);
    if (!rawText) return null;
    return normalizeView(JSON.parse(rawText) as Partial<SavedView>);
  } catch {
    return null;
  }
}

/** Register's column configuration: a live "draft" (whatever's currently toggled/
 *  reordered/resized) plus a single named "My View" persisted to localStorage —
 *  Dynamics-365-style, where changes only stick once explicitly saved. Reloading
 *  without saving reverts to the last-saved "My View", or the full 39-column default
 *  if nothing has ever been saved. */
export function useColumnPrefs(ctx: LabelContext) {
  const [savedView, setSavedView] = useState<SavedView | null>(loadSavedView);
  const [draft, setDraft] = useState<SavedView>(() => savedView ?? defaultView());

  const isDirty = JSON.stringify(draft) !== JSON.stringify(savedView ?? defaultView());

  const toggleColumn = useCallback((id: string) => {
    setDraft((prev) => ({
      ...prev,
      visible: prev.visible.includes(id) ? prev.visible.filter((c) => c !== id) : [...prev.visible, id]
    }));
  }, []);

  const toggleGroup = useCallback((groupId: ColumnGroupId) => {
    setDraft((prev) => {
      const idsInGroup = ALL_COLUMNS.filter((c) => c.group === groupId).map((c) => c.id);
      const allVisible = idsInGroup.every((id) => prev.visible.includes(id));
      const visible = allVisible
        ? prev.visible.filter((id) => !idsInGroup.includes(id))
        : Array.from(new Set([...prev.visible, ...idsInGroup]));
      return { ...prev, visible };
    });
  }, []);

  const moveColumn = useCallback((id: string, direction: -1 | 1) => {
    setDraft((prev) => {
      const order = [...prev.order];
      const idx = order.indexOf(id);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= order.length) return prev;
      [order[idx], order[target]] = [order[target]!, order[idx]!];
      return { ...prev, order };
    });
  }, []);

  // Arbitrary drag-and-drop reorder: pulls `id` out of the order and reinserts it right
  // before `beforeId` — unlike moveColumn (adjacent swap only, used by the picker's
  // up/down buttons), a dragged header can be dropped anywhere in one move.
  const moveColumnTo = useCallback((id: string, beforeId: string) => {
    if (id === beforeId) return;
    setDraft((prev) => {
      const order = prev.order.filter((c) => c !== id);
      const targetIdx = order.indexOf(beforeId);
      if (targetIdx < 0) return prev;
      order.splice(targetIdx, 0, id);
      return { ...prev, order };
    });
  }, []);

  const setColumnWidth = useCallback((id: string, width: number) => {
    setDraft((prev) => ({ ...prev, widths: { ...prev.widths, [id]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } }));
  }, []);

  const saveView = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    setSavedView(draft);
  }, [draft]);

  // A genuine reset, not just a discardable draft change — clears the persisted "My
  // View" too, so reloading afterwards doesn't quietly bring the old columns back.
  const resetToDefault = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSavedView(null);
    setDraft(defaultView());
  }, []);

  const rawColumns: RawColumnDef[] = draft.order
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((c): c is RawColumnDef => !!c && draft.visible.includes(c.id))
    .map((c) => (draft.widths[c.id] ? { ...c, width: draft.widths[c.id]! } : c));

  const columns = resolveColumns(rawColumns, ctx);
  const allColumns = resolveColumns(ALL_COLUMNS, ctx);

  return {
    draft,
    isDirty,
    hasSavedView: savedView !== null,
    columns,
    allColumns,
    toggleColumn,
    toggleGroup,
    moveColumn,
    moveColumnTo,
    setColumnWidth,
    saveView,
    resetToDefault
  };
}
