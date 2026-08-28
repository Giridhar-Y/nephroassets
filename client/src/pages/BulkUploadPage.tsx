import { useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BULK_UPLOAD_PATHS,
  MASTERS_BULK_UPLOAD_PATHS,
  commitBulkUpload,
  previewBulkUpload,
  type BulkPreviewResult,
  type BulkUploadResult
} from "../api/client.js";
import { AddCircleIcon, ErrorIcon, ExportIcon, PassIcon, RetryIcon, UploadIcon } from "../lib/icons.js";
import { useToast } from "../components/Toast.js";

type UploadType = "assets" | "disposals" | "transfers" | "merge" | "masters";
type MasterListType = "centers" | "subClassifications" | "statuses";
type Step = "select" | "preview" | "result";

interface UploadConfig {
  label: string;
  description: string;
  required: string[];
  optional: string[];
  keyColumnLabel: string;
  path: string;
  templateName: string;
  note?: string;
}

const TYPE_CONFIG: Record<Exclude<UploadType, "masters">, UploadConfig> = {
  assets: {
    label: "Assets & Capitalization",
    description:
      "Import or update assets, matched by FAR ID. A new FAR ID capitalizes a brand-new asset; an existing one updates it.",
    required: [
      "farId",
      "subClassification",
      "assetDescription",
      "status",
      "dateAcquired",
      "location",
      "usefulLifeC1Years",
      "usefulLifeC2Years"
    ],
    optional: [
      "serialNo",
      "qty",
      "c1OpeningCost",
      "c2OpeningCost",
      "additionsC1",
      "additionsC2",
      "dateOfAddition",
      "accDepC1Opening",
      "accDepC2Opening",
      "dateOfDisposal",
      "deletionsC1",
      "deletionsC2",
      "saleValue"
    ],
    keyColumnLabel: "FAR ID",
    path: BULK_UPLOAD_PATHS.assets,
    templateName: "assets",
    note: "FAR ID may only contain uppercase letters, numbers, and hyphens (e.g. 616-PB-BTI-GNR-C). Sub Classification, Status, and Location must match an active entry in Masters (case-insensitive) — a value that doesn't will show as an Error row above."
  },
  disposals: {
    label: "Disposals",
    description:
      "Dispose many existing assets at once — full disposal only, same as “Dispose Selected” in Register.",
    required: ["farId", "dateOfDisposal"],
    optional: ["saleValue"],
    keyColumnLabel: "FAR ID",
    path: BULK_UPLOAD_PATHS.disposals,
    templateName: "disposals"
  },
  transfers: {
    label: "Transfers",
    description: "Move many assets to new centers at once — one row per move, each with its own date.",
    required: ["farId", "toLocation", "transactionDate"],
    optional: [],
    keyColumnLabel: "FAR ID",
    path: BULK_UPLOAD_PATHS.transfers,
    templateName: "transfers",
    note: "Location must match an active Center in Masters (case-insensitive) — a value that doesn't will show as an Error row above."
  },
  merge: {
    label: "Merge",
    description:
      "Link many existing assets into parent/child relationships at once — same rules as Merge Selected in Register (one level only, neither side disposed).",
    required: ["parentFarId", "childFarId"],
    optional: [],
    keyColumnLabel: "Parent ← Child",
    path: BULK_UPLOAD_PATHS.merge,
    templateName: "merge",
    note: "A child that already has a different parent is rejected, not silently re-parented — re-requesting its existing parent is treated as a no-op. A Location or Sub Classification mismatch between parent and child is shown as a warning, not an error."
  }
};

