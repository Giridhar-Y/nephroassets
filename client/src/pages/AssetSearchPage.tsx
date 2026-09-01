import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAssets } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import type { AssetListItem } from "../lib/types.js";
import { LifecycleIcon, SearchIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";

export function AssetSearchPage() {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const asAt = settings?.asAt ?? "";

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<AssetListItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!asAt || query.trim().length === 0) {
      setMatches([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      fetchAssets({ asAt, search: query.trim(), limit: 10 })
        .then((res) => setMatches(res.items))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, asAt]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <PageHeader
        icon={LifecycleIcon}
        title="Asset History"
        bordered={false}
        subtitle="Search for a FAR ID to see that asset's complete lifecycle — capitalization, transfers, and disposal — in
        one screen."
      />

      <div className="mt-6 max-w-md">
        <div className="relative">
          <SearchIcon fontSize={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            autoFocus
            placeholder="e.g. FAR-000123"
            className="w-full rounded-md border border-gray-300 py-2 pl-8 pr-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                navigate(`/assets/${encodeURIComponent(matches[0]!.asset.farId)}`);
              }
            }}
          />
        </div>
        {searching && <p className="mt-1 text-xs text-gray-400">Searching…</p>}
        {matches.length > 0 && (
          <ul className="mt-2 overflow-hidden rounded-md border border-gray-200">
            {matches.map((item) => (
              <li key={item.asset.farId} className="border-b border-gray-100 last:border-b-0">
                <button
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-gray-50"
                  onClick={() => navigate(`/assets/${encodeURIComponent(item.asset.farId)}`)}
                >
                  <span className="font-medium text-ink">{item.asset.farId}</span>
                  <span className="text-xs text-gray-500">{item.asset.assetDescription}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!searching && query.trim().length > 0 && matches.length === 0 && (
          <p className="mt-2 text-xs text-gray-400">No FAR ID starts with "{query.trim()}".</p>
        )}
      </div>
    </div>
  );
}
