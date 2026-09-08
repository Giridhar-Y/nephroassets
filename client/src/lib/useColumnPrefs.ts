import { useCallback, useState } from "react";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS, resolveColumns, type ColumnGroupId, type LabelContext, type RawColumnDef } from "./columns.js";
import type { AssetFilters } from "./types.js";

const OLD_STORAGE_KEY = "nephroassets.register.myView";
// Pre-per-user-scoping format: every user on a given browser read/wrote this SAME key.
const LEGACY_UNSCOPED_VIEWS_KEY = "nephroassets.register.views";
// Durable, per-user Saved Views live under this prefix (never the bare key above) —
// exported so persistedUiState.ts's logout sweep can recognize and skip it. A NAMED,
// explicitly-"Save as View"-d preference is meaningfully different from the ephemeral
// per-session UI state (live filters, sidebar-collapsed) that sweep exists to reset on a
// shared/kiosk browser: scoping by user id means a different user logging into the same
// browser never sees it (loads their own, different key), so it's safe to leave in place
// across logout rather than destroying it every time, which is what was silently
// deleting every user's saved views on every logout before this fix.
export const SAVED_VIEWS_KEY_PREFIX = "nephroassets.register.views.";
const MIN_COLUMN_WIDTH = 60;

function viewsStorageKey(userId: number): string {
  return `${SAVED_VIEWS_KEY_PREFIX}${userId}`;
}

export interface ColumnLayout {
  order: string[];
  visible: string[];
  widths: Record<string, number>;
}

/** A Saved View — D365-style, a named bundle of BOTH the column layout and the filters
 *  active when it was saved (or last updated). Selecting one applies both at once via
 *  FiltersContext's replaceFilters, not just the columns. */
export interface SavedView extends ColumnLayout {
  id: string;
  name: string;
  filters: AssetFilters;
}

interface ViewsState {
  views: SavedView[];
  activeViewId: string | null;
}

function defaultLayout(): ColumnLayout {
  return { order: ALL_COLUMNS.map((c) => c.id), visible: [...DEFAULT_VISIBLE_COLUMNS], widths: {} };
}

