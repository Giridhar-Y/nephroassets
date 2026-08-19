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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
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

export function fetchStatuses(): Promise<string[]> {
  return request<string[]>("/api/meta/statuses");
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

export interface TransferHistoryItem {
  id: number;
  farId: string;
  assetDescription: string;
  transactionDate: string;
  location: string;
}

export interface TransferHistoryResponse {
  items: TransferHistoryItem[];
  nextCursor: number | null;
}

export interface TransferHistoryFilters {
  search?: string;
  descriptionSearch?: string;
  location?: string;
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
  errors: BulkUploadError[];
}

// Bypasses the `request` helper: it always sets Content-Type: application/json, but a
// multipart upload needs the browser to set its own Content-Type with the form boundary.
async function uploadFile(path: string, file: File): Promise<BulkUploadResult> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(path, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
  }
  return res.json() as Promise<BulkUploadResult>;
}

// Bulk Upload's three modes: create/update assets (capitalization included — a new FAR
// ID capitalizes, an existing one updates), full disposals, and center transfers.
export function uploadBulkAssets(file: File): Promise<BulkUploadResult> {
  return uploadFile("/api/assets/bulk-upload", file);
}

export function uploadBulkDisposals(file: File): Promise<BulkUploadResult> {
  return uploadFile("/api/assets/bulk-dispose", file);
}

export function uploadBulkTransfers(file: File): Promise<BulkUploadResult> {
  return uploadFile("/api/transfers/bulk-upload", file);
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
  component: "C1" | "C2";
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
}

export function fetchAuditReconciliation(asAt: string): Promise<{ asAt: string; items: ReconciliationItem[] }> {
  return request(`/api/reports/audit-reconciliation?${new URLSearchParams({ asAt })}`);
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
