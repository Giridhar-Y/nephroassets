import { Fragment, useCallback, useEffect, useState } from "react";
import {
  fetchAuditReconciliation,
  getAuditReconciliationExportUrl,
  type ReconciliationComponentFigures,
  type ReconciliationItem,
  type ReconciliationPeriod
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency } from "../lib/format.js";
import { Tooltip } from "../components/Tooltip.js";
import { CustomPeriodBadge, DATE_INPUT_CLASS } from "../components/CustomPeriodBadge.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { EmptyIcon, ErrorIcon, FailIcon, InfoIcon, PassIcon, RetryIcon, ReconciliationIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { ExportButton } from "../components/ui/ExportButton.js";

// Deliberately its own green/red, not the (now black/charcoal) brand accent — pass/fail
// must stay visually distinct from ordinary UI chrome at a glance.
function CheckBadge({ pass, message, note }: { pass: boolean; message: string; note?: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
          pass ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}
      >
        {pass ? <PassIcon fontSize={13} /> : <FailIcon fontSize={13} />}
        {pass ? "Pass" : "Fail"}
      </span>
      {!pass && <span className="max-w-xs text-xs text-red-600">{message}</span>}
      {/* Informational, not a failure — the locked calc engine's Closing Acc Dep clamp
          (cap at Gross Block / floor at 0) already gets accounted for in the pass/fail
          above; this just tells a reviewer why the row doesn't match the naive formula
          instead of leaving it unexplained. */}
      {note && <span className="max-w-xs text-xs text-amber-700">{note}</span>}
    </div>
  );
}

// 2026-09-03: Accumulated Depreciation / NBV can only be correctly computed for the FY
// currently configured in Settings — accDepC1/C2Opening is a single, user-entered
// snapshot with no per-FY history (see server/src/routes/reports.ts's
// requireFySettings for the full mechanism). Shown instead of a misleading Pass/Fail —
// the underlying check can never catch this on its own (it verifies the engine's own
// arithmetic against itself, not an external truth).
function NotApplicableBadge() {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold italic text-amber-700">
      N/A
    </span>
  );
}

// One column group per component, rendered identically 3 times across a row — C1/C2/
// Combined column groups on the same <tr>, not stacked rows. Tinted to match the
// Excel export's own C1=blue/C2=green/Combined=purple color coding (buildReconciliationWorkbook
// in reports.ts), so the same grouping reads the same way on both surfaces.
const GROUPS = [
  { key: "c1" as const, label: "C1", get: (item: ReconciliationItem) => item.c1, tint: "bg-blue-50 text-blue-700" },
  { key: "c2" as const, label: "C2", get: (item: ReconciliationItem) => item.c2, tint: "bg-green-50 text-green-700" },
  {
    key: "combined" as const,
    label: "Combined",
    get: (item: ReconciliationItem) => item.combined,
    tint: "bg-purple-50 text-purple-700"
  }
];

// A component group's 9 cells for one row — blank (not zero-filled) when `figures` is
// null, the C1-only case (see reports.ts's computeReconciliationItems). `isCurrentFy`
// false blanks Closing Acc Dep/NBV Closing the same way (genuinely empty, not a dimmed
// number — see 2026-09-03's revision: a screenshot or a copy-paste loses a dimmed font,
// so blank is the only signal actually safe for a reconciliation report) and swaps their
// Check badges for NotApplicableBadge; Cost Check/Gross Block are unaffected.
function GroupCells({ figures, isCurrentFy }: { figures: ReconciliationComponentFigures | null; isCurrentFy: boolean }) {
  if (!figures) {
    return (
      <>
        {Array.from({ length: 9 }).map((_, i) => (
          <td key={i} className="border-b border-gray-100 py-2 pr-3 text-gray-300">
            —
          </td>
        ))}
      </>
    );
  }
  return (
    <>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">{formatCurrency(figures.openingSum)}</td>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">{formatCurrency(figures.additionsSum)}</td>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">{formatCurrency(figures.deletionsSum)}</td>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
        {formatCurrency(figures.closingGrossBlockSum)}
      </td>
      <td className="border-b border-gray-100 py-2 pr-3">
        <CheckBadge pass={figures.costCheckPass} message={figures.costCheckMessage} />
      </td>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
        {isCurrentFy ? formatCurrency(figures.closingAccDepSum) : <span className="text-gray-300">—</span>}
      </td>
      <td className="border-b border-gray-100 py-2 pr-3">
        {isCurrentFy ? (
          <CheckBadge pass={figures.depCheckPass} message={figures.depCheckMessage} note={figures.capAdjustmentMessage} />
        ) : (
          <NotApplicableBadge />
        )}
      </td>
      <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
        {isCurrentFy ? formatCurrency(figures.nbvClosingSum) : <span className="text-gray-300">—</span>}
      </td>
      <td className="border-b border-gray-100 py-2 pr-3">
        {isCurrentFy ? <CheckBadge pass={figures.nbvCheckPass} message={figures.nbvCheckMessage} /> : <NotApplicableBadge />}
      </td>
    </>
  );
}

