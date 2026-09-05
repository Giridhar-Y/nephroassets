import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AssetFilters } from "./types.js";
import { PERSISTED_UI_STATE_CLEARED_EVENT } from "./persistedUiState.js";

const STORAGE_KEY = "nephroassets.filters";

function loadInitial(): AssetFilters {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AssetFilters) : {};
  } catch {
    return {};
  }
}

interface FiltersContextValue {
  filters: AssetFilters;
  setFilter: <K extends keyof AssetFilters>(key: K, value: AssetFilters[K]) => void;
  clearFilter: (key: keyof AssetFilters) => void;
  clearAll: () => void;
  /** Applies several fields in one state update (and one sessionStorage write) instead
   *  of one setFilter() call per field — for a caller like AI Register Search that
   *  resolves a whole filter set at once and needs it to land as a single, undoable
   *  change rather than a rapid sequence of partial ones. Returns the filters snapshot
   *  from just before the merge, so the caller can offer an exact "Undo" back to it. */
  mergeFilters: (partial: Partial<AssetFilters>) => AssetFilters;
  /** Replaces the whole filters object outright — used to restore an exact prior
   *  snapshot (e.g. AI Register Search's "Undo" toast action), where a plain merge could
   *  leave a field the snapshot never had. */
  replaceFilters: (next: AssetFilters) => void;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

// Filters persist for the browser session (not reset navigating between Register,
// Location Summary, etc.) so users don't have to re-pick the center they're working
// within on every screen.
export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<AssetFilters>(loadInitial);

  // No filters applied stores no key at all, rather than an empty `{}` — otherwise
  // clearAll() (and the logout sweep below, which also resets filters to {}) would leave
  // a harmless-but-misleading key behind immediately after a clear that's supposed to
  // remove it.
  useEffect(() => {
    if (Object.keys(filters).length === 0) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  // FiltersProvider is mounted above the route switch (App.tsx), so it doesn't unmount
  // on logout the way Register/Location Summary do — without this it would keep
  // rendering the previous user's filters in memory even after clearPersistedUiState()
  // wipes sessionStorage out from under it.
  useEffect(() => {
    const onCleared = () => setFilters({});
    window.addEventListener(PERSISTED_UI_STATE_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(PERSISTED_UI_STATE_CLEARED_EVENT, onCleared);
  }, []);

  const setFilter: FiltersContextValue["setFilter"] = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilter = (key: keyof AssetFilters) => {
    setFilters((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const clearAll = () => setFilters({});

  const mergeFilters: FiltersContextValue["mergeFilters"] = (partial) => {
    const before = filters;
    setFilters((prev) => ({ ...prev, ...partial }));
    return before;
  };

  const replaceFilters = (next: AssetFilters) => setFilters(next);

  return (
    <FiltersContext.Provider value={{ filters, setFilter, clearFilter, clearAll, mergeFilters, replaceFilters }}>
      {children}
    </FiltersContext.Provider>
  );
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within FiltersProvider");
  return ctx;
}
