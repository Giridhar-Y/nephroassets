import { useCallback, useEffect, useState } from "react";
import { fetchCenters, fetchTransferHistory, type TransferHistoryFilters, type TransferHistoryItem } from "../api/client.js";
import { formatDate } from "../lib/format.js";
import { ColumnFilterPopover, DateRangeFilterPanel, SelectFilterPanel, TextFilterPanel } from "../components/ColumnFilterPopover.js";
import { EmptyIcon, ErrorIcon, HistoryIcon, RetryIcon } from "../lib/icons.js";

const PAGE_SIZE = 100;

// Read-only history log — not a workflow of its own. Initiating a transfer still only
// happens via the center-first picker in Register, per the requirements doc.
export function TransfersPage() {
  const [filters, setFilters] = useState<TransferHistoryFilters>({});
  const [centers, setCenters] = useState<string[]>([]);
  const [items, setItems] = useState<TransferHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
  }, []);

  const setFilter = <K extends keyof TransferHistoryFilters>(key: K, value: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTransferHistory({ ...filters, limit: PAGE_SIZE });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load transfer history.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchTransferHistory({ ...filters, limit: PAGE_SIZE, cursor: nextCursor });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more rows.");
    } finally {
      setLoadingMore(false);
    }
  }

  const hasActiveFilters = Object.keys(filters).length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <HistoryIcon fontSize={20} />
          Transfers
        </h1>
        <p className="mt-1 text-sm text-gray-500">A history of every transfer between centers, newest first.</p>
        {hasActiveFilters && (
          <div className="mt-2 flex items-center gap-2">
            <span className="flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
              {Object.keys(filters).length} filter{Object.keys(filters).length === 1 ? "" : "s"} applied
            </span>
            <button
              type="button"
              className="text-xs font-medium text-accent hover:underline"
              onClick={() => setFilters({})}
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-1.5 border-b border-red-100 bg-red-50 px-6 py-2 text-sm text-red-700">
          <ErrorIcon fontSize={15} />
          {error}{" "}
          <button className="flex items-center gap-1 font-semibold underline" onClick={load}>
            <RetryIcon fontSize={13} />
            Retry
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="border-b-2 border-gray-300">
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                <div className="flex items-center justify-between gap-1">
                  <span>FAR ID</span>
                  <ColumnFilterPopover label="FAR ID" active={!!filters.search}>
                    {() => (
                      <TextFilterPanel
                        label="FAR ID"
                        placeholder="e.g. FAR-000123"
                        value={filters.search ?? ""}
                        onChange={(v) => setFilter("search", v)}
                      />
                    )}
                  </ColumnFilterPopover>
                </div>
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                <div className="flex items-center justify-between gap-1">
                  <span>Description</span>
                  <ColumnFilterPopover label="Description" active={!!filters.descriptionSearch}>
                    {() => (
                      <TextFilterPanel
                        label="Description"
                        placeholder="Search description…"
                        value={filters.descriptionSearch ?? ""}
                        onChange={(v) => setFilter("descriptionSearch", v)}
                      />
                    )}
                  </ColumnFilterPopover>
                </div>
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                <div className="flex items-center justify-between gap-1">
                  <span>Transfer Date</span>
                  <ColumnFilterPopover
                    label="Transfer Date"
                    active={!!(filters.transactionDateFrom || filters.transactionDateTo)}
                  >
                    {() => (
                      <DateRangeFilterPanel
                        fromLabel="From"
                        toLabel="To"
                        from={filters.transactionDateFrom ?? ""}
                        to={filters.transactionDateTo ?? ""}
                        onChangeFrom={(v) => setFilter("transactionDateFrom", v)}
                        onChangeTo={(v) => setFilter("transactionDateTo", v)}
                      />
                    )}
                  </ColumnFilterPopover>
                </div>
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                <div className="flex items-center justify-between gap-1">
                  <span>Moved To</span>
                  <ColumnFilterPopover label="Moved To" active={!!filters.location}>
                    {(close) => (
                      <SelectFilterPanel
                        label="Center"
                        options={centers}
                        value={filters.location ?? ""}
                        onChange={(v) => {
                          setFilter("location", v);
                          close();
                        }}
                      />
                    )}
                  </ColumnFilterPopover>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="px-4 py-2" colSpan={4}>
                    <div className="h-3 w-full max-w-md animate-pulse rounded bg-gray-100" />
                  </td>
                </tr>
              ))
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
                    <EmptyIcon fontSize={28} className="text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No transfers found.</p>
                    <p className="text-xs text-gray-400">
                      {hasActiveFilters ? "Try widening the filters above." : "Transfers made from the Register will show up here."}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b border-gray-100 odd:bg-white even:bg-gray-50/60">
                  <td className="px-4 py-2 font-medium text-ink">{item.farId}</td>
                  <td className="px-4 py-2 text-gray-600">{item.assetDescription}</td>
                  <td className="px-4 py-2 text-gray-600">{formatDate(item.transactionDate)}</td>
                  <td className="px-4 py-2 text-gray-600">{item.location}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {!loading && nextCursor && (
          <div className="flex justify-center py-4">
            <button
              type="button"
              className="rounded-md border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
