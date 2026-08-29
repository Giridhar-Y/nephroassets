import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMovementSchedule, type MovementScheduleRow } from "../api/client.js";
import type { ColumnCondition } from "../lib/columnFilters.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import type { FySettings } from "../lib/types.js";

const PAGE_SIZE = 150;

// Same accumulate-pages-as-you-scroll shape as useAssetList.ts (Register's own hook) —
// deliberately not a copy-paste of that hook, since this report's row shape and query
// params differ, but the pattern (first page on mount/filter-change, loadMore appends)
// is identical on purpose. `items` here are location-stay rows, not one-per-asset — a
// page can return more rows than PAGE_SIZE since a mover expands into several.
export function useTransferDepreciationAssetList(fy: FySettings | null, conditions: ColumnCondition[]) {
  const [items, setItems] = useState<MovementScheduleRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settingsKey = fySettingsKey(fy);
  const conditionsKey = JSON.stringify(conditions);

  // A ref, not just the `loadingMore` state, guards against concurrent fetches: the
  // list's virtualizer effect can call `loadMore` several times back-to-back within the
  // same tick (its own dependency array includes `virtualizer.getVirtualItems()`, a
  // fresh array every render), and React never applies a `setState` synchronously
  // mid-render — every one of those calls would otherwise still read `loadingMore` as
  // `false` and all fire a fetch for the SAME cursor, each appending a duplicate copy of
  // the same page once their responses land. Found live: a single scroll action produced
  // 9 identical `cursor=FAR-000138` requests and ~1,350 duplicate rows in the list. A
  // ref mutation is visible synchronously to every one of those calls, unlike state.
  const loadingMoreRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    if (!fy) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMovementSchedule({ asAt: fy.asAt, conditions, limit: PAGE_SIZE });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the report.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, conditionsKey]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!fy || !nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetchMovementSchedule({
        asAt: fy.asAt,
        conditions,
        limit: PAGE_SIZE,
        cursor: nextCursor
      });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more rows.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, conditionsKey, nextCursor]);

  return { items, nextCursor, loading, loadingMore, error, reload: loadFirstPage, loadMore };
}
