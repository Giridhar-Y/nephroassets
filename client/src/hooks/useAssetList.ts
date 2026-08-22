import { useCallback, useEffect, useState } from "react";
import { fetchAssets } from "../api/client.js";
import type { AssetFilters, AssetListItem, FySettings } from "../lib/types.js";
import { fySettingsKey } from "../lib/settingsKey.js";

const PAGE_SIZE = 150;

export interface AssetListSort {
  sortBy?: "farId" | "dateAcquired" | "subClassification" | "status" | "location";
  sortDir?: "asc" | "desc";
}

// `sort` defaults to the server's own default (farId, asc) when omitted — pass a
// memoized object (e.g. via useMemo) so it doesn't trigger a refetch every render.
export function useAssetList(fy: FySettings | null, filters: AssetFilters, sort?: AssetListSort) {
  const [items, setItems] = useState<AssetListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Depends on every FY setting (not just AS_AT) — changing FY Start, FY End, or Days
  // in FY from the Settings page must also recompute the register, not just AS_AT.
  const settingsKey = fySettingsKey(fy);

  const loadFirstPage = useCallback(async () => {
    if (!fy) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAssets({ asAt: fy.asAt, ...filters, ...sort, limit: PAGE_SIZE });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load assets.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, filters, sort]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!fy || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchAssets({ asAt: fy.asAt, ...filters, ...sort, limit: PAGE_SIZE, cursor: nextCursor });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more rows.");
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, filters, sort, nextCursor, loadingMore]);

  return { items, nextCursor, loading, loadingMore, error, reload: loadFirstPage, loadMore };
}