export function AuditReconciliationPage() {
  const { settings } = useSettings();
  const [items, setItems] = useState<ReconciliationItem[] | null>(null);
  // Whether the currently-loaded `items` were computed for the FY actually configured
  // in Settings, not some other fyStart/fyEnd the period selector below asked for — see
  // GroupCells/NotApplicableBadge for what this gates.
  const [isCurrentFy, setIsCurrentFy] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Independent of the app-wide "Figures as of" setting — seeded from it once, on
  // first load, but from then on only this page's own period selector drives what gets
  // reconciled, so switching FY here doesn't touch Settings and vice versa.
  const [period, setPeriod] = useState<ReconciliationPeriod | null>(null);
  useEffect(() => {
    if (settings && !period) {
      setPeriod({ asAt: settings.asAt, fyStart: settings.fyStart, fyEnd: settings.fyEnd });
    }
  }, [settings, period]);

  const isCustomPeriod = !!(settings && period && (period.fyStart !== settings.fyStart || period.fyEnd !== settings.fyEnd));

  const load = useCallback(() => {
    if (!period) return;
    setLoading(true);
    setError(null);
    fetchAuditReconciliation(period)
      .then((res) => {
        setItems(res.items);
        setIsCurrentFy(res.isCurrentFy);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the reconciliation."))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader
        icon={ReconciliationIcon}
        title="Audit Reconciliation"
        subtitle="For every sub classification and cost component (C1, C2, and Combined), this checks that the numbers roll
          forward correctly: Opening + Additions − Deletions should equal Closing cost, Opening Depreciation + This
          Period's Depreciation − Depreciation Removed should equal Closing Depreciation, and Closing Gross Block −
          Closing Depreciation should equal Closing NBV."
        actions={<ExportButton url={period ? getAuditReconciliationExportUrl(period) : undefined} />}
      >
        {period && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="recon-fy-start" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                FY Start
              </label>
              <input
                id="recon-fy-start"
                type="date"
                className={DATE_INPUT_CLASS}
                value={period.fyStart}
                max={period.fyEnd}
                onChange={(e) => setPeriod({ ...period, fyStart: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="recon-fy-end" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                FY End
              </label>
              <input
                id="recon-fy-end"
                type="date"
                className={DATE_INPUT_CLASS}
                value={period.fyEnd}
                min={period.fyStart}
                onChange={(e) => setPeriod({ ...period, fyEnd: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="recon-as-at" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                As At
              </label>
              <input
                id="recon-as-at"
                type="date"
                className={DATE_INPUT_CLASS}
                value={period.asAt}
                min={period.fyStart}
                max={period.fyEnd}
                onChange={(e) => setPeriod({ ...period, asAt: e.target.value })}
              />
            </div>
            {isCustomPeriod && settings && (
              <CustomPeriodBadge
                label="Custom period"
                resetLabel="Reset to current FY"
                onReset={() => setPeriod({ asAt: settings.asAt, fyStart: settings.fyStart, fyEnd: settings.fyEnd })}
              />
            )}
          </div>
        )}
      </PageHeader>

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

      {!loading && !error && !isCurrentFy && items && items.length > 0 && (
        <div className="flex items-start gap-1.5 border-b border-amber-100 bg-amber-50 px-6 py-2 text-sm text-amber-800">
          <InfoIcon fontSize={15} className="mt-0.5 shrink-0" />
          <span>
            FY Start/End above isn&apos;t the current financial year in Settings — Accumulated Depreciation and NBV figures
            are blank below (Check columns marked <strong>N/A</strong>) because they can&apos;t be reliably computed for any
            FY other than the current one: the app stores a single Opening Acc Dep value per asset, not a per-FY snapshot.
            Gross Block figures (Opening/Additions/Deletions/Closing/Cost Check) remain accurate for any period.
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : !items || items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <EmptyIcon fontSize={28} className="text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No assets to reconcile yet.</p>
            <p className="text-xs text-gray-400">Once assets are in the register, this report checks their totals.</p>
          </div>
        ) : (
          <table className="w-full min-w-[3400px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th rowSpan={2} className="border-b-2 border-gray-300 py-2 pr-3 align-bottom">
                  Sub Classification
                </th>
                {GROUPS.map((g) => (
                  <th key={g.key} colSpan={9} className={`border-b-2 border-gray-300 py-2 pr-3 text-center ${g.tint}`}>
                    {g.label}
                  </th>
                ))}
              </tr>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                {GROUPS.map((g) => (
                  <Fragment key={g.key}>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Opening</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Additions</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Deletions</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">
                      <Tooltip text={FIELD_INFO.grossBlock.tooltip}>Closing (Cost)</Tooltip>
                    </th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3">Cost Check</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">
                      <Tooltip text={FIELD_INFO.accumulatedDepreciation.tooltip}>Closing Acc Dep</Tooltip>
                    </th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3">Acc Dep Check</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">NBV Closing</th>
                    <th className="border-b-2 border-gray-300 py-2 pr-3">NBV Check</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.subClassification} className="align-top">
                  <td className="border-b border-gray-100 py-2 pr-3 font-medium text-ink">{item.subClassification}</td>
                  {GROUPS.map((g) => (
                    <GroupCells key={g.key} figures={g.get(item)} isCurrentFy={isCurrentFy} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
