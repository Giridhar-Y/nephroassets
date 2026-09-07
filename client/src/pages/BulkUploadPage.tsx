import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BULK_UPLOAD_PATHS,
  MASTERS_BULK_UPLOAD_PATHS,
  commitBulkUpload,
  commitBulkUploadChunked,
  previewBulkUpload,
  previewBulkUploadChunked,
  type BulkPreviewResult,
  type BulkPreviewRow,
  type BulkUploadResult,
  type ChunkProgress
} from "../api/client.js";
import { CHUNK_THRESHOLD_BYTES, findDuplicateMasterKeys, findMergeFileConflicts } from "../lib/csvChunking.js";
import {
  AddCircleIcon,
  CollapseExpandIcon,
  ErrorIcon,
  ExpandIcon,
  ExportIcon,
  PassIcon,
  RetryIcon,
  UploadIcon
} from "../lib/icons.js";
import { useToast } from "../components/Toast.js";
import { PageHeader } from "../components/ui/PageHeader.js";

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
    note: "Sub Classification, Status, and Location must match an active entry in Masters (case-insensitive) — a value that doesn't will show as an Error row above. A row with any non-zero C2 figure (cost, additions, deletions, or opening acc. dep.) against a Sub Classification that doesn't have Component 2 is also rejected as an Error row — leave those columns at 0 or blank for that row. dateOfDisposal/deletionsC1/deletionsC2/saleValue are only accepted on a brand-new FAR ID, for importing an asset that was already disposed before it entered this system — to dispose an existing asset, use Bulk Disposals or the single-item Disposal action instead; a row setting these on an existing FAR ID is rejected as an Error row."
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
    optional: ["defaultUsefulLifeC1Years", "hasComponent2", "defaultUsefulLifeC2Years", "active"],
    keyColumnLabel: "Name",
    path: MASTERS_BULK_UPLOAD_PATHS.subClassifications,
    templateName: "sub-classifications",
    note: "active and hasComponent2 both accept true/false or yes/no (case-insensitive) — omit either to default new entries to true and leave existing ones unchanged. Leave defaultUsefulLifeC1Years/C2Years blank to leave them unset (new entries) or unchanged (existing ones). Turning hasComponent2 off for an entry that already has assets with real C2 data is rejected, same as doing it from the Sub Classifications screen."
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
    hasComponent2: "true",
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

