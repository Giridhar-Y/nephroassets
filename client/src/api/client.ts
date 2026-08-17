import type { AssetFilters, AssetListResponse, FySettings } from "../lib/types.js";

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

export function createTransfer(payload: {
  farIds: string[];
  toLocation: string;
  transactionDate: string;
}): Promise<{ transferred: number }> {
  return request("/api/transfers", { method: "POST", body: JSON.stringify(payload) });
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
