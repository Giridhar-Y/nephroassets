import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchAssetDetail, type AssetDetailResponse } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { Tooltip } from "../components/Tooltip.js";
import {
  AddCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteIcon,
  EmptyIcon,
  ErrorIcon,
  LifecycleIcon,
  PrintIcon,
  RegisterIcon,
  TransferIcon
} from "../lib/icons.js";

const STATUS_BADGE_CLASSES: Record<string, string> = {
  Active: "bg-green-100 text-green-800",
  Disposed: "bg-red-100 text-red-800",
  "Under Repair": "bg-amber-100 text-amber-800"
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE_CLASSES[status] ?? "bg-gray-100 text-gray-700"}`}
    >
      {status}
    </span>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

function ageLabel(dateAcquired: string, asAt: string): { label: string; years: number } {
  const start = new Date(dateAcquired + "T00:00:00Z").getTime();
  const end = new Date(asAt + "T00:00:00Z").getTime();
  const years = Math.max((end - start) / (365.25 * 86_400_000), 0);
  const wholeYears = Math.floor(years);
  const months = Math.round((years - wholeYears) * 12);
  const label =
    wholeYears === 0 && months === 0
      ? "Under 1 month"
      : `${wholeYears > 0 ? `${wholeYears}y ` : ""}${months > 0 ? `${months}m` : ""}`.trim();
  return { label, years };
}

type TimelineEvent =
  | { type: "capitalization"; date: string; location: string; cost: number }
  | { type: "addition"; date: string; amount: number }
  | { type: "transfer"; date: string; from: string; to: string; cascadedFromParentFarId: string | null }
  | {
      type: "disposal";
      date: string;
      saleValue: number;
      wdv: number;
      profitLoss: number;
      cascadedFromParentFarId: string | null;
    };

function buildTimeline(data: AssetDetailResponse): TimelineEvent[] {
  const { asset, result, transfers } = data;
  const events: TimelineEvent[] = [
    {
      type: "capitalization",
      date: asset.dateAcquired,
      location: asset.location,
      cost: asset.c1OpeningCost + asset.c2OpeningCost
    }
  ];

  const additionsTotal = asset.additionsC1 + asset.additionsC2;
  if (additionsTotal > 0 && asset.dateOfAddition) {
    events.push({ type: "addition", date: asset.dateOfAddition, amount: additionsTotal });
  }

  let currentLocation = asset.location;
  for (const t of transfers) {
    events.push({
      type: "transfer",
      date: t.transactionDate,
      from: currentLocation,
      to: t.location,
      cascadedFromParentFarId: t.cascadedFromParentFarId
    });
    currentLocation = t.location;
  }

  if (asset.dateOfDisposal) {
    const wdv = (result.c1.wdvAtDisposal ?? 0) + (result.c2.wdvAtDisposal ?? 0);
    const profitLoss = result.assetProfitLossOnDisposal ?? 0;
    events.push({
      type: "disposal",
      date: asset.dateOfDisposal,
      saleValue: asset.saleValue,
      wdv,
      profitLoss,
      cascadedFromParentFarId: asset.disposedViaParentFarId
    });
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const iconClass = "grid h-8 w-8 shrink-0 place-items-center rounded-full";
  switch (event.type) {
    case "capitalization":
      return (
        <div className="relative flex gap-3 pb-8">
          <div className={`${iconClass} bg-ink text-white`}>
            <AddCircleIcon fontSize={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Capitalized</p>
            <p className="text-xs text-gray-500">
              {formatDate(event.date)} · {event.location} · {formatCurrency(event.cost)} opening cost
            </p>
          </div>
        </div>
      );
    case "addition":
      return (
        <div className="relative flex gap-3 pb-8">
          <div className={`${iconClass} bg-gray-200 text-gray-700`}>
            <AddCircleIcon fontSize={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Capital Addition</p>
            <p className="text-xs text-gray-500">
              {formatDate(event.date)} · {formatCurrency(event.amount)} added to cost
            </p>
          </div>
        </div>
      );
    case "transfer":
      return (
        <div className="relative flex gap-3 pb-8">
          <div className={`${iconClass} bg-gray-200 text-gray-700`}>
            <TransferIcon fontSize={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Transferred</p>
            <p className="text-xs text-gray-500">
              {formatDate(event.date)} · {event.from} → {event.to}
            </p>
            {event.cascadedFromParentFarId && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                Cascaded from parent {event.cascadedFromParentFarId}
              </p>
            )}
          </div>
        </div>
      );
    case "disposal":
      return (
        <div className="relative flex gap-3">
          <div className={`${iconClass} bg-red-600 text-white`}>
            <DeleteIcon fontSize={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Disposed</p>
            <p className="text-xs text-gray-500">
              {formatDate(event.date)} · Sale Value {formatCurrency(event.saleValue)} · WDV {formatCurrency(event.wdv)} ·{" "}
              <span className={event.profitLoss >= 0 ? "text-green-700" : "text-red-600"}>
                {event.profitLoss >= 0 ? "Profit" : "Loss"} {formatCurrency(Math.abs(event.profitLoss))}
              </span>
            </p>
            {event.cascadedFromParentFarId && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                Cascaded from parent {event.cascadedFromParentFarId}
              </p>
            )}
          </div>
        </div>
      );
  }
}

const DETAIL_FIELDS: Array<{ label: string; render: (d: AssetDetailResponse) => string }> = [
  { label: "Serial No", render: (d) => d.asset.serialNo || "—" },
  { label: "Quantity", render: (d) => String(d.asset.qty) },
  { label: "Component 1 Useful Life", render: (d) => `${d.asset.usefulLifeC1Years} years` },
  { label: "Component 2 Useful Life", render: (d) => `${d.asset.usefulLifeC2Years} years` },
  { label: "Component 1 Opening Cost", render: (d) => formatCurrency(d.asset.c1OpeningCost) },
  { label: "Component 2 Opening Cost", render: (d) => formatCurrency(d.asset.c2OpeningCost) },
  { label: "Additions (C1)", render: (d) => formatCurrency(d.asset.additionsC1) },
  { label: "Additions (C2)", render: (d) => formatCurrency(d.asset.additionsC2) },
  { label: "Date of Addition", render: (d) => formatDate(d.asset.dateOfAddition) },
  { label: "Opening Accumulated Depreciation (C1)", render: (d) => formatCurrency(d.asset.accDepC1Opening) },
  { label: "Opening Accumulated Depreciation (C2)", render: (d) => formatCurrency(d.asset.accDepC2Opening) },
  { label: "C1 Depreciation This Period", render: (d) => formatCurrency(d.result.c1.periodDepreciation) },
  { label: "C2 Depreciation This Period", render: (d) => formatCurrency(d.result.c2.periodDepreciation) },
  { label: "Original Location", render: (d) => d.asset.location },
  { label: "Last Date of Transaction", render: (d) => formatDate(d.result.lastDateOfTransaction) }
];

export function AssetLifecyclePage() {
  const { farId } = useParams<{ farId: string }>();
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? null;

  const [data, setData] = useState<AssetDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!farId || !asAt) return;
    setLoading(true);
    setNotFound(false);
    setError(null);
    fetchAssetDetail(farId, asAt)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : "Could not load this asset.");
        }
      })
      .finally(() => setLoading(false));
  }, [farId, asAt]);

  const timeline = useMemo(() => (data ? buildTimeline(data) : []), [data]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white">
        <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-center">
        <EmptyIcon fontSize={28} className="text-gray-300" />
        <p className="text-sm font-medium text-gray-600">No asset found with FAR ID "{farId}".</p>
        <Link to="/assets" className="mt-2 text-xs font-semibold text-accent hover:underline">
          Search for another asset
        </Link>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-center">
        <ErrorIcon fontSize={24} className="text-red-400" />
        <p className="text-sm font-medium text-gray-600">Couldn't load this asset.</p>
        {error && <p className="text-xs text-gray-400">{error}</p>}
      </div>
    );
  }

  const { asset, result } = data;
  const age = ageLabel(asset.dateAcquired, data.asAt);
  const grossBlock = result.c1.grossBlock + result.c2.grossBlock;
  const accDep = result.c1.closingAccDep + result.c2.closingAccDep;
  const nbv = result.c1.nbv + result.c2.nbv;
  const lifeRemainingPct =
    asset.status === "Disposed"
      ? null
      : Math.max(0, Math.min(100, Math.round((1 - age.years / Math.max(asset.usefulLifeC1Years, 1)) * 100)));
  const disposalProfitLoss = result.assetProfitLossOnDisposal ?? 0;
  const disposalWdv = (result.c1.wdvAtDisposal ?? 0) + (result.c2.wdvAtDisposal ?? 0);

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6 print:px-0">
      <div className="flex items-center justify-between print:hidden">
        <Link to="/register" className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
          <RegisterIcon fontSize={13} />
          Back to Register
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
        >
          <PrintIcon fontSize={14} />
          Print this asset
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <LifecycleIcon fontSize={22} className="print:hidden" />
            {asset.farId}
            <StatusBadge status={asset.status} />
          </h1>
          <p className="mt-1 text-sm text-gray-600">{asset.assetDescription}</p>
          <p className="mt-0.5 text-xs text-gray-400">
            {asset.subClassification} · {result.effectiveLocation}
          </p>
        </div>
        <p className="text-xs text-gray-400">Figures as of {formatDate(data.asAt)}</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Age" value={age.label} sub={`Acquired ${formatDate(asset.dateAcquired)}`} />
        <StatTile
          label={FIELD_INFO.grossBlock.label}
          value={formatCurrency(grossBlock)}
          sub={`C1 ${formatCurrency(result.c1.grossBlock)} · C2 ${formatCurrency(result.c2.grossBlock)}`}
        />
        <StatTile
          label={FIELD_INFO.accumulatedDepreciation.label}
          value={formatCurrency(accDep)}
          sub={`C1 ${formatCurrency(result.c1.closingAccDep)} · C2 ${formatCurrency(result.c2.closingAccDep)}`}
        />
        <StatTile
          label={FIELD_INFO.nbv.label}
          value={formatCurrency(nbv)}
          sub={`C1 ${formatCurrency(result.c1.nbv)} · C2 ${formatCurrency(result.c2.nbv)}`}
        />
        <StatTile
          label="Useful Life Remaining"
          value={lifeRemainingPct === null ? "—" : `${lifeRemainingPct}%`}
          sub={lifeRemainingPct === null ? "Disposed" : `of ${asset.usefulLifeC1Years}y (C1)`}
        />
      </div>

      {asset.status === "Disposed" && asset.dateOfDisposal && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <DeleteIcon fontSize={16} />
            Disposal
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Disposal Date</div>
              <div className="mt-1 text-sm text-ink">{formatDate(asset.dateOfDisposal)}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Sale Value</div>
              <div className="mt-1 text-sm text-ink">{formatCurrency(asset.saleValue)}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <Tooltip text={FIELD_INFO.wdv.tooltip}>WDV at Disposal</Tooltip>
              </div>
              <div className="mt-1 text-sm text-ink">{formatCurrency(disposalWdv)}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <Tooltip text={FIELD_INFO.profitLoss.tooltip}>Profit / (Loss)</Tooltip>
              </div>
              <div className={`mt-1 text-sm font-semibold ${disposalProfitLoss >= 0 ? "text-green-700" : "text-red-600"}`}>
                {disposalProfitLoss >= 0 ? "" : "("}
                {formatCurrency(Math.abs(disposalProfitLoss))}
                {disposalProfitLoss >= 0 ? "" : ")"}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Lifecycle Timeline</h2>
        <div className="relative mt-4 before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-gray-200">
          {timeline.map((event, i) => (
            <TimelineRow key={i} event={event} />
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm print:break-inside-avoid">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setDetailsOpen((o) => !o)}
        >
          <h2 className="text-sm font-semibold text-ink">All Details</h2>
          {detailsOpen ? <ChevronUpIcon fontSize={16} /> : <ChevronDownIcon fontSize={16} />}
        </button>
        {detailsOpen && (
          <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {DETAIL_FIELDS.map((f) => (
              <div key={f.label} className="flex items-center justify-between border-b border-gray-100 pb-2 text-sm">
                <dt className="text-gray-500">{f.label}</dt>
                <dd className="font-medium text-ink">{f.render(data)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
