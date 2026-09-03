import type {
  AssetCalculationResult,
  AssetCreateInput,
  AssetFilters,
  AssetInput,
  AssetListResponse,
  FySettings
} from "../lib/types.js";
import type { ColumnCondition } from "../lib/columnFilters.js";
import { chunkCsvRows, findDuplicateFarIds, parseCsvFile, splitCsvFields } from "../lib/csvChunking.js";

export class ApiError extends Error {
  status: number;
  /** Machine-readable error kind from the server (e.g. "UNAUTHENTICATED",
   *  "MUST_CHANGE_PASSWORD", "FORBIDDEN") — present on auth-related errors so callers
   *  can branch on it instead of matching the human-readable message text. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RETRYABLE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // A safety net for transient 5xx (e.g. a cold-start/connection blip resolved by the
  // *next* request) — never on a body-carrying request, since retrying a POST/PATCH
  // risks double-submitting a mutation. The real fix for the known cause of this is
  // server-side (pool.ts's idle-connection error handling); this only smooths over
  // whatever transient failure slips through anyway.
  const isRetryable = (!init?.method || init.method === "GET") && !init?.body;
  let lastRes: Response | undefined;
  for (let attempt = 1; attempt <= (isRetryable ? RETRYABLE_ATTEMPTS : 1); attempt++) {
    const res = await fetch(path, {
      ...init,
      // Only declare a JSON content-type when there's actually a body — Fastify's default
      // JSON body parser rejects an empty body outright (FST_ERR_CTP_EMPTY_JSON_BODY) if
      // told to expect one, which every no-body POST (logout, reset-password) hit.
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
    });
    if (res.ok) return res.json() as Promise<T>;
    lastRes = res;
    if (isRetryable && res.status >= 500 && attempt < RETRYABLE_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }
    break;
  }
  const res = lastRes!;
  const body = await res.json().catch(() => ({}));
  const err = new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status, body.code);
  // A session can die mid-use — 12-hour expiry while a tab stays open overnight, or an
  // admin disabling the account (auth/middleware.ts reads status fresh on every
  // request, so that takes effect immediately, not next login). Without this, only the
  // one component whose fetch happened to fail shows a "Not signed in" error while the
  // rest of the app (sidebar, nav) keeps rendering as if still signed in. AuthContext
  // listens for this and clears its user state, which sends RequireAuth to /login.
  // Skip it for the login endpoint itself — a wrong-password 401 there is normal,
  // expected input validation, not a dead session to react to.
  if (err.code === "UNAUTHENTICATED" && path !== "/api/auth/login") {
    window.dispatchEvent(new Event("auth:unauthenticated"));
  }
  throw err;
}

/** Returns null when settings genuinely haven't been configured yet (404) — a real,
 *  first-run state, not an error — and rethrows anything else (network/server failure). */
export async function fetchSettingsOrNull(): Promise<FySettings | null> {
  try {
    return await request<FySettings>("/api/settings");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function updateSettings(settings: FySettings): Promise<FySettings> {
  return request<FySettings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
}

// The header's "Figures as of" picker's own endpoint — every role, not just admins (see
// PATCH /api/settings/as-at's comment). updateSettings above is now admin-only.
export function updateAsAt(asAt: string): Promise<FySettings> {
  return request<FySettings>("/api/settings/as-at", { method: "PATCH", body: JSON.stringify({ asAt }) });
}

export interface DaysInFyPreview {
  totalAssets: number;
  assetsChanged: number;
  currentTotalPeriodDep: number;
  projectedTotalPeriodDep: number;
  delta: number;
}

export function previewDaysInFy(daysInFy: number): Promise<DaysInFyPreview> {
  return request<DaysInFyPreview>(`/api/settings/days-in-fy/preview?daysInFy=${daysInFy}`);
}

export function updateDaysInFy(daysInFy: number): Promise<FySettings> {
  return request<FySettings>("/api/settings/days-in-fy", {
    method: "PATCH",
    body: JSON.stringify({ daysInFy })
  });
}

export interface SettingsAuditLogEntry {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  username: string | null;
}

export function fetchSettingsAuditLog(): Promise<{ items: SettingsAuditLogEntry[] }> {
  return request<{ items: SettingsAuditLogEntry[] }>("/api/settings/audit-log");
}

export function fetchCenters(): Promise<string[]> {
  return request<string[]>("/api/meta/centers");
}

export interface SubClassificationOption {
  name: string;
  hasComponent2: boolean;
}

export function fetchSubClassifications(): Promise<SubClassificationOption[]> {
  return request<SubClassificationOption[]>("/api/meta/sub-classifications");
}

// excludeSystemManaged=true drops "Disposed" from the list — used by Capitalization,
// which must never let a brand-new asset be created already disposed (that's the
// Disposal flow's job); every other consumer (Register's Status filter, most
// importantly) wants Disposed included, so they call this with no arguments.
export function fetchStatuses(excludeSystemManaged = false): Promise<string[]> {
  const query = excludeSystemManaged ? "?excludeSystemManaged=true" : "";
  return request<string[]>(`/api/meta/statuses${query}`);
}

export interface FetchAssetsParams extends AssetFilters {
  asAt: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  cursor?: string | null;
  limit?: number;
  includeTotal?: boolean;
}

// Every other array-valued filter (center, status, ...) is a plain string[], which
// String() already comma-joins into the "a,b,c" shape the server's multiValue schema
// expects. `conditions` is the one array of *objects* — needs real JSON, or it'd
// serialize as the useless literal "[object Object]".
function setFilterParam(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    search.set(key, JSON.stringify(value));
    return;
  }
  search.set(key, String(value));
}

export function fetchAssets(params: FetchAssetsParams): Promise<AssetListResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      setFilterParam(search, key, value);
    }
  }
  return request<AssetListResponse>(`/api/assets?${search.toString()}`);
}

