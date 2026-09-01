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
import { formatCurrency, formatDateDDMMYYYY } from "../lib/format.js";
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

// Shared by the Depreciation run-rate sparkline (2 points: FY Start -> FYTD, an honest
// straight-line "how far in" indicator, not fabricated intermediate data) and the Net
// Block trend chart (the endpoint's real 6 quarter points, with a native <title> tooltip
// per point). currentColor-based so a wrapping text-* class sets the line/fill color.
function LineChart({
  points,
  height = 60,
  showDots = false
}: {
  points: { label: string; value: number }[];
  height?: number;
  showDots?: boolean;
}) {
  if (points.length < 2) return null;
  const width = 100;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: height - ((p.value - min) / range) * height,
    point: p
  }));
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${height} L 0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <path d={areaPath} fill="currentColor" opacity={0.1} />
      <path d={linePath} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {showDots &&
        coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={2.5} fill="currentColor">
            <title>{`${c.point.label}: ${formatCurrency(c.point.value)}`}</title>
          </circle>
        ))}
    </svg>
  );
}

function DivergingBar({ gains, losses }: { gains: number; losses: number }) {
  // losses is already <= 0 (server sums profit_loss WHERE < 0) — magnitude only, here.
  const max = Math.max(gains, Math.abs(losses), 1);
  return (
    <div className="mt-2 flex h-3 w-full divide-x divide-white overflow-hidden rounded-full bg-gray-100">
      <div className="flex w-1/2 justify-end">
        <div className="h-3 bg-accent" style={{ width: `${(Math.abs(losses) / max) * 100}%` }} />
      </div>
      <div className="flex w-1/2 justify-start">
        <div className="h-3 bg-green-500" style={{ width: `${(gains / max) * 100}%` }} />
      </div>
    </div>
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

            <div className="grid grid-cols-2 gap-4">
              <Card className="p-5">
                <h2 className="text-sm font-semibold text-ink">Depreciation Run-Rate (FYTD)</h2>
                <div className="mt-1 text-2xl font-semibold text-ink">{formatCurrency(summary.depreciationFytd)}</div>
                <div className="mt-2 text-brand-blue">
                  <LineChart
                    points={[
                      { label: "FY Start", value: 0 },
                      { label: "Now", value: summary.depreciationFytd }
                    ]}
                    height={24}
                  />
                </div>
              </Card>

              <Card className="p-5">
                <h2 className="text-sm font-semibold text-ink">Disposal P&L (FYTD)</h2>
                <div className="mt-2 flex justify-between text-xs text-gray-500">
                  <span>Losses {formatCurrency(summary.disposalPL.losses)}</span>
                  <span>Gains {formatCurrency(summary.disposalPL.gains)}</span>
                </div>
                <DivergingBar gains={summary.disposalPL.gains} losses={summary.disposalPL.losses} />
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-xs text-gray-500">{summary.disposalPL.disposalCount} disposals</span>
                  <span className="text-lg font-semibold text-ink">
                    Net {formatCurrency(summary.disposalPL.gains + summary.disposalPL.losses)}
                  </span>
                </div>
              </Card>
            </div>

            <Card className="p-5">
              <h2 className="text-sm font-semibold text-ink">Net Block Trend (6 trailing quarters)</h2>
              <div className="mt-3 text-brand-blue">
                <LineChart
                  points={summary.nbvTrend.map((t) => ({ label: formatDateDDMMYYYY(t.asAt), value: t.nbv }))}
                  height={70}
                  showDots
                />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-gray-400">
                {summary.nbvTrend.map((t) => (
                  <span key={t.asAt}>{formatDateDDMMYYYY(t.asAt)}</span>
                ))}
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
