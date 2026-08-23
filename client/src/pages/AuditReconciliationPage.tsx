import { useCallback, useEffect, useState } from "react";
import { fetchAuditReconciliation, getAuditReconciliationExportUrl, type ReconciliationItem } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency } from "../lib/format.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { Tooltip } from "../components/Tooltip.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { EmptyIcon, ErrorIcon, ExportIcon, FailIcon, PassIcon, RetryIcon } from "../lib/icons.js";

// Deliberately its own green/red, not the (now black/charcoal) brand accent — pass/fail
// must stay visually distinct from ordinary UI chrome at a glance.
function CheckBadge({ pass, message }: { pass: boolean; message: string }) {
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
    </div>
  );
}

export function AuditReconciliationPage() {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? null;
  const [items, setItems] = useState<ReconciliationItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const settingsKey = fySettingsKey(settings);

  const load = useCallback(() => {
    if (!asAt) return;
    setLoading(true);
    setError(null);
    fetchAuditReconciliation(asAt)
      .then((res) => setItems(res.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the reconciliation."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asAt]);

  useEffect(() => {
    load();
    // Refetch on any FY setting change, not just AS_AT.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-ink">Audit Reconciliation</h1>
          <a
            href={asAt ? getAuditReconciliationExportUrl(asAt) : undefined}
            aria-disabled={!asAt}
            className={`flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 ${
              !asAt ? "pointer-events-none opacity-40" : ""
            }`}
          >
            <ExportIcon fontSize={14} />
            Export to Excel
          </a>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          For every sub classification and cost component (C1, C2, and Combined), this checks that the numbers roll
          forward correctly: Opening + Additions − Deletions should equal Closing cost, Opening Depreciation + This
          Period's Depreciation − Depreciation Removed should equal Closing Depreciation, and Closing Gross Block −
          Closing Depreciation should equal Closing NBV.
        </p>
      </div>

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
          <table className="w-full min-w-[1300px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th className="border-b-2 border-gray-300 py-2 pr-3">Sub Classification</th>
                <th className="border-b-2 border-gray-300 py-2 pr-3">Component</th>
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
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={`${item.subClassification}-${item.component}`}
                  className={`align-top ${item.component === "Combined" ? "bg-gray-50" : ""}`}
                >
                  <td className="border-b border-gray-100 py-2 pr-3 font-medium text-ink">{item.subClassification}</td>
                  <td
                    className={`border-b border-gray-100 py-2 pr-3 ${
                      item.component === "Combined" ? "font-semibold text-ink" : "text-gray-500"
                    }`}
                  >
                    {item.component}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.openingSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.additionsSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.deletionsSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.closingGrossBlockSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3">
                    <CheckBadge pass={item.costCheckPass} message={item.costCheckMessage} />
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.closingAccDepSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3">
                    <CheckBadge pass={item.depCheckPass} message={item.depCheckMessage} />
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(item.nbvClosingSum)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3">
                    <CheckBadge pass={item.nbvCheckPass} message={item.nbvCheckMessage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