export interface AssetDetailTransfer {
  id: number;
  transactionDate: string;
  location: string;
  /** Set only when this transfer was written by the parent/child cascade, not chosen
   *  directly — the parent FAR ID it cascaded from, or null for an ordinary transfer. */
  cascadedFromParentFarId: string | null;
}

export interface AssetLocationSegment {
  location: string;
  fromDate: string;
  toDate: string;
  daysHeld: number;
  c1Depreciation: number;
  c2Depreciation: number;
  depreciation: number;
}

export interface AssetDetailResponse {
  asset: AssetInput;
  result: AssetCalculationResult;
  transfers: AssetDetailTransfer[];
  asAt: string;
  /** This period's depreciation split across every center the asset resided in — same
   *  calculation as the Asset Movement & Depreciation Schedule report, scoped to this
   *  one FAR ID. */
  locationSegments: AssetLocationSegment[];
}

// Asset 360: one asset's full record, its computed result, and complete transfer
// history (not just transfers up to AS_AT). Throws ApiError with status 404 if the FAR
// ID doesn't exist — callers show a "not found" state for that case.
export function fetchAssetDetail(farId: string, asAt: string): Promise<AssetDetailResponse> {
  return request(`/api/assets/${encodeURIComponent(farId)}?${new URLSearchParams({ asAt })}`);
}

export function createTransfer(payload: {
  farIds: string[];
  toLocation: string;
  transactionDate: string;
}): Promise<{ transferred: number; childrenIncluded: string[] }> {
  return request("/api/transfers", { method: "POST", body: JSON.stringify(payload) });
}

// Register's "Export to Excel": builds the download URL for the current filters (no
// filters applied exports the entire register, with a note saying so). Not a fetch —
// the browser downloads it directly via the Content-Disposition header, same as any
// other file download link. `conditions` (the Excel-style column-header custom filters)
// is included via the same array-of-objects JSON serialization fetchAssets uses — the
// export route now parses and applies it exactly like GET /api/assets does.
export function getExportUrl(params: { asAt: string } & AssetFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      setFilterParam(search, key, value);
    }
  }
  return `/api/assets/export?${search.toString()}`;
}

// Capitalization: register a brand-new asset.
export function createAsset(payload: AssetCreateInput): Promise<{ farId: string; created: boolean }> {
  return request("/api/assets", { method: "POST", body: JSON.stringify(payload) });
}

export interface AssetEditInput {
  farId: string;
  subClassification: string;
  assetDescription: string;
  serialNo: string;
  usefulLifeC1Years: number;
  usefulLifeC2Years: number;
  accDepC1Opening: number;
  accDepC2Opening: number;
  parentFarId: string | null;
}

// Edit: modify an already-capitalized asset's non-historical particulars. Deliberately
// a short field list — see the server's editAssetSchema for why Date Acquired/
// Location/Status/cost/additions fields aren't included.
export function updateAsset(farId: string, payload: AssetEditInput): Promise<{ farId: string; updated: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}`, { method: "PATCH", body: JSON.stringify(payload) });
}

// Disposal: full disposal only — the server writes off the asset's entire capitalized cost.
export function disposeAsset(
  farId: string,
  payload: { dateOfDisposal: string; saleValue: number }
): Promise<{ farId: string; disposed: boolean; childrenDisposed: string[] }> {
  return request(`/api/assets/${encodeURIComponent(farId)}/disposal`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

// Mid-Year Addition on an already-capitalized asset — writes the same
// additionsC1/C2 + dateOfAddition columns Capitalization's own form uses. One addition
// per asset, ever (see the server's additionSchema comment) — rejected with a 409 if
// the asset already has one recorded.
export function recordAddition(
  farId: string,
  payload: { additionsC1: number; additionsC2: number; dateOfAddition: string; parentFarId?: string }
): Promise<{ farId: string; added: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}/addition`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

