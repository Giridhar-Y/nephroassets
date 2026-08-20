import { useCallback, useEffect, useState } from "react";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS } from "./columns.js";

const STORAGE_KEY = "nephroassets.columns";
const MIN_COLUMN_WIDTH = 60;

interface ColumnPrefs {
  order: string[];
  visible: string[];
  widths: Record<string, number>;
}

function loadPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
      return { order: parsed.order ?? ALL_COLUMNS.map((c) => c.id), visible: parsed.visible ?? DEFAULT_VISIBLE_COLUMNS, widths: parsed.widths ?? {} };
    }
  } catch {
    // fall through to defaults
  }
  return { order: ALL_COLUMNS.map((c) => c.id), visible: DEFAULT_VISIBLE_COLUMNS, widths: {} };
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

  // Arbitrary drag-and-drop reorder: pulls `id` out of the order and reinserts it right
  // before `beforeId` — unlike moveColumn (adjacent swap only, used by the picker's
  // up/down buttons), a dragged header can be dropped anywhere in one move.
  const moveColumnTo = useCallback((id: string, beforeId: string) => {
    if (id === beforeId) return;
    setPrefs((prev) => {
      const order = prev.order.filter((c) => c !== id);
      const targetIdx = order.indexOf(beforeId);
      if (targetIdx < 0) return prev;
      order.splice(targetIdx, 0, id);
      return { ...prev, order };
    });
  }, []);

  const setColumnWidth = useCallback((id: string, width: number) => {
    setPrefs((prev) => ({ ...prev, widths: { ...prev.widths, [id]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } }));
  }, []);

  const resetColumns = useCallback(() => {
    setPrefs({ order: ALL_COLUMNS.map((c) => c.id), visible: DEFAULT_VISIBLE_COLUMNS, widths: {} });
  }, []);

  const columns = prefs.order
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((c): c is (typeof ALL_COLUMNS)[number] => !!c && prefs.visible.includes(c.id))
    .map((c) => (prefs.widths[c.id] ? { ...c, width: prefs.widths[c.id]! } : c));

  return { prefs, columns, allColumns: ALL_COLUMNS, toggleColumn, moveColumn, moveColumnTo, setColumnWidth, resetColumns };
}
