import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  fetchCenters,
  fetchDashboardSummary,
  fetchSubClassifications,
  type DashboardStatusCount,
  type DashboardSummary
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { formatCurrency } from "../lib/format.js";
import { DashboardIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Card } from "../components/ui/Card.js";
import { StatusBadge } from "../components/ui/Badge.js";

// Top 5 by value + one "Other" row summing the rest — the server returns every row (it
// doesn't know how many the client wants to show), this is purely a display fold.
function foldTop5(rows: { label: string; value: number }[]): { label: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  return rest.length > 0 ? [...top, { label: "Other", value: rest.reduce((sum, r) => sum + r.value, 0) }] : top;
}

function BarPanel({ title, rows }: { title: string; rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">Nothing in scope.</p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-gray-600">{row.label}</span>
                <span className="shrink-0 font-medium tabular-nums text-ink">{formatCurrency(row.value)}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-gray-100">
                <div
                  className="h-2 rounded-full bg-brand-blue"
                  style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function KpiTile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {children}
    </Card>
  );
}

function StatusMix({ statusCounts }: { statusCounts: DashboardStatusCount[] }) {
  if (statusCounts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {statusCounts.map((s) => (
        <span key={s.status} className="inline-flex items-center gap-1">
          <StatusBadge status={s.status} />
          <span className="text-xs font-medium text-gray-500">{s.count}</span>
        </span>
      ))}
    </div>
  );
}

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
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-4">
              <KpiTile label="Gross Block" value={formatCurrency(summary.totals.grossBlock)} />
              <KpiTile label="Accumulated Depreciation" value={formatCurrency(summary.totals.closingAccDep)} />
              <KpiTile label="Net Block" value={formatCurrency(summary.totals.nbv)} />
              <KpiTile label="Asset Count" value={String(summary.totals.assetCount)}>
                <StatusMix statusCounts={summary.statusCounts} />
              </KpiTile>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <BarPanel
                title="By Sub Classification (Gross Block)"
                rows={foldTop5(
                  summary.subClassificationBreakdown.map((r) => ({ label: r.subClassification, value: r.grossBlock }))
                )}
              />
              <BarPanel
                title="By Location (Net Block)"
                rows={foldTop5(summary.locationBreakdown.map((r) => ({ label: r.location, value: r.nbv })))}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