// Capitalization delete (Global Admin only) — soft-deletes the whole asset row. Blocked
// server-side if the asset has any transfer, addition, disposal, or children — see the
// server's DELETE /api/assets/:farId comment.
export function deleteAsset(farId: string, reason: string): Promise<{ farId: string; deleted: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}`, { method: "DELETE", body: JSON.stringify({ reason }) });
}

// Addition undo (Global Admin only) — clears additionsC1/C2 + dateOfAddition back to
// their defaults. Blocked server-side if the asset has since been disposed.
export function undoAddition(farId: string, reason: string): Promise<{ farId: string; additionUndone: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}/addition/undo`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

// Disposal undo (Global Admin only) — reverses the disposal (status restored to
// Active — the pre-disposal status isn't stored, see the server route's comment) and
// automatically un-disposes any child cascaded by this same disposal.
export function undoDisposal(
  farId: string,
  reason: string
): Promise<{ farId: string; disposalUndone: boolean; childrenUndone: string[] }> {
  return request(`/api/assets/${encodeURIComponent(farId)}/disposal/undo`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

// Transfer delete (Global Admin only) — soft-deletes one transfer row (and any paired
// parent/child cascade row written in the same move). See the server route's comment for
// why this is safe without a separate recalculation step (Effective Location always
// re-derives from whatever transfer history remains).
export function deleteTransfer(
  id: number,
  reason: string
): Promise<{ id: number; deleted: boolean; cascadedChildren: string[] }> {
  return request(`/api/transfers/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
}

export type ActivityCategory = "capitalization" | "addition" | "transfer" | "disposal" | "delete" | "masters";

export interface ActivityLogEntry {
  id: number;
  source: "activity" | "delete" | "masters";
  action: string;
  category: ActivityCategory;
  farId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  actorUsername: string | null;
}

export interface FetchActivityLogParams {
  farId?: string;
  category?: ActivityCategory;
  dateFrom?: string;
  dateTo?: string;
  cursor?: string | null;
  limit?: number;
}

// Read-only view of every Capitalization/Addition/Transfer/Disposal CREATE event, every
// Global-Admin delete/undo action, and every Masters create/rename/deactivate/
// reactivate — single-item and bulk-uploaded alike — see the server route's own comment
// for exactly what it covers. One consolidated feed (this used to be two separate pages,
// this one plus a standalone admin-only Delete Log).
export function fetchActivityLog(
  params: FetchActivityLogParams = {}
): Promise<{ items: ActivityLogEntry[]; nextCursor: string | null }> {
  const search = new URLSearchParams();
  if (params.farId) search.set("farId", params.farId);
  if (params.category) search.set("category", params.category);
  if (params.dateFrom) search.set("dateFrom", params.dateFrom);
  if (params.dateTo) search.set("dateTo", params.dateTo);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit) search.set("limit", String(params.limit));
  return request(`/api/audit-log/activity?${search}`);
}

// Same pattern as the Register/Audit Reconciliation's own getExportUrl — the browser
// downloads it directly via the Content-Disposition header, this just builds the URL.
// No cursor/limit (the export always covers every matching row, not one page).
export function getActivityLogExportUrl(params: Pick<FetchActivityLogParams, "farId" | "category" | "dateFrom" | "dateTo"> = {}): string {
  const search = new URLSearchParams();
  if (params.farId) search.set("farId", params.farId);
  if (params.category) search.set("category", params.category);
  if (params.dateFrom) search.set("dateFrom", params.dateFrom);
  if (params.dateTo) search.set("dateTo", params.dateTo);
  return `/api/audit-log/activity/export?${search}`;
}

// Bulk merge from Register: link one or more existing assets as children of one existing
// parent in a single request — same validation Edit already applies one-at-a-time.
export function mergeAssets(
  parentFarId: string,
  childFarIds: string[]
): Promise<{ parentFarId: string; childFarIds: string[]; merged: number }> {
  return request("/api/assets/merge", { method: "POST", body: JSON.stringify({ parentFarId, childFarIds }) });
}

export interface DisposalPreview {
  farId: string;
  c1Wdv: number | null;
  c2Wdv: number | null;
  totalWdv: number;
  profitLoss: number;
}

// Real preview, not an estimate: runs the same calc engine formula (WDV/Profit-Loss
// evaluated at the chosen Disposal Date), against the same full-cost write-off a real
// disposal applies — without writing anything.
export function previewDisposal(
  farId: string,
  payload: { dateOfDisposal: string; saleValue: number }
): Promise<DisposalPreview> {
  return request(`/api/assets/${encodeURIComponent(farId)}/disposal/preview`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export interface TransferHistoryItem {
  id: number;
  farId: string;
  assetDescription: string;
  transactionDate: string;
  fromLocation: string;
  location: string;
}

export interface TransferHistoryResponse {
  items: TransferHistoryItem[];
  nextCursor: number | null;
}

export interface TransferHistoryFilters {
  search?: string;
  descriptionSearch?: string;
  location?: string[];
  transactionDateFrom?: string;
  transactionDateTo?: string;
  /** Excel-style column-header custom filters — see columnFilters.ts. */
  conditions?: import("../lib/columnFilters.js").ColumnCondition[];
}

export function fetchTransferHistory(
  params: TransferHistoryFilters & { cursor?: number | null; limit?: number }
): Promise<TransferHistoryResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      setFilterParam(search, key, value);
    }
  }
  return request(`/api/transfers?${search.toString()}`);
}

export interface BulkUploadError {
  row: number;
  farId: string | null;
  message: string;
}

export interface BulkUploadResult {
  totalRows: number;
  processed: number;
  added: number;
  updated: number;
  errors: BulkUploadError[];
}

export interface BulkPreviewRow {
  row: number;
  farId: string | null;
  status: "new" | "update" | "error";
  message?: string;
  data: Record<string, string>;
}

export interface BulkPreviewResult {
  totalRows: number;
  summary: { new: number; update: number; error: number };
  rows: BulkPreviewRow[];
}

// Bypasses the `request` helper: it always sets Content-Type: application/json, but a
// multipart upload needs the browser to set its own Content-Type with the form boundary.
async function postFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(path, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

// Bulk Upload's four modes: create/update assets (capitalization included — a new FAR
// ID capitalizes, an existing one updates), full disposals, center transfers, and
// parent/child merge. Each has a matching `?preview=true` mode on the same route that
// classifies rows without writing anything, so Confirm Upload (the plain call below) is
// guaranteed to match what the preview showed — it's the same server-side validation,
// just re-run.
export const BULK_UPLOAD_PATHS = {
  assets: "/api/assets/bulk-upload",
  disposals: "/api/assets/bulk-dispose",
  transfers: "/api/transfers/bulk-upload",
  merge: "/api/assets/bulk-merge"
} as const;

export const MASTERS_BULK_UPLOAD_PATHS = {
  centers: "/api/masters/centers/bulk-upload",
  subClassifications: "/api/masters/sub-classifications/bulk-upload",
  statuses: "/api/masters/statuses/bulk-upload"
} as const;

export function previewBulkUpload(path: string, file: File): Promise<BulkPreviewResult> {
  return postFile(`${path}?preview=true`, file);
}

export function commitBulkUpload(path: string, file: File): Promise<BulkUploadResult> {
  return postFile(path, file);
}

// Chunked upload for a file too big for one request — see lib/csvChunking.ts's own
// top comment for why (Vercel's hard ~4.5MB request-body ceiling) and why this only
// supports CSV (line-splitting the ORIGINAL bytes, not a parse/reformat round trip).
// Same `postFile` helper below, just given a Blob + explicit filename instead of a
// real File — loadWorksheet on the server picks its CSV reader off that filename's
// extension, not the content, so every chunk needs one ending in ".csv".
async function postFileBlob<T>(path: string, blob: Blob, filename: string): Promise<T> {
  const formData = new FormData();
  formData.append("file", blob, filename);
  const res = await fetch(path, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export interface ChunkProgress {
  current: number;
  total: number;
}

/** Re-splits a raw CSV data line into a header-keyed Record for display — used only for
 *  the duplicate-FAR-ID rows the client itself flags (see csvChunking.ts's
 *  findDuplicateFarIds), so they render in the preview table with real cell values
 *  instead of blank ones, the same as a server-reported error row would. */
function rowRecordFromCsvLine(header: string[], line: string): Record<string, string> {
  const fields = splitCsvFields(line);
  const record: Record<string, string> = {};
  header.forEach((h, i) => {
    if (h && fields[i]) record[h] = fields[i]!;
  });
  return record;
}

export async function previewBulkUploadChunked(
  path: string,
  file: File,
  onProgress: (p: ChunkProgress) => void,
  chunkRows?: number,
  // Whole-file cross-row check to run before chunking — defaults to Assets/Disposals/
  // Transfers' FAR ID dedup; Merge and Masters pass their own (see csvChunking.ts's
  // findMergeFileConflicts / findDuplicateMasterKeys).
  findFileConflicts: (header: string[], dataLines: string[]) => ReturnType<typeof findDuplicateFarIds> = findDuplicateFarIds
): Promise<BulkPreviewResult> {
  const { header, dataLines } = await parseCsvFile(file);
  const duplicates = findFileConflicts(header, dataLines);
  const duplicateRows = new Set(duplicates.map((d) => d.row));
  // Excluded from what's actually uploaded — each chunk validates independently
  // server-side, so a duplicate spanning two different chunks wouldn't be caught there
  // (see csvChunking.ts's findDuplicateFarIds for the full reasoning).
  const nonDuplicateLines = dataLines.filter((_, i) => !duplicateRows.has(i + 2));
  const chunks = chunkCsvRows(header, nonDuplicateLines, chunkRows);

  const rows: BulkPreviewRow[] = duplicates.map((d) => ({
    row: d.row,
    farId: d.farId,
    status: "error" as const,
    message: d.message,
    data: rowRecordFromCsvLine(header, dataLines[d.row - 2]!)
  }));
  let newCount = 0;
  let updateCount = 0;
  let errorCount = duplicates.length;

  onProgress({ current: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const result = await postFileBlob<BulkPreviewResult>(`${path}?preview=true`, chunk.blob, "chunk.csv");
    for (const r of result.rows) rows.push({ ...r, row: r.row + chunk.rowOffset });
    newCount += result.summary.new;
    updateCount += result.summary.update;
    errorCount += result.summary.error;
    onProgress({ current: i + 1, total: chunks.length });
  }

  rows.sort((a, b) => a.row - b.row);
  return { totalRows: dataLines.length, summary: { new: newCount, update: updateCount, error: errorCount }, rows };
}

export async function commitBulkUploadChunked(
  path: string,
  file: File,
  onProgress: (p: ChunkProgress) => void,
  chunkRows?: number,
  findFileConflicts: (header: string[], dataLines: string[]) => ReturnType<typeof findDuplicateFarIds> = findDuplicateFarIds
): Promise<BulkUploadResult> {
  const { header, dataLines } = await parseCsvFile(file);
  const duplicates = findFileConflicts(header, dataLines);
  const duplicateRows = new Set(duplicates.map((d) => d.row));
  const nonDuplicateLines = dataLines.filter((_, i) => !duplicateRows.has(i + 2));
  const chunks = chunkCsvRows(header, nonDuplicateLines, chunkRows);

  const errors: BulkUploadError[] = duplicates.map((d) => ({ row: d.row, farId: d.farId, message: d.message }));
  let processed = 0;
  let added = 0;
  let updated = 0;

  onProgress({ current: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const result = await postFileBlob<BulkUploadResult>(path, chunk.blob, "chunk.csv");
    processed += result.processed;
    added += result.added;
    updated += result.updated;
    for (const e of result.errors) errors.push({ ...e, row: e.row + chunk.rowOffset });
    onProgress({ current: i + 1, total: chunks.length });
  }

  errors.sort((a, b) => a.row - b.row);
  return { totalRows: dataLines.length, processed, added, updated, errors };
}

export interface LocationSummary {
  location: string;
  asAt: string;
  assetCount: number;
  totalC1GrossBlock: number;
}

export function fetchLocationSummary(location: string, asAt: string): Promise<LocationSummary> {
  return request(`/api/reports/location-summary?${new URLSearchParams({ location, asAt })}`);
}

export interface ReconciliationComponentFigures {
  openingSum: number;
  additionsSum: number;
  deletionsSum: number;
  closingGrossBlockSum: number;
  costCheckPass: boolean;
  costCheckDelta: number;
  costCheckMessage: string;
  accDepOpeningSum: number;
  periodDepSum: number;
  accDepRemovedSum: number;
  closingAccDepSum: number;
  /** Amount the locked calc engine's Closing Acc Dep clamp capped down (>=0) / floored
   *  up (>=0) this row's figures from the naive roll-forward — see reports.ts's
   *  `adjusted` CTE. Both 0 for the overwhelming majority of rows. */
  cappedSum: number;
  flooredSum: number;
  /** Null when cappedSum/flooredSum are both ~0 — nothing to explain. */
  capAdjustmentMessage: string | null;
  depCheckPass: boolean;
  depCheckDelta: number;
  depCheckMessage: string;
  nbvOpeningSum: number;
  nbvClosingSum: number;
  nbvCheckPass: boolean;
  nbvCheckDelta: number;
  nbvCheckMessage: string;
}

// One row per Sub Classification, with C1/C2/Combined as column groups on that same
// row — not one row per (subClassification, component) pair. c2 is null (not
// zero-filled) for a Sub Classification that doesn't have Component 2; combined is
// still populated even then (it just equals c1 exactly in that case).
export interface ReconciliationItem {
  subClassification: string;
  c1: ReconciliationComponentFigures;
  c2: ReconciliationComponentFigures | null;
  combined: ReconciliationComponentFigures;
}

export interface ReconciliationPeriod {
  asAt: string;
  /** fyStart/fyEnd let this report reconcile a genuinely different financial year, not
   *  just a different date within the current one — omit both to use the app-wide
   *  Settings FY (only asAt is then an independent override). */
  fyStart?: string;
  fyEnd?: string;
}

function reconciliationParams(period: ReconciliationPeriod): URLSearchParams {
  const params: Record<string, string> = { asAt: period.asAt };
  if (period.fyStart) params.fyStart = period.fyStart;
  if (period.fyEnd) params.fyEnd = period.fyEnd;
  return new URLSearchParams(params);
}

export function fetchAuditReconciliation(
  period: ReconciliationPeriod
): Promise<{ asAt: string; fyStart: string; isCurrentFy: boolean; items: ReconciliationItem[] }> {
  return request(`/api/reports/audit-reconciliation?${reconciliationParams(period)}`);
}

// Same pattern as the Register's getExportUrl — the browser downloads it directly via
// the Content-Disposition header, this just builds the URL.
export function getAuditReconciliationExportUrl(period: ReconciliationPeriod): string {
  return `/api/reports/audit-reconciliation/export?${reconciliationParams(period)}`;
}

export interface DepreciationPostingBreakdown {
  subClassification: string;
  c1PeriodDep: number;
  c2PeriodDep: number;
  total: number;
}

export function fetchDepreciationPosting(
  asAt: string
): Promise<{ asAt: string; totalPeriodDepreciation: number; breakdown: DepreciationPostingBreakdown[] }> {
  return request(`/api/reports/depreciation-posting?${new URLSearchParams({ asAt })}`);
}

// Finance FAR Dashboard — mirrors server/src/routes/reports.ts's computeDashboardSummary
// response shape field-for-field.
export interface DashboardStatusCount {
  status: string;
  count: number;
}

export interface DashboardNbvTrendPoint {
  asAt: string;
  nbv: number;
}

export interface DashboardExceptionResult {
  count: number;
}

export interface DashboardSummary {
  asAt: string;
  totals: {
    grossBlock: number;
    openingGrossBlock: number;
    additionsFytd: number;
    closingAccDep: number;
    nbv: number;
    assetCount: number;
    qtyTotal: number;
  };
  statusCounts: DashboardStatusCount[];
  depreciationFytd: number;
  disposalPL: {
    gains: number;
    losses: number;
    disposalCount: number;
    totalDeletions: number;
    saleProceeds: number;
    // Since-inception (all-time as of asAt) — what the Register export's own unscoped
    // Disposal P&L columns reconcile against; the fields above stay FYTD.
    allTime: {
      gains: number;
      losses: number;
      disposalCount: number;
    };
  };
  nbvTrend: DashboardNbvTrendPoint[];
  // Counts only — a tile's drill-through opens Register itself
  // (GET /api/assets?exception=<key>, the same shared predicate) for the actual rows,
  // with real pagination/sorting/export, rather than this endpoint carrying a second,
  // capped copy of them.
  exceptions: Record<import("../lib/exceptions.js").ExceptionKey, DashboardExceptionResult>;
}

export function fetchDashboardSummary(
  asAt: string,
  opts?: { center?: string; subClassification?: string }
): Promise<DashboardSummary> {
  const params: Record<string, string> = { asAt };
  if (opts?.center) params.center = opts.center;
  if (opts?.subClassification) params.subClassification = opts.subClassification;
  return request(`/api/reports/dashboard-summary?${new URLSearchParams(params)}`);
}

export interface MovementScheduleRow {
  farId: string;
  subClassification: string;
  assetDescription: string;
  location: string;
  fromDate: string;
  toDate: string;
  daysHeld: number;
  c1Depreciation: number;
  c2Depreciation: number;
  depreciation: number;
}

export interface TransferDepreciationLocationRow {
  location: string;
  assetCount: number;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
  totalDepreciation: number;
}

// Built for scale (this report is expected to grow toward Register's own 2,50,000-asset
// figure) — a real paginated endpoint (keyset cursor on farId, same shape as
// fetchAssets/GET /api/assets) over ASSETS, but each asset expands into one row per
// location-stay server-side, so a page can return more rows than its `limit`.
export interface MovementSchedulePage {
  items: MovementScheduleRow[];
  nextCursor: string | null;
  asAt: string;
}

function transferDepreciationConditionsParam(conditions: ColumnCondition[]): string {
  return conditions.length > 0 ? JSON.stringify(conditions) : "";
}

export interface FetchMovementScheduleParams {
  asAt: string;
  conditions?: ColumnCondition[];
  cursor?: string | null;
  limit?: number;
}

export function fetchMovementSchedule(params: FetchMovementScheduleParams): Promise<MovementSchedulePage> {
  const search = new URLSearchParams({ asAt: params.asAt });
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit) search.set("limit", String(params.limit));
  const conditionsParam = transferDepreciationConditionsParam(params.conditions ?? []);
  if (conditionsParam) search.set("conditions", conditionsParam);
  return request(`/api/reports/transfer-depreciation/movement?${search}`);
}

export function fetchTransferDepreciationLocationWise(
  asAt: string,
  conditions: ColumnCondition[] = []
): Promise<{ asAt: string; fyStart: string; locationWise: TransferDepreciationLocationRow[] }> {
  const search = new URLSearchParams({ asAt });
  const conditionsParam = transferDepreciationConditionsParam(conditions);
  if (conditionsParam) search.set("conditions", conditionsParam);
  return request(`/api/reports/transfer-depreciation/location-wise?${search}`);
}

// Same pattern as Audit Reconciliation's getAuditReconciliationExportUrl — the browser
// downloads it directly via the Content-Disposition header, this just builds the URL.
export function getTransferDepreciationExportUrl(asAt: string, conditions: ColumnCondition[] = []): string {
  const search = new URLSearchParams({ asAt });
  const conditionsParam = transferDepreciationConditionsParam(conditions);
  if (conditionsParam) search.set("conditions", conditionsParam);
  return `/api/reports/transfer-depreciation/export?${search}`;
}

// Masters: managed lists for Center/Location, Sub Classification, and Status — replacing
// the free-text (or datalist-suggested-but-unenforced) values those fields used to be.
// Renaming cascades server-side to every asset (and, for centers, every transfer) that
// currently holds the old value, so the master list and those columns never disagree;
// deactivating never touches existing rows, it only stops the value being offered again.
export interface MasterCenter {
  id: number;
  code: string;
  description: string;
  active: boolean;
  usageCount: number;
}

export function fetchMasterCenters(): Promise<MasterCenter[]> {
  return request("/api/masters/centers");
}

export function createMasterCenter(payload: { code: string; description?: string }): Promise<MasterCenter> {
  return request("/api/masters/centers", { method: "POST", body: JSON.stringify(payload) });
}

export function updateMasterCenter(
  id: number,
  payload: Partial<{ code: string; description: string; active: boolean }>
): Promise<MasterCenter & { assetsUpdated?: number; transfersUpdated?: number }> {
  return request(`/api/masters/centers/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export interface MasterSubClassification {
  id: number;
  name: string;
  defaultUsefulLifeC1Years: number | null;
  defaultUsefulLifeC2Years: number | null;
  hasComponent2: boolean;
  active: boolean;
  usageCount: number;
}

export function fetchMasterSubClassifications(): Promise<MasterSubClassification[]> {
  return request("/api/masters/sub-classifications");
}

export function createMasterSubClassification(payload: {
  name: string;
  defaultUsefulLifeC1Years?: number | null;
  defaultUsefulLifeC2Years?: number | null;
  hasComponent2?: boolean;
}): Promise<MasterSubClassification> {
  return request("/api/masters/sub-classifications", { method: "POST", body: JSON.stringify(payload) });
}

export function updateMasterSubClassification(
  id: number,
  payload: Partial<{
    name: string;
    defaultUsefulLifeC1Years: number | null;
    defaultUsefulLifeC2Years: number | null;
    hasComponent2: boolean;
    active: boolean;
  }>
): Promise<MasterSubClassification & { assetsUpdated?: number }> {
  return request(`/api/masters/sub-classifications/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export interface MasterStatus {
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usageCount: number;
}

export function fetchMasterStatuses(): Promise<MasterStatus[]> {
  return request("/api/masters/statuses");
}

export function createMasterStatus(payload: { name: string }): Promise<MasterStatus> {
  return request("/api/masters/statuses", { method: "POST", body: JSON.stringify(payload) });
}

export function updateMasterStatus(
  id: number,
  payload: Partial<{ name: string; active: boolean }>
): Promise<MasterStatus & { assetsUpdated?: number }> {
  return request(`/api/masters/statuses/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

// Roles: a manageable Master like the three above, but no bulk upload (a handful of
// roles doesn't need one) and each row carries its own permission template (`grants`) —
// what a user gets at creation time, or an explicit "Reset to [role] template" click
// (AdminPage.tsx). Editing `grants` never touches an existing user's actual access.
export interface MasterRole {
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usageCount: number;
  grants: PermissionGrant[];
}

export function fetchMasterRoles(): Promise<MasterRole[]> {
  return request("/api/masters/roles");
}

export function createMasterRole(payload: { name: string; grants: PermissionGrant[] }): Promise<MasterRole> {
  return request("/api/masters/roles", { method: "POST", body: JSON.stringify(payload) });
}

export function updateMasterRole(
  id: number,
  payload: Partial<{ name: string; active: boolean }>
): Promise<MasterRole & { usersUpdated?: number }> {
  return request(`/api/masters/roles/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export function saveRolePermissions(id: number, grants: PermissionGrant[]): Promise<{ grants: PermissionGrant[] }> {
  return request(`/api/masters/roles/${id}/permissions`, { method: "PUT", body: JSON.stringify({ grants }) });
}

// --- Auth ------------------------------------------------------------------------

/** A creation-time template label, not a fixed set — Roles is a manageable Master
 *  (MastersPage.tsx's Roles tab), any active role name is valid. The three built-in
 *  ones (Viewer/Editor/Admin) ship with sensible starting templates; see
 *  fetchMasterRoles for the live list and each role's actual grants. */
export type Role = string;

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  /** `"module:action"` strings — see server/src/auth/permissions.ts's PERMISSION_REGISTRY.
   *  The single source of truth for what this user can actually do; `role` above is a
   *  creation-time label only. Use lib/permissions.ts's `hasPermission` to check it. */
  permissions: string[];
  /** A second, independent dimension on top of `permissions` above — which centers
   *  this user can see/act on, narrowing rows within whatever `permissions` already
   *  allows, never replacing that check. `null` means unscoped (sees every center,
   *  every pre-existing user's behavior); a non-null array (even empty) means scoped
   *  to exactly these center codes. Purely informational client-side today (e.g. for
   *  a future picker-narrowing convenience) — every real boundary is enforced
   *  server-side regardless of what this says. */
  centerAccess: string[] | null;
}

export function login(username: string, password: string): Promise<{ user: AuthUser }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function logout(): Promise<{ ok: true }> {
  return request("/api/auth/logout", { method: "POST" });
}

/** Returns null for a genuinely-not-signed-in visitor (401) rather than throwing —
 *  that's the expected state on first load, not an error. Rethrows anything else. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const { user } = await request<{ user: AuthUser }>("/api/auth/me");
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  return request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword })
  });
}

// --- Admin: user management -------------------------------------------------------

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function fetchAdminUsers(): Promise<AdminUser[]> {
  return request("/api/admin/users");
}

export function createAdminUser(payload: {
  username: string;
  email: string;
  password: string;
  role: Role;
}): Promise<AdminUser> {
  return request("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
}

export function updateAdminUser(
  id: number,
  payload: Partial<{ email: string; role: Role; status: "active" | "disabled" }>
): Promise<AdminUser> {
  return request(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export function resetAdminUserPassword(id: number): Promise<{ user: AdminUser; tempPassword: string }> {
  return request(`/api/admin/users/${id}/reset-password`, { method: "POST" });
}

export interface PermissionGrant {
  module: string;
  action: string;
}

// registry: the full, static list of every grantable (module, action) pair, independent
// of this one user's current grants — what the Permissions panel renders as its
// checkbox grid. grants: this user's actual current permissions. centerAccess: this
// user's current center scope — empty array means unscoped (see the Center Access
// section of the Permissions panel).
export function fetchUserPermissions(
  id: number
): Promise<{ grants: PermissionGrant[]; registry: PermissionGrant[]; centerAccess: string[] }> {
  return request(`/api/admin/users/${id}/permissions`);
}

// Replaces the user's entire permission set AND center access in one call — matches
// the Permissions panel's "one Save, full desired state" contract, not incremental
// grant/revoke calls. An empty centerAccess means unscoped, same convention as the
// fetch above.
export function saveUserPermissions(
  id: number,
  grants: PermissionGrant[],
  centerAccess: string[]
): Promise<{ grants: PermissionGrant[]; centerAccess: string[] }> {
  return request(`/api/admin/users/${id}/permissions`, {
    method: "PUT",
    body: JSON.stringify({ grants, centerAccess })
  });
}
