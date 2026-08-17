import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AssetFilters } from "./types.js";

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
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

// Filters persist for the browser session (not reset navigating between Register,
// Location Summary, etc.) so users don't have to re-pick the center they're working
// within on every screen.
export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<AssetFilters>(loadInitial);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

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

  return (
    <FiltersContext.Provider value={{ filters, setFilter, clearFilter, clearAll }}>
      {children}
    </FiltersContext.Provider>
  );
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within FiltersProvider");
  return ctx;
}