const MASTER_LIST_CONFIG: Record<MasterListType, UploadConfig & { pillLabel: string }> = {
  centers: {
    label: "Centers",
    pillLabel: "Centers",
    description: "Add or update Centers, matched by Code. An unmatched code creates a new center; a matched one updates it.",
    required: ["code"],
    optional: ["description", "active"],
    keyColumnLabel: "Code",
    path: MASTERS_BULK_UPLOAD_PATHS.centers,
    templateName: "centers",
    note: "active accepts true/false or Active/Inactive (case-insensitive) — omit it to default new centers to Active and leave existing ones unchanged."
  },
  subClassifications: {
    label: "Sub Classifications",
    pillLabel: "Sub Classifications",
    description: "Add or update Sub Classifications, matched by Name. An unmatched name creates a new entry; a matched one updates it.",
    required: ["name"],
    optional: ["defaultUsefulLifeC1Years", "defaultUsefulLifeC2Years", "active"],
    keyColumnLabel: "Name",
    path: MASTERS_BULK_UPLOAD_PATHS.subClassifications,
    templateName: "sub-classifications",
    note: "active accepts true/false or Active/Inactive (case-insensitive) — omit it to default new entries to Active and leave existing ones unchanged. Leave defaultUsefulLifeC1Years/C2Years blank to leave them unset (new entries) or unchanged (existing ones)."
  },
  statuses: {
    label: "Statuses",
    pillLabel: "Statuses",
    description: "Add or update Statuses, matched by Name. An unmatched name creates a new entry; a matched one updates it.",
    required: ["name"],
    optional: ["active"],
    keyColumnLabel: "Name",
    path: MASTERS_BULK_UPLOAD_PATHS.statuses,
    templateName: "statuses",
    note: "active accepts true/false or Active/Inactive (case-insensitive). A system-managed status (e.g. Disposed) cannot be modified via Bulk Upload."
  }
};

const MASTER_LIST_TABS: MasterListType[] = ["centers", "subClassifications", "statuses"];

// One example row per tab, keyed the same as required/optional above, so the downloaded
// template shows correct formatting (dates as DD-MM-YYYY) instead of blank headers a user
// has to guess at. farId is a deliberately fake placeholder rather than a plausible-looking
// FAR ID — a real-looking one risks colliding with an existing asset (silently disposing or
// transferring real data) or simply not existing (a confusing error) if the template is
// uploaded unmodified; this way any error a first-time user gets back is self-explanatory.
const PLACEHOLDER_FAR_ID = "REPLACE-WITH-YOUR-FAR-ID";

const EXAMPLE_ROWS: Record<Exclude<UploadType, "masters">, Record<string, string>> = {
  assets: {
    farId: PLACEHOLDER_FAR_ID,
    subClassification: "IT Equipment",
    assetDescription: "Laptop - Dell Latitude 5420",
    status: "Active",
    dateAcquired: "15-01-2024",
    location: "Center-001",
    usefulLifeC1Years: "5",
    usefulLifeC2Years: "3",
    serialNo: "SN-12345",
    qty: "1",
    c1OpeningCost: "50000",
    c2OpeningCost: "50000",
    additionsC1: "0",
    additionsC2: "0",
    accDepC1Opening: "10000",
    accDepC2Opening: "10000",
    deletionsC1: "0",
    deletionsC2: "0",
    saleValue: "0"
  },
  disposals: {
    farId: PLACEHOLDER_FAR_ID,
    dateOfDisposal: "30-06-2024",
    saleValue: "5000"
  },
  transfers: {
    farId: PLACEHOLDER_FAR_ID,
    toLocation: "Center-002",
    transactionDate: "01-03-2024"
  },
  merge: {
    parentFarId: PLACEHOLDER_FAR_ID,
    childFarId: "FAR-000456"
  }
};

