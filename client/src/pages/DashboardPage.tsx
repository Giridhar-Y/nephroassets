import { useCallback, useEffect, useState } from "react";
import { fetchCenters, fetchDashboardSummary, fetchSubClassifications, type DashboardSummary } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { DashboardIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";

export function DashboardPage() {
  const { settings } = useSettings();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local, unpersisted filters — deliberately not FiltersContext (that's Register's own
  // persisted filter state; this page's filters are its own, simpler, transient picks).
  const [center, setCenter] = useState("");
  const [subClassification, setSubClassification] = useState("");
  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<string[]>([]);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    fetchSubClassifications().then((rows) => setSubClassifications(rows.map((r) => r.name))).catch(() => {});
  }, []);

  const settingsKey = fySettingsKey(settings);

  const load = useCallback(() => {
    if (!settings) return;
    setLoading(true);
    setError(null);
    fetchDashboardSummary(settings.asAt, {
      center: center || undefined,
      subClassification: subClassification || undefined
    })
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the dashboard."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.asAt, settingsKey, center, subClassification]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader icon={DashboardIcon} title="Finance FAR Dashboard" subtitle="A single-screen overview of the Fixed Asset Register.">
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="dash-center" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Center
            </label>
            <select
              id="dash-center"
              className="w-48 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={center}
              onChange={(e) => setCenter(e.target.value)}
            >
              <option value="">All Centers</option>
              {centers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="dash-subclass" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Sub Classification
            </label>
            <select
              id="dash-subclass"
              className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={subClassification}
              onChange={(e) => setSubClassification(e.target.value)}
            >
              <option value="">All Sub Classifications</option>
              {subClassifications.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {error && (
          <p className="mb-4 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}{" "}
            <button className="flex items-center gap-1 font-semibold underline" onClick={load}>
              <RetryIcon fontSize={13} />
              Retry
            </button>
          </p>
        )}

        {loading && !summary ? (
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : summary ? (
          <p className="text-sm text-gray-500">
            {summary.totals.assetCount} assets in scope as of {summary.asAt}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
