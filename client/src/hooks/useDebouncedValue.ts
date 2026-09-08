import { useEffect, useState } from "react";

// Shared by every text-typing filter input (Register's global search box,
// ColumnFilterPopover.tsx's Excel-style column value inputs) so they all feel
// consistent — standard search-box debounce range is 300-400ms; picked the low end so
// it still reads as "instant" to someone typing at a normal pace.
export const SEARCH_DEBOUNCE_MS = 300;

/** Returns `value`, but lagging: only catches up to the latest value once `delayMs` has
 *  passed without it changing again — the standard "search box" debounce, so typing a
 *  10-character term doesn't fire 10 rapid-fire network requests (one per keystroke)
 *  against a 220k-row table. Never use this for what a controlled input's own `value`
 *  prop is bound to (that would make typing itself feel laggy) — pair it with a separate,
 *  instantly-updating local state for the displayed value, and debounce only the
 *  downstream side effect (the actual filter dispatch / fetch) this hook's return value
 *  drives. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
