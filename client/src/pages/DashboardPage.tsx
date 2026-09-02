import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  fetchDashboardSummary,
  type DashboardNbvTrendPoint,
  type DashboardStatusCount,
  type DashboardSummary
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { formatCurrency, formatCurrencyCompact, formatDateDDMMYYYY } from "../lib/format.js";
import { ChevronDownIcon, ChevronUpIcon, DashboardIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Card } from "../components/ui/Card.js";
import { StatusBadge } from "../components/ui/Badge.js";
import { EXCEPTION_KEYS, EXCEPTION_LABELS, EXCEPTION_TONES } from "../lib/exceptions.js";

// Every card on this page shares the same hover-lift the exception tiles already had
// (translate up 2px + a slightly deeper shadow) — a small, consistent "alive" touch
// rather than a per-section one-off.
const CARD_HOVER = "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md";

// Cost-side (Gross Block) / depreciation-side (Acc Dep) / net (Net Block, the headline
// figure) / count (Asset Count, not a financial "side" at all) — a tint + border per
// grouping instead of four identical gray tiles, using only tokens already in
// tailwind.config.js's brand palette (brand.rose was defined but unused anywhere else in
// the app; brand.teal/brand.blue are already this page's own chart colors). "net" also
// gets a bigger value and a soft gradient — the one figure a controller scans for first.
const KPI_TONE_CLASSES: Record<"cost" | "depreciation" | "net" | "count", string> = {
  cost: "border-brand-blue/20 bg-brand-blue/5",
  depreciation: "border-brand-rose/30 bg-brand-rose/10",
  net: "border-brand-teal/30 bg-gradient-to-br from-brand-teal/10 via-white to-white",
  count: "border-transparent bg-gray-50"
};