// CSV, not XLSX — this app has no client-side Excel-writing library (exceljs is
// server-only; every existing export fetches a server-built .xlsx), and CSV needs none:
// it opens directly in Excel, is exactly the format "Download Template" already
// produces, and — unlike an XLSX round trip — is trivially re-uploadable as-is (Row/
// Error Message are extra columns the bulk parser already ignores, since none of its
// zod schemas are `.strict()`, so a user can fix values and re-upload without deleting
// them first, though removing them is tidier).
function exportErrorRows(preview: BulkPreviewResult, config: UploadConfig, fields: string[]) {
  const errorRows = preview.rows.filter((r) => r.status === "error");
  const headers = ["Row", "Error Message", ...fields];
  const lines = [
    headers,
    ...errorRows.map((r) => [String(r.row), r.message ?? "", ...fields.map((f) => r.data?.[f] ?? "")])
  ];
  const csv = lines.map((line) => line.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${config.templateName}-errors.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Sorted by count descending — at real scale (per the report that prompted this: 204
// errors in a 217,813-row file), a handful of distinct messages almost always account
// for the vast majority of rows (one missing Sub Classification, one bad Location,
// etc.), so the biggest fixes surface first instead of being buried among 204
// near-identical lines.
function groupErrorMessages(rows: BulkPreviewRow[]): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== "error") continue;
    const message = r.message ?? "Unknown error";
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return Array.from(counts, ([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
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

// "45s" / "3m 20s" / "1h 5m" — only as precise as an average-rate-so-far estimate ever
// is, so no point going finer than whole seconds.
function formatRemaining(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 > 0 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
}

// Only rendered for a chunked (large CSV) upload — see csvChunking.ts. `total` (batch
// count) is 0 for the brief moment before the file's been fully read and split into
// chunks. Percentage and the "N of M rows" count are driven off actual row counts, not
// batch counts, so they stay accurate even though the last batch is usually smaller
// than the rest. `startedAt` (Date.now() when the run began) is read fresh on every
// render — this component re-renders on every progress update anyway, so a plain
// elapsed-time calculation is enough without its own ticking timer.
function ChunkProgressBar({ progress, verb, startedAt }: { progress: ChunkProgress; verb: "Validating" | "Uploading"; startedAt: number }) {
  const { current, total, rowsDone, totalRows } = progress;
  if (total === 0) {
    return (
      <div className="mt-2 w-full max-w-xs">
        <p className="text-xs text-gray-500">Reading file…</p>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100" />
      </div>
    );
  }
  const pct = totalRows > 0 ? Math.round((rowsDone / totalRows) * 100) : 0;
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const rate = rowsDone > 0 && elapsedSec > 0 ? rowsDone / elapsedSec : 0;
  const remainingSec = rate > 0 && rowsDone < totalRows ? (totalRows - rowsDone) / rate : null;
  return (
    <div className="mt-2 w-full max-w-xs">
      <p className="text-xs text-gray-500">
        {verb} {rowsDone.toLocaleString("en-IN")} of {totalRows.toLocaleString("en-IN")} rows — batch {current} of {total} ({pct}%)
      </p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      {remainingSec !== null && <p className="mt-0.5 text-[11px] text-gray-400">~{formatRemaining(remainingSec)} remaining</p>}
    </div>
  );
}

const UPLOAD_TYPES: UploadType[] = ["assets", "disposals", "transfers", "merge", "masters"];

// Fixed row height + fixed column widths (rather than the browser's table auto-layout)
// are required for virtualization: only the rows actually in the viewport ever mount, so
// nothing is on-screen to measure content-based column widths against. Same tradeoff
// AssetGrid already makes for Register. A row's cell text is truncated to one line with a
// title tooltip for the full value, rather than wrapping — wrapping would make row height
// variable, which the virtualizer can't size ahead of a row being rendered.
const PREVIEW_ROW_HEIGHT = 28;
// Preview shows one column per uploaded field (~21 for Assets), so unlike the old fixed
// 4-column grid this needs an explicit pixel width per column plus horizontal scroll —
// see the gridTemplateColumns/width built from these below.
const PREVIEW_ROW_COL_WIDTH = 56;
const PREVIEW_STATUS_COL_WIDTH = 104;
const PREVIEW_FIELD_COL_WIDTH = 128;
const PREVIEW_MESSAGE_COL_WIDTH = 220;
const RESULT_GRID_COLS = "grid-cols-[56px_180px_1fr]";

export function BulkUploadPage() {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const resultScrollRef = useRef<HTMLDivElement>(null);
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
  const [expanded, setExpanded] = useState(false);
  // Only meaningful for a chunked upload (see csvChunking.ts) — null the rest of the
  // time, including for a small file that never needed chunking at all.
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress | null>(null);
  // Set right before a chunked run starts, read by ChunkProgressBar (via Date.now() at
  // render time, which happens on every progress update) to estimate time remaining —
  // a ref rather than state since it's never itself something to re-render on.
  const chunkStartRef = useRef(0);

  // Escape closes full screen, same as AssetGrid's own expand toggle — plus a body
  // scroll lock so the page behind the fixed overlay can't be scrolled (AssetGrid's
  // fullscreen doesn't need this since it already fills the page's whole content area;
  // here it only covers one table, so the rest of the page is still visible and would
  // otherwise scroll underneath). One `expanded` flag serves both the preview table and
  // the result step's error table — only one of those steps is ever active at a time, so
  // there's nothing to disambiguate, and it means staying expanded through Confirm Upload
  // carries straight over into the result table instead of snapping back to inline.
  //
  // Gated on the portal actually being on screen (expanded AND still on a step with a
  // table), not just `expanded` — Confirm Upload moves preview -> result without ever
  // flipping `expanded` back to false itself, and this effect only re-runs (running its
  // cleanup) when a value in its dependency array changes. Keying off `expanded` alone
  // left a portal gone but the listener/lock stuck forever, since nothing was left to
  // ever flip `expanded` false again. Keying off `step` too means leaving both steps for
  // any reason — Confirm, Cancel, "Choose a different file", "Upload Another File" —
  // releases the lock.
  useEffect(() => {
    if (!expanded || (step !== "preview" && step !== "result")) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [expanded, step]);

  // Warn before an accidental tab close/reload mid-chunked-upload — a real 212K-row
  // import runs many sequential requests over several minutes, and losing that to a
  // stray Ctrl+W partway through (some chunks committed, the rest not) is a much worse
  // outcome than for any other page in this app, which is why this isn't a global
  // behavior. Only armed while a chunked run is actually in flight (chunkProgress is
  // null again as soon as one finishes or fails, from `finally` in handleFile/
  // handleConfirm below).
  useEffect(() => {
    if (!chunkProgress || !(previewing || confirming)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [chunkProgress, previewing, confirming]);

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
    setExpanded(false);
    setChunkProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const needsChunking = !!file && file.size > CHUNK_THRESHOLD_BYTES;
  // Disposals/Transfers commit several sequential queries per row (scope check, a
  // transaction, cascade to children, activity log) instead of a single batched
  // multi-row INSERT/UPDATE (Assets) or one plain per-row UPDATE (Merge, Masters) — a
  // chunk has to stay well under Vercel's 60s function limit even at that higher
  // per-row cost.
  // ponytail: conservative guess, not measured against production latency the way
  // Assets' 2,000/chunk was (verified live with a real 25k-row file) — watch the first
  // real large Disposals/Transfers upload and raise this if chunks finish comfortably
  // under 60s, or lower it if one times out.
  const chunkRows = type === "disposals" || type === "transfers" ? 300 : undefined;
  // Whole-file cross-row check to run before chunking a type where per-chunk server
  // validation alone isn't enough — see csvChunking.ts's findMergeFileConflicts and
  // findDuplicateMasterKeys for why (Merge's cycle/dup-usage rules and Masters' own
  // Code/Name dedup both currently run over the WHOLE file server-side, so a violation
  // spanning two chunks would otherwise slip past a chunk validated on its own).
  // Assets/Disposals/Transfers fall through to previewBulkUploadChunked/
  // commitBulkUploadChunked's own default (FAR ID dedup).
  const findFileConflicts =
    type === "merge"
      ? findMergeFileConflicts
      : type === "masters"
        ? findDuplicateMasterKeys(masterList === "centers" ? "code" : "name", masterList === "centers" ? "Code" : "Name")
        : undefined;

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
    // Computed from `next` directly, not the `needsChunking`/`file` state above — `file`
    // hasn't actually updated yet at this point in the same tick (setFile is async).
    const chunked = next.size > CHUNK_THRESHOLD_BYTES;
    if (chunked && !next.name.toLowerCase().endsWith(".csv")) {
      setError(
        `This file is ${formatFileSize(next.size)} — files this large must be CSV (Excel's binary format can't be split into smaller uploads without risking it read back differently). Please re-save as CSV and try again.`
      );
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setPreviewing(true);
    if (chunked) chunkStartRef.current = Date.now();
    setChunkProgress(chunked ? { current: 0, total: 0, rowsDone: 0, totalRows: 0 } : null);
    try {
      const res = chunked
        ? await previewBulkUploadChunked(path, next, setChunkProgress, chunkRows, findFileConflicts)
        : await previewBulkUpload(path, next);
      setPreview(res);
      // Defaults ON whenever there's at least one error — at real scale (204 errors
      // among 217,813 rows) they're easy to miss entirely scrolling through a table
      // that's otherwise almost all "New"/"Update" rows, and the checkbox is exactly
      // what surfaces them; a clean file (no errors) leaves it off since there's
      // nothing to filter to.
      setShowOnlyErrors(res.summary.error > 0);
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
    if (needsChunking) chunkStartRef.current = Date.now();
    setChunkProgress(needsChunking ? { current: 0, total: 0, rowsDone: 0, totalRows: 0 } : null);
    try {
      const res = needsChunking
        ? await commitBulkUploadChunked(path, file, setChunkProgress, chunkRows, findFileConflicts)
        : await commitBulkUpload(path, file);
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

  const previewRows = preview ? (showOnlyErrors ? preview.rows.filter((r) => r.status === "error") : preview.rows) : [];
  // Recomputed only when `preview` itself changes (a new file), not on every render —
  // this component re-renders on every chunk-progress tick during Confirm Upload too,
  // and grouping 200K+ rows' worth of error messages on each of those would be wasted
  // work for a value that can't have changed.
  const errorGroups = useMemo(() => (preview ? groupErrorMessages(preview.rows) : []), [preview]);
  const previewVirtualizer = useVirtualizer({
    count: previewRows.length,
    getScrollElement: () => previewScrollRef.current,
    estimateSize: () => PREVIEW_ROW_HEIGHT,
    overscan: 12
  });
  // Same field list "Expected Columns" and the downloaded template already use — Row and
  // Status stay pinned/narrow on the left, then one column per uploaded field, then
  // Message last (a flexible minimum so it still fills spare width on a narrow config
  // like Disposals/Transfers, same as the old grid's 1fr last column).
  const previewFields = [...config.required, ...config.optional];
  const previewGridTemplate = `${PREVIEW_ROW_COL_WIDTH}px ${PREVIEW_STATUS_COL_WIDTH}px repeat(${previewFields.length}, ${PREVIEW_FIELD_COL_WIDTH}px) minmax(${PREVIEW_MESSAGE_COL_WIDTH}px, 1fr)`;
  const previewGridWidth =
    PREVIEW_ROW_COL_WIDTH + PREVIEW_STATUS_COL_WIDTH + previewFields.length * PREVIEW_FIELD_COL_WIDTH + PREVIEW_MESSAGE_COL_WIDTH;

  // Single source of truth for the preview table — called once for the normal in-card
  // layout and once (wrapped in the fullscreen portal below) for the expanded view, so
  // the two can never drift out of sync. Only the container sizing classes differ
  // between the two: the scroll box grows to fill the fullscreen overlay via flex-1
  // instead of being capped at max-h-80. previewScrollRef/previewVirtualizer are shared
  // by both call sites, but only one is ever actually mounted at a time (expanded
  // replaces the inline table rather than sitting alongside it), so the ref always
  // points at whichever copy is currently on screen — same unmount/remount approach
  // AssetGrid's own fullscreen toggle already relies on.
  function renderPreviewTable(isExpanded: boolean) {
    if (!preview) return null;
    return (
      <div className={isExpanded ? "flex h-full min-h-0 flex-col" : "mt-4"}>
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

        {/* The single most important line on this screen for a large file — bumped out
            of plain-paragraph weight into its own bordered/colored callout (red when
            there's anything to fix, green when the whole file is clean) so it can't
            read as a footnote next to the file name above it. */}
        <div
          className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2.5 ${
            preview.summary.error > 0 ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"
          }`}
        >
          {preview.summary.error > 0 ? (
            <ErrorIcon fontSize={16} className="shrink-0 text-red-600" />
          ) : (
            <PassIcon fontSize={16} className="shrink-0 text-green-600" />
          )}
          <p className="text-sm font-semibold text-ink">
            <span className="text-blue-700">{preview.summary.new} new</span>,{" "}
            <span className="text-amber-700">
              {preview.summary.update} update{preview.summary.update === 1 ? "" : "s"}
            </span>
            ,{" "}
            <span className={preview.summary.error > 0 ? "text-red-700" : "text-gray-500"}>
              {preview.summary.error} error{preview.summary.error === 1 ? "" : "s"}
            </span>{" "}
            out of {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"}.
          </p>
        </div>

        {/* Grouped by exact message text, sorted by count descending — at real scale a
            handful of distinct causes almost always account for nearly every error row
            (one missing Sub Classification, one bad Location, etc.), so the biggest fix
            surfaces first instead of being buried among hundreds of near-identical rows
            in the table below. */}
        {errorGroups.length > 0 && (
          <div className="mt-2 max-h-28 overflow-auto rounded-md border border-red-100 bg-red-50/60 px-3 py-2">
            <p className="text-xs font-semibold text-red-700">
              {errorGroups.length} distinct error message{errorGroups.length === 1 ? "" : "s"}:
            </p>
            <ul className="mt-1 space-y-0.5">
              {errorGroups.map(({ message, count }) => (
                <li key={message} className="truncate text-xs text-red-700" title={message}>
                  <span className="font-semibold">
                    {count} row{count === 1 ? "" : "s"}:
                  </span>{" "}
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-2 text-xs text-gray-500">
          Showing all {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"} below — scroll to review every one
          before confirming.
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

        <div className="mt-2 flex items-center justify-between">
          {preview.summary.error > 0 ? (
            <label className="flex w-fit items-center gap-1.5 text-xs font-medium text-gray-600">
              <input
                type="checkbox"
                checked={showOnlyErrors}
                onChange={(e) => setShowOnlyErrors(e.target.checked)}
                className="rounded border-gray-300 text-accent focus:ring-accent"
              />
              Show only rows with errors
            </label>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {preview.summary.error > 0 && (
              <button
                type="button"
                onClick={() => exportErrorRows(preview, config, previewFields)}
                title="Download a CSV of just the error rows (Row, Error Message, then every original column) — fix the values and re-upload."
                className="flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:border-accent hover:bg-gray-50 hover:text-accent"
              >
                <ExportIcon fontSize={14} />
                Export Errors
              </button>
            )}
            <button
              type="button"
              aria-label={isExpanded ? "Exit full screen" : "Expand table to full screen"}
              title={isExpanded ? "Exit full screen (Esc)" : "Expand to full screen"}
              onClick={() => setExpanded(!isExpanded)}
              className="flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:border-accent hover:bg-gray-50 hover:text-accent"
            >
              {isExpanded ? <CollapseExpandIcon fontSize={14} /> : <ExpandIcon fontSize={14} />}
            </button>
          </div>
        </div>

        <div
          ref={previewScrollRef}
          className={
            isExpanded
              ? "mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-gray-200 text-xs"
              : "mt-3 max-h-80 overflow-auto rounded-md border border-gray-200 text-xs"
          }
        >
          <div
            className="sticky top-0 z-10 grid bg-gray-50"
            style={{ gridTemplateColumns: previewGridTemplate, width: previewGridWidth, minWidth: "100%" }}
          >
            <div className="px-3 py-1.5 text-left font-semibold text-gray-600">Row</div>
            <div className="px-3 py-1.5 text-left font-semibold text-gray-600">Status</div>
            {previewFields.map((field) => (
              <div key={field} className="truncate px-3 py-1.5 text-left font-semibold text-gray-600" title={field}>
                {field}
              </div>
            ))}
            <div className="px-3 py-1.5 text-left font-semibold text-gray-600">Message</div>
          </div>
          <div
            data-testid="bulk-preview-scroll-spacer"
            style={{ height: previewVirtualizer.getTotalSize(), width: previewGridWidth, minWidth: "100%", position: "relative" }}
          >
            {previewVirtualizer.getVirtualItems().map((virtualRow) => {
              const r = previewRows[virtualRow.index]!;
              return (
                <div
                  key={r.row}
                  data-testid="bulk-preview-row"
                  className="absolute left-0 top-0 grid border-t border-gray-100"
                  style={{
                    gridTemplateColumns: previewGridTemplate,
                    width: previewGridWidth,
                    minWidth: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <div className="flex items-center px-3 py-1.5 text-gray-500">{r.row}</div>
                  <div className="flex items-center px-3 py-1.5">
                    <PreviewStatusBadge status={r.status} />
                  </div>
                  {previewFields.map((field) => {
                    const value = r.data?.[field] ?? "—";
                    return (
                      <div key={field} className="flex items-center truncate px-3 py-1.5 text-gray-700" title={value}>
                        {value}
                      </div>
                    );
                  })}
                  <div className="flex items-center truncate px-3 py-1.5 text-gray-600" title={r.message}>
                    {r.message ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}

        {confirming && chunkProgress && <ChunkProgressBar progress={chunkProgress} verb="Uploading" startedAt={chunkStartRef.current} />}

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
    );
  }

  const resultErrors = result?.errors ?? [];
  const resultVirtualizer = useVirtualizer({
    count: resultErrors.length,
    getScrollElement: () => resultScrollRef.current,
    estimateSize: () => PREVIEW_ROW_HEIGHT,
    overscan: 12
  });

  // Same shared-render-function approach as renderPreviewTable above, and the same
  // `expanded` flag — the error table is the only part of this step with the same
  // many-rows-in-a-small-box problem, so the expand button only appears once there's an
  // error table to expand.
  function renderResultTable(isExpanded: boolean) {
    if (!result) return null;
    return (
      <div className={isExpanded ? "flex h-full min-h-0 flex-col" : "mt-6"}>
        <p className="flex items-center gap-1.5 text-sm text-green-700">
          <PassIcon fontSize={15} />
          {result.processed} of {result.totalRows} row{result.totalRows === 1 ? "" : "s"} processed successfully.
        </p>
        <p className="mt-1 text-sm text-gray-700">
          <span className="font-semibold text-blue-700">{result.added} added</span>,{" "}
          <span className="font-semibold text-amber-700">{result.updated} updated</span>
          {result.errors.length > 0 && (
            <>
              , <span className="font-semibold text-red-700">{result.errors.length} skipped</span>
            </>
          )}
          .
        </p>
        {result.errors.length > 0 && (
          <div className={isExpanded ? "mt-3 flex min-h-0 flex-1 flex-col" : "mt-3"}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-red-700">
                {result.errors.length} row{result.errors.length === 1 ? "" : "s"} could not be processed:
              </p>
              <button
                type="button"
                aria-label={isExpanded ? "Exit full screen" : "Expand table to full screen"}
                title={isExpanded ? "Exit full screen (Esc)" : "Expand to full screen"}
                onClick={() => setExpanded(!isExpanded)}
                className="flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:border-accent hover:bg-gray-50 hover:text-accent"
              >
                {isExpanded ? <CollapseExpandIcon fontSize={14} /> : <ExpandIcon fontSize={14} />}
              </button>
            </div>
            <div
              ref={resultScrollRef}
              className={
                isExpanded
                  ? "mt-2 min-h-0 flex-1 overflow-auto rounded-md border border-red-100 text-xs"
                  : "mt-2 max-h-64 overflow-auto rounded-md border border-red-100 text-xs"
              }
            >
              <div className={`sticky top-0 z-10 grid ${RESULT_GRID_COLS} bg-red-50`}>
                <div className="px-3 py-1.5 text-left font-semibold text-red-700">Row</div>
                <div className="px-3 py-1.5 text-left font-semibold text-red-700">{config.keyColumnLabel}</div>
                <div className="px-3 py-1.5 text-left font-semibold text-red-700">Problem</div>
              </div>
              <div style={{ height: resultVirtualizer.getTotalSize(), position: "relative" }}>
                {resultVirtualizer.getVirtualItems().map((virtualRow) => {
                  const e = resultErrors[virtualRow.index]!;
                  return (
                    <div
                      key={e.row}
                      data-testid="bulk-result-error-row"
                      className={`absolute left-0 top-0 grid w-full ${RESULT_GRID_COLS} border-t border-red-100`}
                      style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <div className="flex items-center px-3 py-1.5 text-gray-600">{e.row}</div>
                      <div className="flex items-center truncate px-3 py-1.5 text-gray-600" title={e.farId ?? undefined}>
                        {e.farId ?? "—"}
                      </div>
                      <div className="flex items-center truncate px-3 py-1.5 text-gray-600" title={e.message}>
                        {e.message}
                      </div>
                    </div>
                  );
                })}
              </div>
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
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <PageHeader
        icon={UploadIcon}
        title="Bulk Upload"
        bordered={false}
        subtitle="Import a CSV or Excel file to add or update many assets, capitalizations, disposals, transfers, parent/child
        merges, or master list entries at once."
      />

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
              {previewing &&
                (chunkProgress ? (
                  <ChunkProgressBar progress={chunkProgress} verb="Validating" startedAt={chunkStartRef.current} />
                ) : (
                  <p className="text-xs text-gray-500">Reading file…</p>
                ))}
            </div>

            {error && (
              <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}
          </>
        )}

        {step === "preview" && preview && !expanded && renderPreviewTable(false)}

        {step === "preview" &&
          preview &&
          expanded &&
          createPortal(
            <div className="fixed inset-0 z-50 flex flex-col bg-white p-6 shadow-lg">{renderPreviewTable(true)}</div>,
            document.body
          )}

        {step === "result" && result && !expanded && renderResultTable(false)}

        {step === "result" &&
          result &&
          expanded &&
          createPortal(
            <div className="fixed inset-0 z-50 flex flex-col bg-white p-6 shadow-lg">{renderResultTable(true)}</div>,
            document.body
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
