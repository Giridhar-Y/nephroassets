import { useEffect, useState } from "react";
import { fetchCenters, fetchStatuses, fetchSubClassifications } from "../api/client.js";
import { useFilters } from "../lib/FiltersContext.js";
import { formatDate } from "../lib/format.js";
import { CalendarIcon, DismissIcon, SearchIcon } from "../lib/icons.js";

const FILTER_LABELS: Record<string, string> = {
  center: "Center",
  subClassification: "Sub Classification",
  status: "Status",
  dateAcquiredFrom: "Acquired From",
  dateAcquiredTo: "Acquired To",
  search: "Search"
};

export function FilterBar({ asAt }: { asAt: string | null }) {
  const { filters, setFilter, clearFilter, clearAll } = useFilters();
  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
    fetchStatuses().then(setStatuses).catch(() => {});
  }, []);

  const activeChips = Object.entries(filters).filter(([, v]) => v);

  return (
    <div className="space-y-3 border-b border-gray-200 bg-white px-6 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-center" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Center
          </label>
          <select
            id="filter-center"
            className="w-44 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.center ?? ""}
            onChange={(e) => (e.target.value ? setFilter("center", e.target.value) : clearFilter("center"))}
          >
            <option value="">All centers</option>
            {centers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="filter-sub-classification"
            className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
          >
            Sub Classification
          </label>
          <select
            id="filter-sub-classification"
            className="w-48 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.subClassification ?? ""}
            onChange={(e) =>
              e.target.value ? setFilter("subClassification", e.target.value) : clearFilter("subClassification")
            }
          >
            <option value="">All</option>
            {subClassifications.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Status
          </label>
          <select
            id="filter-status"
            className="w-36 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.status ?? ""}
            onChange={(e) => (e.target.value ? setFilter("status", e.target.value) : clearFilter("status"))}
          >
            <option value="">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="filter-date-from"
            className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
          >
            Date Acquired From
          </label>
          <input
            id="filter-date-from"
            type="date"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.dateAcquiredFrom ?? ""}
            onChange={(e) =>
              e.target.value ? setFilter("dateAcquiredFrom", e.target.value) : clearFilter("dateAcquiredFrom")
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-date-to" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Date Acquired To
          </label>
          <input
            id="filter-date-to"
            type="date"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.dateAcquiredTo ?? ""}
            onChange={(e) =>
              e.target.value ? setFilter("dateAcquiredTo", e.target.value) : clearFilter("dateAcquiredTo")
            }
          />
        </div>

        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="filter-search" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Search FAR ID
          </label>
          <div className="relative min-w-[180px]">
            <SearchIcon fontSize={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              id="filter-search"
              type="text"
              placeholder="e.g. FAR-000123"
              className="w-full rounded-md border border-gray-300 py-1.5 pl-8 pr-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={filters.search ?? ""}
              onChange={(e) => (e.target.value ? setFilter("search", e.target.value) : clearFilter("search"))}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full bg-accent-light px-3 py-1 text-xs font-semibold text-accent-hover">
          <CalendarIcon fontSize={13} />
          Figures as of: {asAt ? formatDate(asAt) : "…"}
        </span>
        {activeChips.map(([key, value]) => (
          <span
            key={key}
            className="flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700"
          >
            {FILTER_LABELS[key] ?? key}: {value}
            <button
              type="button"
              className="text-gray-400 hover:text-gray-700"
              onClick={() => clearFilter(key as keyof typeof filters)}
              aria-label={`Remove ${FILTER_LABELS[key] ?? key} filter`}
            >
              <DismissIcon fontSize={12} />
            </button>
          </span>
        ))}
        {activeChips.length > 0 && (
          <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={clearAll}>
            Clear all filters
          </button>
        )}
      </div>
    </div>
  );
}