function KpiTile({
  label,
  value,
  fullValue,
  tone = "count",
  size = "normal",
  children
}: {
  label: string;
  /** The displayed headline — compact (formatCurrencyCompact) for a currency figure, so
   *  it always fits a fixed-width card without truncation; a plain short string (e.g.
   *  Asset Count) needs no compacting and can just be the same as fullValue. */
  value: string;
  /** Full-precision text for the `title` attribute (hover/tap) — defaults to `value`
   *  when the two are already the same (a non-currency tile has nothing to compact). */
  fullValue?: string;
  tone?: "cost" | "depreciation" | "net" | "count";
  size?: "normal" | "lg";
  children?: ReactNode;
}) {
  return (
    <Card className={`px-6 py-5 ${KPI_TONE_CLASSES[tone]} ${CARD_HOVER}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div
        className={`mt-1 whitespace-nowrap font-heading font-extrabold text-ink ${size === "lg" ? "text-3xl" : "text-xl"}`}
        title={fullValue ?? value}
      >
        {value}
      </div>
      {children}
    </Card>
  );
}

// Opening Gross Block (fixed FY-Start snapshot) vs Additions FYTD, as a two-segment bar —
// the same "bar with a value/percent" visual language BarPanel already uses elsewhere on
// this page, not a new widget. An inline mini-bar rather than a plain "Opening X +
// Additions Y" text line, per the same "make it a small real interaction, not just more
// static text" brief the Disposal P&L scope toggle below follows.
function OpeningAdditionsBar({ opening, additions }: { opening: number; additions: number }) {
  const total = opening + additions;
  if (total <= 0) return null;
  const openingPct = (opening / total) * 100;
  return (
    <div className="mt-3">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div className="h-2 bg-brand-blue" style={{ width: `${openingPct}%` }} />
        <div className="h-2 bg-brand-teal" style={{ width: `${100 - openingPct}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-2 text-[10px] font-medium text-gray-500">
        <span className="flex items-center gap-1 whitespace-nowrap" title={formatCurrency(opening)}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-blue" />
          Opening {formatCurrencyCompact(opening)}
        </span>
        <span className="flex items-center gap-1 whitespace-nowrap" title={formatCurrency(additions)}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-teal" />+Additions {formatCurrencyCompact(additions)} FYTD
        </span>
      </div>
    </div>
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

type DisposalScope = "fytd" | "allTime";

// A real toggle, not a second static card — FYTD and Since Inception are both legitimate
// scopes (finance needs "what happened this year"; a Register export total reconciles
// against Since Inception instead), so this lets either be the one currently shown
// without needing both spelled out permanently side by side.
function DisposalScopeToggle({ scope, onChange }: { scope: DisposalScope; onChange: (scope: DisposalScope) => void }) {
  return (
    <div className="inline-flex rounded-md border border-gray-200 p-0.5 text-[10px] font-semibold">
      {(["fytd", "allTime"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded px-2 py-0.5 transition-colors ${
            scope === s ? "bg-ink text-white" : "text-gray-500 hover:bg-gray-50"
          }`}
        >
          {s === "fytd" ? "FYTD" : "Since Inception"}
        </button>
      ))}
    </div>
  );
}

// A real "vs last quarter-end" comparison from the trend endpoint's own last two points
// — not a sparkline. A previous attempt reused LineChart here, but LineChart's zero-based
// y-axis (appropriate for the Depreciation Run-Rate sparkline, which really does start at
// 0) crushes a tightly-clustered, all-large NBV series into an invisible sliver hugging
// the chart's top edge: real data, unreadable render. A plain delta is legible at a
// glance and doesn't need a second y-axis convention just for this one series.
function NetBlockDelta({ trend }: { trend: DashboardNbvTrendPoint[] }) {
  if (trend.length < 2) return null;
  const prev = trend[trend.length - 2]!;
  const last = trend[trend.length - 1]!;
  if (prev.nbv === 0) return null; // no meaningful % change to express from a zero base
  const deltaPct = ((last.nbv - prev.nbv) / Math.abs(prev.nbv)) * 100;
  const isUp = deltaPct >= 0;
  return (
    <div className={`mt-2 flex items-center gap-1 text-xs font-semibold ${isUp ? "text-green-600" : "text-accent"}`}>
      {isUp ? <ChevronUpIcon fontSize={14} /> : <ChevronDownIcon fontSize={14} />}
      <span className="tabular-nums">
        {isUp ? "+" : ""}
        {deltaPct.toFixed(1)}%
      </span>
      <span className="font-normal text-gray-400">vs last quarter-end</span>
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

// Tinted background at each severity's own tone (reusing Badge's TONE_CLASSES color
// values, not a small badge chip sitting on a white card) — the count is the dominant
// visual element, colored and large, the label a smaller line underneath.
const EXCEPTION_TILE_TONE_CLASSES: Record<"danger" | "warning" | "info" | "neutral", { bg: string; text: string }> = {
  danger: { bg: "bg-accent-light", text: "text-accent-hover" },
  warning: { bg: "bg-amber-100", text: "text-amber-800" },
  info: { bg: "bg-brand-blue/15", text: "text-brand-deepBlue" },
  neutral: { bg: "bg-gray-100", text: "text-gray-700" }
};

export function DashboardPage() {
  const { settings } = useSettings();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disposalScope, setDisposalScope] = useState<DisposalScope>("fytd");
  // Entrance fade/slide-in, once — a plain two-state CSS transition (no keyframes, no
  // animation library) rather than a per-tile stagger, restrained on purpose: this is a
  // screen finance scans for numbers, not a marketing page.
  const [mounted, setMounted] = useState(false);

  const settingsKey = fySettingsKey(settings);

  // Fixed "whole register as of today" view — no Center/Sub Classification pickers.
  // Backend filter support (dashboardSummaryQuerySchema/DashboardFilters) stays in place
  // for Register's own use; this page simply never exercises it.
  const load = useCallback(() => {
    if (!settings) return;
    setLoading(true);
    setError(null);
    fetchDashboardSummary(settings.asAt)
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the dashboard."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.asAt, settingsKey]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!summary || mounted) return;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [summary, mounted]);

  const disposalPL = summary ? (disposalScope === "fytd" ? summary.disposalPL : summary.disposalPL.allTime) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader icon={DashboardIcon} title="Finance FAR Dashboard" subtitle="A single-screen overview of the Fixed Asset Register." />

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
        ) : summary && disposalPL ? (
          <div
            className={`space-y-6 transition-all duration-500 ease-out ${
              mounted ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
            }`}
          >
            <div className="grid grid-cols-4 gap-5">
              <KpiTile
                label="Gross Block"
                value={formatCurrencyCompact(summary.totals.grossBlock)}
                fullValue={formatCurrency(summary.totals.grossBlock)}
                tone="cost"
              >
                <OpeningAdditionsBar opening={summary.totals.openingGrossBlock} additions={summary.totals.additionsFytd} />
              </KpiTile>
              <KpiTile
                label="Accumulated Depreciation"
                value={formatCurrencyCompact(summary.totals.closingAccDep)}
                fullValue={formatCurrency(summary.totals.closingAccDep)}
                tone="depreciation"
              />
              <KpiTile
                label="Net Block"
                value={formatCurrencyCompact(summary.totals.nbv)}
                fullValue={formatCurrency(summary.totals.nbv)}
                tone="net"
                size="lg"
              >
                <NetBlockDelta trend={summary.nbvTrend} />
              </KpiTile>
              <KpiTile label="Asset Count" value={String(summary.totals.assetCount)} tone="count">
                <div className="mt-1 text-xs text-gray-500">Σ Qty: {summary.totals.qtyTotal.toLocaleString("en-IN")}</div>
                <StatusMix statusCounts={summary.statusCounts} />
              </KpiTile>
            </div>

            <div className="grid grid-cols-3 gap-5">
              <Card className={`p-6 ${CARD_HOVER}`}>
                <h2 className="font-heading text-sm font-bold text-ink">Depreciation Run-Rate (FYTD)</h2>
                <div
                  className="mt-1 whitespace-nowrap text-2xl font-semibold text-ink"
                  title={formatCurrency(summary.depreciationFytd)}
                >
                  {formatCurrencyCompact(summary.depreciationFytd)}
                </div>
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

              <Card className={`p-6 ${CARD_HOVER}`}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-heading text-sm font-bold text-ink">Disposal P&L</h2>
                  <DisposalScopeToggle scope={disposalScope} onChange={setDisposalScope} />
                </div>
                <div className="mt-3 flex justify-between text-xs text-gray-500">
                  <span>Losses {formatCurrency(disposalPL.losses)}</span>
                  <span>Gains {formatCurrency(disposalPL.gains)}</span>
                </div>
                <DivergingBar gains={disposalPL.gains} losses={disposalPL.losses} />
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-xs text-gray-500">
                    {disposalPL.disposalCount} disposal{disposalPL.disposalCount === 1 ? "" : "s"}
                  </span>
                  <span className="text-base font-semibold text-ink">Net {formatCurrency(disposalPL.gains + disposalPL.losses)}</span>
                </div>
                {/* Deletions/Sale Proceeds are only tracked FYTD (the export's own Disposal
                    Inputs group has no all-time total either) — shown fixed regardless of
                    the gains/losses toggle above, labelled so that's unambiguous. */}
                <div className="mt-3 flex justify-between border-t border-gray-100 pt-3 text-[11px] text-gray-500">
                  <span>Deletions (Cost, FYTD) {formatCurrency(summary.disposalPL.totalDeletions)}</span>
                  <span>Sale Proceeds (FYTD) {formatCurrency(summary.disposalPL.saleProceeds)}</span>
                </div>
              </Card>

              <Card className={`p-6 ${CARD_HOVER}`}>
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
                // A plain native anchor — deliberately NOT react-router's <Link>. Link's
                // own click handler bails out and lets the browser handle target="_blank"
                // natively (confirmed against the installed react-router-dom source), but
                // a real click still navigated the CURRENT tab instead of opening a new
                // one. Using a bare <a> removes React/router entirely from the click path,
                // leaving pure native browser semantics — right-click/middle-click/
                // Ctrl+click all need to work, and a plain click must leave Dashboard
                // exactly where it was. Register's own GET /api/assets?exception=<key>
                // re-derives the exact row set from the same shared predicate this tile's
                // count came from — see exceptionPredicates.ts — so the two can never
                // silently disagree.
                return category.count > 0 ? (
                  <a
                    key={key}
                    href={`#/register?exception=${key}&asAt=${summary.asAt}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${EXCEPTION_LABELS[key]}: ${category.count} — opens Register in a new tab`}
                    title="Open in Register (new tab)"
                    className={`rounded-xl p-5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${toneClasses.bg}`}
                  >
                    {tileContent}
                  </a>
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
