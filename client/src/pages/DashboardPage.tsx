import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
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
import { EXCEPTION_KEYS, EXCEPTION_LABELS, EXCEPTION_TONES } from "../lib/exceptions.js";

// Top 5 by value + one "Other" row summing the rest — the server returns every row (it
// doesn't know how many the client wants to show), this is purely a display fold.
function foldTop5(rows: { label: string; value: number }[]): { label: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  return rest.length > 0 ? [...top, { label: "Other", value: rest.reduce((sum, r) => sum + r.value, 0) }] : top;
}

// `total` is the whole-scope figure this breakdown's values are a share of (e.g. overall
// Gross Block for the Sub Classification panel) — used only for the "(N%)" next to each
// value; omit it and the percentage is simply not shown, rather than dividing by a wrong
// stand-in total.
function BarPanel({ title, rows, total }: { title: string; rows: { label: string; value: number }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="p-6">
      <h2 className="font-heading text-sm font-bold text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">Nothing in scope.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-gray-600">{row.label}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-semibold text-ink">{formatCurrency(row.value)}</span>
                  {!!total && (
                    <span className="ml-1.5 text-gray-400">({Math.round((row.value / total) * 100)}%)</span>
                  )}
                </span>
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
    <Card className="border-transparent bg-gray-50 px-6 py-5">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 truncate font-heading text-xl font-extrabold text-ink" title={value}>
        {value}
      </div>
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

// Tinted background at each severity's own tone (reusing Badge's TONE_CLASSES color
// values, not a small badge chip sitting on a white card) — the count is the dominant
// visual element, colored and large, the label a smaller line underneath.
const EXCEPTION_TILE_TONE_CLASSES: Record<"danger" | "warning" | "info" | "neutral", { bg: string; text: string }> = {
  danger: { bg: "bg-accent-light", text: "text-accent-hover" },
  warning: { bg: "bg-amber-100", text: "text-amber-800" },
  info: { bg: "bg-brand-blue/15", text: "text-brand-deepBlue" },
  neutral: { bg: "bg-gray-100", text: "text-gray-700" }
};

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

      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
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
          <div className="grid grid-cols-4 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : summary ? (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-5">
              <KpiTile label="Gross Block" value={formatCurrency(summary.totals.grossBlock)} />
              <KpiTile label="Accumulated Depreciation" value={formatCurrency(summary.totals.closingAccDep)} />
              <KpiTile label="Net Block" value={formatCurrency(summary.totals.nbv)}>
                {/* A real trend, not a fabricated delta — the same 6-quarter series the
                    Net Block Trend card below charts in full, reused here as a compact
                    "which way is this moving" cue right under the headline figure. */}
                <div className="mt-2 h-6 text-brand-blue">
                  <LineChart points={summary.nbvTrend.map((t) => ({ label: formatDateDDMMYYYY(t.asAt), value: t.nbv }))} height={24} />
                </div>
              </KpiTile>
              <KpiTile label="Asset Count" value={String(summary.totals.assetCount)}>
                <StatusMix statusCounts={summary.statusCounts} />
              </KpiTile>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <BarPanel
                title="By Sub Classification (Gross Block)"
                total={summary.totals.grossBlock}
                rows={foldTop5(
                  summary.subClassificationBreakdown.map((r) => ({ label: r.subClassification, value: r.grossBlock }))
                )}
              />
              <BarPanel
                title="By Location (Net Block)"
                total={summary.totals.nbv}
                rows={foldTop5(summary.locationBreakdown.map((r) => ({ label: r.location, value: r.nbv })))}
              />
            </div>

            <div className="grid grid-cols-3 gap-5">
              <Card className="p-6">
                <h2 className="font-heading text-sm font-bold text-ink">Depreciation Run-Rate (FYTD)</h2>
                <div className="mt-1 text-2xl font-semibold text-ink">{formatCurrency(summary.depreciationFytd)}</div>
                <div className="mt-3 text-brand-blue">
                  <LineChart
                    points={[
                      { label: "FY Start", value: 0 },
                      { label: "Now", value: summary.depreciationFytd }
                    ]}
                    height={24}
                  />
                </div>
              </Card>

              <Card className="p-6">
                <h2 className="font-heading text-sm font-bold text-ink">Disposal P&L (FYTD)</h2>
                <div className="mt-3 flex justify-between text-xs text-gray-500">
                  <span>Losses {formatCurrency(summary.disposalPL.losses)}</span>
                  <span>Gains {formatCurrency(summary.disposalPL.gains)}</span>
                </div>
                <DivergingBar gains={summary.disposalPL.gains} losses={summary.disposalPL.losses} />
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-xs text-gray-500">{summary.disposalPL.disposalCount} disposals</span>
                  <span className="text-base font-semibold text-ink">
                    Net {formatCurrency(summary.disposalPL.gains + summary.disposalPL.losses)}
                  </span>
                </div>
              </Card>

              <Card className="p-6">
                <h2 className="font-heading text-sm font-bold text-ink">Net Block Trend</h2>
                <div className="mt-3 text-brand-blue">
                  <LineChart
                    points={summary.nbvTrend.map((t) => ({ label: formatDateDDMMYYYY(t.asAt), value: t.nbv }))}
                    height={44}
                    showDots
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[10px] text-gray-400">
                  {summary.nbvTrend.map((t) => (
                    <span key={t.asAt}>{t.asAt.slice(5, 7)}/{t.asAt.slice(2, 4)}</span>
                  ))}
                </div>
              </Card>
            </div>

            <div className="grid grid-cols-5 gap-5">
              {EXCEPTION_KEYS.map((key) => {
                const category = summary.exceptions[key];
                const toneClasses = EXCEPTION_TILE_TONE_CLASSES[EXCEPTION_TONES[key]];
                const tileContent = (
                  <>
                    <div className={`font-heading text-3xl font-extrabold ${category.count > 0 ? toneClasses.text : "text-gray-400"}`}>
                      {category.count}
                    </div>
                    <div className="mt-1 text-xs font-medium text-gray-600">{EXCEPTION_LABELS[key]}</div>
                  </>
                );
                // A real anchor (not a programmatic navigation) opened in a new tab —
                // same reasoning as AssetGrid's own "View Lifecycle" link: right-click/
                // middle-click/Ctrl+click all need to work, and it needs to survive
                // outside React Router's own client-side history. Register's own
                // GET /api/assets?exception=<key> re-derives the exact row set from the
                // same shared predicate this tile's count came from — see
                // exceptionPredicates.ts — so the two can never silently disagree.
                return category.count > 0 ? (
                  <Link
                    key={key}
                    to={`/register?exception=${key}&asAt=${summary.asAt}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${EXCEPTION_LABELS[key]}: ${category.count} — opens Register in a new tab`}
                    title="Open in Register (new tab)"
                    className={`rounded-xl p-5 text-left shadow-sm transition-transform hover:-translate-y-0.5 ${toneClasses.bg}`}
                  >
                    {tileContent}
                  </Link>
                ) : (
                  <div key={key} className="rounded-xl bg-gray-50 p-5 text-left">
                    {tileContent}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
