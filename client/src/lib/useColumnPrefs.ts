import { useCallback, useEffect, useState } from "react";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS } from "./columns.js";

const STORAGE_KEY = "nephroassets.columns";

interface ColumnPrefs {
  order: string[];
  visible: string[];
}

function loadPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ColumnPrefs;
  } catch {
    // fall through to defaults
  }
  return { order: ALL_COLUMNS.map((c) => c.id), visible: DEFAULT_VISIBLE_COLUMNS };
}

export function useColumnPrefs() {
  const [prefs, setPrefs] = useState<ColumnPrefs>(loadPrefs);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const toggleColumn = useCallback((id: string) => {
    setPrefs((prev) => ({
      ...prev,
      visible: prev.visible.includes(id) ? prev.visible.filter((c) => c !== id) : [...prev.visible, id]
    }));
  }, []);

  const moveColumn = useCallback((id: string, direction: -1 | 1) => {
    setPrefs((prev) => {
      const order = [...prev.order];
      const idx = order.indexOf(id);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= order.length) return prev;
      [order[idx], order[target]] = [order[target]!, order[idx]!];
      return { ...prev, order };
    });
  }, []);

  const columns = prefs.order
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((c): c is (typeof ALL_COLUMNS)[number] => !!c && prefs.visible.includes(c.id));

  return { prefs, columns, allColumns: ALL_COLUMNS, toggleColumn, moveColumn };
}