// A view saved before a column existed (e.g. one saved pre-upgrade) never silently
// hides that column forever — any id missing from the saved order/visible arrays is
// appended at the end, visible, so it's just as discoverable as it would be on a
// brand-new default layout.
function normalizeLayout(raw: Partial<ColumnLayout>): ColumnLayout {
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

function parseViewsState(rawText: string): ViewsState {
  const parsed = JSON.parse(rawText) as Partial<ViewsState>;
  const views = (parsed.views ?? []).map((v) => ({ ...normalizeLayout(v), id: v.id, name: v.name, filters: v.filters ?? {} }));
  const activeViewId = parsed.activeViewId && views.some((v) => v.id === parsed.activeViewId) ? parsed.activeViewId : null;
  return { views, activeViewId };
}

// One-time migration from the old single-"My View" format (a bare ColumnLayout with no
// name/filters/id at all) into the new array-of-named-views shape, so nobody who already
// had a saved layout silently loses it on this upgrade. Runs only when this user's own
// scoped key has never been written yet. Removes the old key once migrated so it's never
// read again (by this user or, since it long predates per-user scoping, a different one).
function migrateOldSingleView(): ViewsState | null {
  try {
    const rawText = localStorage.getItem(OLD_STORAGE_KEY);
    if (!rawText) return null;
    const layout = normalizeLayout(JSON.parse(rawText) as Partial<ColumnLayout>);
    const view: SavedView = { id: crypto.randomUUID(), name: "My View", filters: {}, ...layout };
    localStorage.removeItem(OLD_STORAGE_KEY);
    return { views: [view], activeViewId: view.id };
  } catch {
    return null;
  }
}

// One-time migration from the pre-per-user-scoping shared key (see
// LEGACY_UNSCOPED_VIEWS_KEY's own comment — every user on a browser used to read/write
// the SAME key) into this user's own scoped key, so nobody who already had Saved Views
// from before this fix loses them on their very next load. Removed once migrated, same
// reasoning as migrateOldSingleView above.
function migrateLegacyUnscopedViews(): ViewsState | null {
  try {
    const rawText = localStorage.getItem(LEGACY_UNSCOPED_VIEWS_KEY);
    if (!rawText) return null;
    const state = parseViewsState(rawText);
    localStorage.removeItem(LEGACY_UNSCOPED_VIEWS_KEY);
    return state;
  } catch {
    return null;
  }
}

function loadViewsState(userId: number): ViewsState {
  try {
    const rawText = localStorage.getItem(viewsStorageKey(userId));
    if (rawText) return parseViewsState(rawText);
  } catch {
    // fall through to migration/default below
  }
  const migrated = migrateLegacyUnscopedViews() ?? migrateOldSingleView();
  if (!migrated) return { views: [], activeViewId: null };
  // Written immediately, not left to the next persist() call — both migration functions
  // above already removed the OLD key as part of migrating, so a session that migrates
  // but never itself changes anything (no toggle/save/etc., just opens Register and
  // leaves) must not lose the data anyway: the old key is gone and gone is the only other
  // place it lived.
  persist(userId, migrated);
  return migrated;
}

function persist(userId: number, state: ViewsState): void {
  localStorage.setItem(viewsStorageKey(userId), JSON.stringify(state));
}

/** Register's column configuration AND filters, combined: a live "draft" (whatever's
 *  currently toggled/reordered/resized, plus FiltersContext's own live `filters`) against
 *  a set of named Saved Views persisted to localStorage — Dynamics-365-style, where
 *  changes only stick once explicitly saved/updated. Reloading without saving reverts to
 *  whichever view was last active (or the full default layout + no filters if none ever
 *  was).
 *
 *  localStorage, not a server table: every other Register UI preference this app has
 *  (session filters, sidebar-collapsed state) already lives client-side, following the
 *  same convention rather than introducing the first server-persisted UI preference in
 *  the app. Unlike THOSE (genuinely ephemeral, reset every logout on purpose — see
 *  persistedUiState.ts), Saved Views are keyed per-user (SAVED_VIEWS_KEY_PREFIX above)
 *  and deliberately excluded from that sweep: a name the user typed and explicitly chose
 *  to save is a durable preference, not per-session state, and scoping by user id already
 *  prevents a different person logging into the same browser from ever seeing it. The
 *  real tradeoff is no cross-device/browser sync; if that becomes a real ask, promoting
 *  this to a small `register_views` table + CRUD route later is a contained change (this
 *  hook's return shape wouldn't need to change, only loadViewsState/persist's insides).
 *  `userId` identifies whose scoped key to read/write — RegisterPage (this hook's only
 *  caller) only ever mounts inside RequireAuth, so a real signed-in user's id is always
 *  available by the time this runs. */
export function useColumnPrefs(ctx: LabelContext, filters: AssetFilters, replaceFilters: (next: AssetFilters) => void, userId: number) {
  const [{ views, activeViewId }, setViewsState] = useState<ViewsState>(() => loadViewsState(userId));
  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const [draft, setDraft] = useState<ColumnLayout>(() => activeView ?? defaultLayout());

  const setState = useCallback(
    (next: ViewsState) => {
      persist(userId, next);
      setViewsState(next);
    },
    [userId]
  );

  // Compare against just the layout fields of activeView (it also carries id/name/
  // filters, which would never match draft's bare {order,visible,widths} shape).
  const savedLayout: ColumnLayout = activeView
    ? { order: activeView.order, visible: activeView.visible, widths: activeView.widths }
    : defaultLayout();
  const isDirty =
    JSON.stringify({ layout: draft, filters }) !== JSON.stringify({ layout: savedLayout, filters: activeView?.filters ?? {} });

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

  /** Selecting a view from the dropdown — applies both its columns (into `draft`) and its
   *  filters (via FiltersContext's replaceFilters), matching what it looked like at save/
   *  update time. */
  const applyView = useCallback(
    (id: string) => {
      const view = views.find((v) => v.id === id);
      if (!view) return;
      setDraft(normalizeLayout(view));
      replaceFilters(view.filters);
      setState({ views, activeViewId: id });
    },
    [views, replaceFilters, setState]
  );

  const saveNewView = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const view: SavedView = { id: crypto.randomUUID(), name: trimmed, filters, ...draft };
      setState({ views: [...views, view], activeViewId: view.id });
    },
    [draft, filters, views, setState]
  );

  const updateActiveView = useCallback(() => {
    if (!activeViewId) return;
    setState({
      views: views.map((v) => (v.id === activeViewId ? { ...v, filters, ...draft } : v)),
      activeViewId
    });
  }, [activeViewId, draft, filters, views, setState]);

  const renameActiveView = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || !activeViewId) return;
      setState({ views: views.map((v) => (v.id === activeViewId ? { ...v, name: trimmed } : v)), activeViewId });
    },
    [activeViewId, views, setState]
  );

  // Deleting a view removes it from the saved list only — it never touches what's
  // currently showing (draft columns, live filters), so removing the view you happen to
  // be "on" doesn't yank the screen out from under you; it just stops being anyone's
  // active view going forward.
  const deleteView = useCallback(
    (id: string) => {
      const nextViews = views.filter((v) => v.id !== id);
      setState({ views: nextViews, activeViewId: activeViewId === id ? null : activeViewId });
    },
    [views, activeViewId, setState]
  );

  // Columns only, same as before this feature — filters have their own dedicated "Clear
  // all filters" control on Register's own toolbar, so Reset to Default staying
  // columns-only avoids one button silently doing two people's idea of "reset".
  const resetToDefault = useCallback(() => {
    setDraft(defaultLayout());
    setState({ views, activeViewId: null });
  }, [views, setState]);

  /** Restores an exact prior {draft, activeViewId} snapshot — the Undo half of
   *  ColumnPicker's "Reset to Default" toast (same Undo-toast pattern AI Register
   *  Search's own Apply Filters already uses). The caller captures the snapshot itself
   *  right before calling resetToDefault(); this doesn't need to remember anything. */
  const applySnapshot = useCallback(
    (snapshot: { draft: ColumnLayout; activeViewId: string | null }) => {
      setDraft(snapshot.draft);
      setState({ views, activeViewId: snapshot.activeViewId });
    },
    [views, setState]
  );

  const rawColumns: RawColumnDef[] = draft.order
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((c): c is RawColumnDef => !!c && draft.visible.includes(c.id))
    .map((c) => (draft.widths[c.id] ? { ...c, width: draft.widths[c.id]! } : c));

  const columns = resolveColumns(rawColumns, ctx);
  const allColumns = resolveColumns(ALL_COLUMNS, ctx);

  return {
    draft,
    isDirty,
    views,
    activeView,
    columns,
    allColumns,
    toggleColumn,
    toggleGroup,
    moveColumn,
    moveColumnTo,
    setColumnWidth,
    applyView,
    saveNewView,
    updateActiveView,
    renameActiveView,
    deleteView,
    resetToDefault,
    applySnapshot
  };
}
