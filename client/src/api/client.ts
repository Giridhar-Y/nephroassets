import type {
  AssetCalculationResult,
  AssetCreateInput,
  AssetFilters,
  AssetInput,
  AssetListResponse,
  FySettings
} from "../lib/types.js";

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

export function fetchCenters(): Promise<string[]> {
  return request<string[]>("/api/meta/centers");
}

export function fetchSubClassifications(): Promise<string[]> {
  return request<string[]>("/api/meta/sub-classifications");
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
}

export function fetchAssets(params: FetchAssetsParams): Promise<AssetListResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  return request<AssetListResponse>(`/api/assets?${search.toString()}`);
}

export interface AssetDetailTransfer {
  id: number;
  transactionDate: string;
  location: string;
}

export interface AssetDetailResponse {
  asset: AssetInput;
  result: AssetCalculationResult;
  transfers: AssetDetailTransfer[];
  asAt: string;
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
}): Promise<{ transferred: number }> {
  return request("/api/transfers", { method: "POST", body: JSON.stringify(payload) });
}

// Register's "Export to Excel": builds the download URL for the current filters (no
// filters applied exports the entire register). Not a fetch — the browser downloads it
// directly via the Content-Disposition header, same as any other file download link.
export function getExportUrl(params: { asAt: string } & AssetFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  return `/api/assets/export?${search.toString()}`;
}

// Capitalization: register a brand-new asset.
export function createAsset(payload: AssetCreateInput): Promise<{ farId: string; created: boolean }> {
  return request("/api/assets", { method: "POST", body: JSON.stringify(payload) });
}

export interface AssetEditInput {
  serialNo: string;
  usefulLifeC1Years: number;
  usefulLifeC2Years: number;
  accDepC1Opening: number;
  accDepC2Opening: number;
}

// Edit: modify an already-capitalized asset's non-historical particulars. Deliberately
// a short field list — see the server's editAssetSchema for why FAR ID/Date Acquired/
// cost/additions fields aren't included.
export function updateAsset(farId: string, payload: AssetEditInput): Promise<{ farId: string; updated: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}`, { method: "PATCH", body: JSON.stringify(payload) });
}

// Disposal: full disposal only — the server writes off the asset's entire capitalized cost.
export function disposeAsset(
  farId: string,
  payload: { dateOfDisposal: string; saleValue: number }
): Promise<{ farId: string; disposed: boolean }> {
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
  payload: { additionsC1: number; additionsC2: number; dateOfAddition: string }
): Promise<{ farId: string; added: boolean }> {
  return request(`/api/assets/${encodeURIComponent(farId)}/addition`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
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
}

export function fetchTransferHistory(
  params: TransferHistoryFilters & { cursor?: number | null; limit?: number }
): Promise<TransferHistoryResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
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

// Bulk Upload's three modes: create/update assets (capitalization included — a new FAR
// ID capitalizes, an existing one updates), full disposals, and center transfers. Each
// has a matching `?preview=true` mode on the same route that classifies rows without
// writing anything, so Confirm Upload (the plain call below) is guaranteed to match what
// the preview showed — it's the same server-side validation, just re-run.
export const BULK_UPLOAD_PATHS = {
  assets: "/api/assets/bulk-upload",
  disposals: "/api/assets/bulk-dispose",
  transfers: "/api/transfers/bulk-upload"
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

export interface LocationSummary {
  location: string;
  asAt: string;
  assetCount: number;
  totalC1GrossBlock: number;
}

export function fetchLocationSummary(location: string, asAt: string): Promise<LocationSummary> {
  return request(`/api/reports/location-summary?${new URLSearchParams({ location, asAt })}`);
}

export interface ReconciliationItem {
  subClassification: string;
  component: "C1" | "C2" | "Combined";
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
  depCheckPass: boolean;
  depCheckDelta: number;
  depCheckMessage: string;
  nbvOpeningSum: number;
  nbvClosingSum: number;
  nbvCheckPass: boolean;
  nbvCheckDelta: number;
  nbvCheckMessage: string;
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
): Promise<{ asAt: string; fyStart: string; items: ReconciliationItem[] }> {
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
}): Promise<MasterSubClassification> {
  return request("/api/masters/sub-classifications", { method: "POST", body: JSON.stringify(payload) });
}

export function updateMasterSubClassification(
  id: number,
  payload: Partial<{
    name: string;
    defaultUsefulLifeC1Years: number | null;
    defaultUsefulLifeC2Years: number | null;
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

// --- Auth ------------------------------------------------------------------------

/** viewer: read/export only. editor: viewer's access + full FAR-module CRUD
 *  (Capitalization/Transfers/Disposals/Bulk Upload). admin: also user management. */
export type Role = "viewer" | "editor" | "admin";

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
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
