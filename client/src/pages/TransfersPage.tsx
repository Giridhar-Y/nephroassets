import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchCenters, fetchTransferHistory, type TransferHistoryFilters, type TransferHistoryItem } from "../api/client.js";
import { formatDate } from "../lib/format.js";
import { ColumnFilterPopover, DateRangeFilterPanel, SelectFilterPanel, TextFilterPanel } from "../components/ColumnFilterPopover.js";
import { FarIdAutocomplete } from "../components/FarIdAutocomplete.js";
import { TransferModal } from "../components/TransferModal.js";
import { useAuth } from "../lib/AuthContext.js";
import { useSettings } from "../lib/SettingsContext.js";
import type { AssetListItem } from "../lib/types.js";
import { EmptyIcon, ErrorIcon, HistoryIcon, RetryIcon, TransferIcon, UploadIcon } from "../lib/icons.js";

const PAGE_SIZE = 100;

type Tab = "new" | "log";

function NewTransferTab({ onDone }: { onDone: () => void }) {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? "";
  const [selected, setSelected] = useState<AssetListItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="flex-1 overflow-auto px-6 py-6">
      <div className="max-w-md rounded-xl bg-white p-6 shadow-sm">
        <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">FAR ID</label>
        <div className="mt-1">
          <FarIdAutocomplete asAt={asAt} onSelect={setSelected} />
        </div>

        {selected && (
          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
            <p className="font-medium text-ink">{selected.asset.farId}</p>
            <p className="mt-1 text-gray-600">{selected.asset.assetDescription}</p>
            <p className="mt-1 text-xs text-gray-500">
              Current Location: <span className="font-medium text-gray-700">{selected.result.effectiveLocation}</span>
            </p>
          </div>
        )}

        <button
          type="button"
          className="mt-6 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setModalOpen(true)}
          disabled={!selected}
        >
          <TransferIcon fontSize={15} />
          Transfer This Asset
        </button>
      </div>

      {modalOpen && selected && asAt && (
        <TransferModal
          assets={[selected]}
          defaultDate={asAt}
          excludeLocation={selected.result.effectiveLocation}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
            setSelected(null);
            onDone();
          }}
        />
      )}
    </div>
  );
}

// Transfer Log — the pre-existing read-only history table, filters and pagination
// unchanged, now with a From Location column so a row reads as a full movement.
function TransferLogTab() {
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

  const setFilter = <K extends keyof TransferHistoryFilters>(key: K, value: TransferHistoryFilters[K]) => {
    setFilters((prev) => {
      const next = { ...prev };
      const isEmpty = !value || (Array.isArray(value) && value.length === 0);
      if (!isEmpty) next[key] = value;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="flex min-h-0 flex-1 flex-col">
      {hasActiveFilters && (
        <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-6 py-2">
          <span className="flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
            {Object.keys(filters).length} filter{Object.keys(filters).length === 1 ? "" : "s"} applied
          </span>
          <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setFilters({})}>
            Clear all filters
          </button>
        </div>
      )}

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
                From Location
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                <div className="flex items-center justify-between gap-1">
                  <span>To Location</span>
                  <ColumnFilterPopover label="To Location" active={(filters.location?.length ?? 0) > 0}>
                    {() => (
                      <SelectFilterPanel
                        label="Center"
                        options={centers}
                        value={filters.location ?? []}
                        onChange={(v) => setFilter("location", v)}
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
                  <td className="px-4 py-2" colSpan={5}>
                    <div className="h-3 w-full max-w-md animate-pulse rounded bg-gray-100" />
                  </td>
                </tr>
              ))
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
                    <EmptyIcon fontSize={28} className="text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No transfers found.</p>
                    <p className="text-xs text-gray-400">
                      {hasActiveFilters ? "Try widening the filters above." : "Transfers made from New Transfer or the Register will show up here."}
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
                  <td className="px-4 py-2 text-gray-600">{item.fromLocation}</td>
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

export function TransfersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("new");
  // Bumped every time a transfer is recorded from the New Transfer tab, so the Log tab
  // re-fetches instead of showing a stale list if the user switches over to check.
  const [logRefreshKey, setLogRefreshKey] = useState(0);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
            <HistoryIcon fontSize={20} />
            Transfers
          </h1>
          {user?.role !== "viewer" && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              onClick={() => navigate("/bulk-upload?type=transfers")}
            >
              <UploadIcon fontSize={14} />
              Bulk Transfer
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">Move one asset to a different center, or browse the full history.</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "new" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("new")}
          >
            New Transfer
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "log" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("log")}
          >
            Transfer Log
          </button>
        </div>
      </div>

      {tab === "new" && (
        <NewTransferTab
          onDone={() => {
            setLogRefreshKey((k) => k + 1);
            setTab("log");
          }}
        />
      )}
      {tab === "log" && <TransferLogTab key={logRefreshKey} />}
    </div>
  );
}
