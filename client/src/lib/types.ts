// Mirrors the JSON shapes returned by the server's calc engine (server/src/calc/types.ts).

export interface AssetInput {
  farId: string;
  subClassification: string;
  assetDescription: string;
  serialNo: string;
  qty: number;
  status: string;
  dateAcquired: string;
  location: string;
  revisedLocation: string | null;
  lastDateOfTransaction: string | null;
  usefulLifeC1Years: number;
  usefulLifeC2Years: number;
  c1OpeningCost: number;
  c2OpeningCost: number;
  additionsC1: number;
  additionsC2: number;
  dateOfAddition: string | null;
  dateOfDisposal: string | null;
  deletionsC1: number;
  deletionsC2: number;
  saleValue: number;
  accDepC1Opening: number;
  accDepC2Opening: number;
}

export interface ComponentResult {
  effectiveEndDate: string;
  disposalEffective: boolean;
  daysHeldOpening: number;
  daysHeldAddition: number;
  depOnOpening: number;
  depOnAdditions: number;
  periodDepreciation: number;
  grossBlock: number;
  disposedRatio: number;
  depOnDisposedPortion: number;
  accDepOnDisposed: number;
  closingAccDep: number;
  nbv: number;
  wdvAtDisposal: number | null;
  profitLossOnDisposal: number | null;
}

export interface AssetCalculationResult {
  farId: string;
  c1: ComponentResult;
  c2: ComponentResult;
  effectiveLocation: string;
}

export interface AssetListItem {
  asset: AssetInput;
  result: AssetCalculationResult;
}

export interface FySettings {
  asAt: string;
  fyStart: string;
  fyEnd: string;
  daysInFy: number;
}

export interface AssetListResponse {
  items: AssetListItem[];
  nextCursor: string | null;
  asAt: string;
}

export interface AssetFilters {
  center?: string;
  subClassification?: string;
  status?: string;
  dateAcquiredFrom?: string;
  dateAcquiredTo?: string;
  search?: string;
}
