import { useEffect, useState } from "react";
import { fetchAssets } from "../api/client.js";
import type { AssetListItem } from "../lib/types.js";
import { SearchIcon } from "../lib/icons.js";

// Same debounced-search-by-FAR-ID pattern as AssetSearchPage's typeahead, packaged for
// reuse wherever a form needs to pick one existing asset (New Transfer, New Disposal) —
// the dropdown here floats over the page instead of pushing content down, since those
// forms have more below it than AssetSearchPage's standalone search screen does.
export function FarIdAutocomplete({
  asAt,
  placeholder = "e.g. FAR-000123",
  onSelect
}: {
  asAt: string;
  placeholder?: string;
  onSelect: (item: AssetListItem) => void;
}) {
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

  function select(item: AssetListItem) {
    setQuery("");
    setMatches([]);
    onSelect(item);
  }

  return (
    <div className="relative">
      <SearchIcon fontSize={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 py-2 pl-8 pr-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching && <p className="mt-1 text-xs text-gray-400">Searching…</p>}
      {matches.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
          {matches.map((item) => (
            <li key={item.asset.farId} className="border-b border-gray-100 last:border-b-0">
              <button
                type="button"
                className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-gray-50"
                onClick={() => select(item)}
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
  );
}
