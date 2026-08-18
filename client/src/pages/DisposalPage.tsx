import { useEffect, useState } from "react";
import { disposeAsset, fetchAssets } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { DeleteIcon, ErrorIcon, PassIcon, SearchIcon } from "../lib/icons.js";

const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export function DisposalPage() {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? "";

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<AssetListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AssetListItem | null>(null);

  const [dateOfDisposal, setDateOfDisposal] = useState(asAt);
  const [saleValue, setSaleValue] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!asAt || query.trim().length === 0 || selected) {
      setMatches([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      fetchAssets({ asAt, search: query.trim(), limit: 10 })
        .then((res) => setMatches(res.items.filter((i) => !i.asset.dateOfDisposal)))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, asAt, selected]);

  function selectAsset(item: AssetListItem) {
    setSelected(item);
    setQuery(item.asset.farId);
    setMatches([]);
    setDateOfDisposal(asAt);
    setSaleValue(0);
    setSuccess(null);
    setError(null);
  }

  function clearSelection() {
    setSelected(null);
    setQuery("");
    setSuccess(null);
    setError(null);
  }

  async function handleSubmit() {
    if (!selected) return;
    if (!dateOfDisposal) {
      setError("Disposal date is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await disposeAsset(selected.asset.farId, { dateOfDisposal, saleValue });
      setSuccess(`Asset "${selected.asset.farId}" has been disposed.`);
      setSelected(null);
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dispose of the asset.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <DeleteIcon fontSize={20} />
        Disposals
      </h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">
        Retire an asset from the register. Disposals are full only — the entire capitalized cost is written off.
      </p>

      <div className="mt-6 max-w-lg rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="disposal-search" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Find Asset
          </label>
          <div className="relative">
            <SearchIcon fontSize={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              id="disposal-search"
              type="text"
              placeholder="Search by FAR ID…"
              className={`${INPUT_CLASS} pl-8`}
              value={query}
              disabled={!!selected}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {searching && <p className="text-xs text-gray-400">Searching…</p>}
          {matches.length > 0 && (
            <ul className="mt-1 max-h-48 overflow-auto rounded-md border border-gray-200">
              {matches.map((item) => (
                <li key={item.asset.farId}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-gray-50"
                    onClick={() => selectAsset(item)}
                  >
                    <span className="font-medium text-ink">{item.asset.farId}</span>
                    <span className="text-xs text-gray-500">{item.asset.assetDescription}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <>
            <div className="mt-4 rounded-md bg-gray-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{selected.asset.farId}</span>
                <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={clearSelection}>
                  Change
                </button>
              </div>
              <p className="mt-1 text-gray-600">{selected.asset.assetDescription}</p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>Location: {selected.result.effectiveLocation}</span>
                <span>Acquired: {formatDate(selected.asset.dateAcquired)}</span>
                <span>C1 Gross Block: {formatCurrency(selected.result.c1.grossBlock)}</span>
                <span>C1 NBV: {formatCurrency(selected.result.c1.nbv)}</span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="disposal-date" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Disposal Date
                </label>
                <input
                  id="disposal-date"
                  type="date"
                  className={INPUT_CLASS}
                  value={dateOfDisposal}
                  onChange={(e) => setDateOfDisposal(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="disposal-sale-value" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Sale Value
                </label>
                <input
                  id="disposal-sale-value"
                  type="number"
                  min={0}
                  className={INPUT_CLASS}
                  value={saleValue}
                  onChange={(e) => setSaleValue(Number(e.target.value))}
                />
              </div>
            </div>
          </>
        )}

        {error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}
        {success && !error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-green-700">
            <PassIcon fontSize={15} />
            {success}
          </p>
        )}

        <button
          type="button"
          className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleSubmit}
          disabled={!selected || submitting}
        >
          {submitting ? "Disposing…" : "Dispose Asset"}
        </button>
      </div>
    </div>
  );
}