const MASTER_EXAMPLE_ROWS: Record<MasterListType, Record<string, string>> = {
  centers: { code: "Center-050", description: "Sample center", active: "true" },
  subClassifications: {
    name: "Sample Sub Classification",
    defaultUsefulLifeC1Years: "5",
    defaultUsefulLifeC2Years: "5",
    active: "true"
  },
  statuses: { name: "Sample Status", active: "true" }
};

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadTemplate(config: UploadConfig, example: Record<string, string>) {
  const headers = [...config.required, ...config.optional];
  const csv = [headers, headers.map((h) => example[h] ?? "")].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${config.templateName}-template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_BADGE = {
  new: { className: "bg-blue-50 text-blue-700", label: "New", Icon: AddCircleIcon },
  update: { className: "bg-amber-50 text-amber-700", label: "Update", Icon: RetryIcon },
  error: { className: "bg-red-50 text-red-700", label: "Error", Icon: ErrorIcon }
} as const;

function PreviewStatusBadge({ status }: { status: keyof typeof STATUS_BADGE }) {
  const { className, label, Icon } = STATUS_BADGE[status];
  return (
    <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${className}`}>
      <Icon fontSize={13} />
      {label}
    </span>
  );
}

const UPLOAD_TYPES: UploadType[] = ["assets", "disposals", "transfers", "merge", "masters"];

export function BulkUploadPage() {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchParams] = useSearchParams();
  const [type, setType] = useState<UploadType>(() => {
    const requested = searchParams.get("type");
    return UPLOAD_TYPES.includes(requested as UploadType) ? (requested as UploadType) : "assets";
  });
  const [masterList, setMasterList] = useState<MasterListType>(() => {
    const requested = searchParams.get("list");
    return MASTER_LIST_TABS.includes(requested as MasterListType) ? (requested as MasterListType) : "centers";
  });
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<BulkPreviewResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);

  const config: UploadConfig = type === "masters" ? MASTER_LIST_CONFIG[masterList] : TYPE_CONFIG[type];
  const example = type === "masters" ? MASTER_EXAMPLE_ROWS[masterList] : EXAMPLE_ROWS[type];
  const path = config.path;

  function reset() {
    setStep("select");
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setShowOnlyErrors(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function selectType(next: UploadType) {
    setType(next);
    reset();
  }

  function selectMasterList(next: MasterListType) {
    setMasterList(next);
    reset();
  }

  async function handleFile(next: File | null) {
    if (!next) return;
    setFile(next);
    setError(null);
    setPreviewing(true);
    try {
      const res = await previewBulkUpload(path, next);
      setPreview(res);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the file.");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!file) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await commitBulkUpload(path, file);
      setResult(res);
      setStep("result");
      const skipped = res.errors.length > 0 ? ` ${res.errors.length} row${res.errors.length === 1 ? "" : "s"} skipped due to errors.` : "";
      showToast(`${res.added} added, ${res.updated} updated.${skipped}`, res.processed > 0 ? "success" : "error");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
      setConfirming(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0] ?? null);
  }

  const canConfirm = preview !== null && preview.summary.new + preview.summary.update > 0;

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <UploadIcon fontSize={20} />
        Bulk Upload
      </h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">
        Import a CSV or Excel file to add or update many assets, capitalizations, disposals, transfers, parent/child
        merges, or master list entries at once.
      </p>

      <div className="mt-4 flex gap-2">
        {UPLOAD_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              type === t ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => selectType(t)}
          >
            {t === "masters" ? "Masters" : TYPE_CONFIG[t].label}
          </button>
        ))}
      </div>

      {type === "masters" && (
        <div className="mt-2 flex gap-1.5">
          {MASTER_LIST_TABS.map((m) => (
            <button
              key={m}
              type="button"
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                masterList === m ? "bg-ink text-white" : "border border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
              onClick={() => selectMasterList(m)}
            >
              {MASTER_LIST_CONFIG[m].pillLabel}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-600">{config.description}</p>

        {step === "select" && (
          <>
            <div
              className={`mt-4 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
                dragOver ? "border-accent bg-gray-50" : "border-gray-300"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <UploadIcon fontSize={24} className="text-gray-300" />
              <p className="text-sm text-gray-600">Drag and drop a CSV or Excel file here, or</p>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  id="bulk-file-input"
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                />
                <label
                  htmlFor="bulk-file-input"
                  className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
                >
                  Choose File
                </label>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  onClick={() => downloadTemplate(config, example)}
                >
                  <ExportIcon fontSize={15} />
                  Download Template
                </button>
              </div>
              {previewing && <p className="text-xs text-gray-500">Reading file…</p>}
            </div>

            {error && (
              <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}
          </>
        )}

        {step === "preview" && preview && (
          <div className="mt-4">
            <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-ink">
                <UploadIcon fontSize={15} className="text-gray-400" />
                <span className="font-medium">{file?.name}</span>
                <span className="text-gray-400">{file ? `(${formatFileSize(file.size)})` : ""}</span>
              </div>
              <button type="button" className="text-xs font-medium text-gray-500 hover:text-ink" onClick={reset}>
                Choose a different file
              </button>
            </div>

            <p className="mt-4 text-sm text-gray-700">
              <span className="font-semibold text-blue-700">{preview.summary.new} new</span>,{" "}
              <span className="font-semibold text-amber-700">
                {preview.summary.update} update{preview.summary.update === 1 ? "" : "s"}
              </span>
              ,{" "}
              <span className="font-semibold text-red-700">
                {preview.summary.error} error{preview.summary.error === 1 ? "" : "s"}
              </span>{" "}
              out of {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"}.
            </p>
            {preview.summary.error > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                {canConfirm
                  ? `Rows with errors will be skipped. Confirm Upload will process only the ${
                      preview.summary.new + preview.summary.update
                    } valid row${preview.summary.new + preview.summary.update === 1 ? "" : "s"}; the ${
                      preview.summary.error
                    } row${preview.summary.error === 1 ? "" : "s"} with errors will not be applied.`
                  : "Every row has an error — fix the file and choose it again."}
              </p>
            )}

            {preview.summary.error > 0 && (
              <label className="mt-2 flex w-fit items-center gap-1.5 text-xs font-medium text-gray-600">
                <input
                  type="checkbox"
                  checked={showOnlyErrors}
                  onChange={(e) => setShowOnlyErrors(e.target.checked)}
                  className="rounded border-gray-300 text-accent focus:ring-accent"
                />
                Show only rows with errors
              </label>
            )}

            <div className="mt-3 max-h-80 overflow-auto rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Row</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">{config.keyColumnLabel}</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Status</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(showOnlyErrors ? preview.rows.filter((r) => r.status === "error") : preview.rows).map((r) => (
                    <tr key={r.row} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-gray-500">{r.row}</td>
                      <td className="px-3 py-1.5 font-medium text-ink">{r.farId ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        <PreviewStatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-1.5 text-gray-600">{r.message ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
                onClick={reset}
                disabled={confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleConfirm}
                disabled={!canConfirm || confirming}
              >
                {confirming ? "Uploading…" : "Confirm Upload"}
              </button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="mt-6">
            <p className="flex items-center gap-1.5 text-sm text-green-700">
              <PassIcon fontSize={15} />
              {result.processed} of {result.totalRows} row{result.totalRows === 1 ? "" : "s"} processed successfully.
            </p>
            <p className="mt-1 text-sm text-gray-700">
              <span className="font-semibold text-blue-700">{result.added} added</span>,{" "}
              <span className="font-semibold text-amber-700">
                {result.updated} updated
              </span>
              {result.errors.length > 0 && (
                <>
                  ,{" "}
                  <span className="font-semibold text-red-700">
                    {result.errors.length} skipped
                  </span>
                </>
              )}
              .
            </p>
            {result.errors.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium text-red-700">
                  {result.errors.length} row{result.errors.length === 1 ? "" : "s"} could not be processed:
                </p>
                <div className="mt-2 max-h-64 overflow-auto rounded-md border border-red-100">
                  <table className="w-full text-xs">
                    <thead className="bg-red-50">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">Row</th>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">{config.keyColumnLabel}</th>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((e) => (
                        <tr key={e.row} className="border-t border-red-100">
                          <td className="px-3 py-1.5 text-gray-600">{e.row}</td>
                          <td className="px-3 py-1.5 text-gray-600">{e.farId ?? "—"}</td>
                          <td className="px-3 py-1.5 text-gray-600">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <button
              type="button"
              className="mt-4 rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
              onClick={reset}
            >
              Upload Another File
            </button>
          </div>
        )}

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h2 className="text-sm font-semibold text-ink">Expected Columns</h2>
          <p className="mt-1 text-xs text-gray-500">
            The first row must be a header naming these fields{type !== "masters" ? " (dates as DD-MM-YYYY)" : ""}:
          </p>
          <p className="mt-2 text-xs text-gray-700">
            <span className="font-semibold">Required: </span>
            {config.required.join(", ")}
          </p>
          {config.optional.length > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              <span className="font-semibold">Optional: </span>
              {config.optional.join(", ")}
            </p>
          )}
          {config.note && <p className="mt-2 text-xs text-gray-500">{config.note}</p>}
        </div>
      </div>
    </div>
  );
}
