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
  parentFarId: string | null;
  disposedViaParentFarId: string | null;
  hasChildren: boolean;
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
  openingGrossBlock: number;
  additionsGrossBlock: number;
  openingNbv: number;
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
  lastDateOfTransaction: string;
  /** Asset-level Profit/(Loss) on Disposal — saleValue counted once against the combined
   *  c1+c2 WDV. NOT the same as c1.profitLossOnDisposal + c2.profitLossOnDisposal, which
   *  double-counts saleValue (each per-component field independently subtracts the full
   *  saleValue). Always use this field for the asset's total Profit/(Loss). */
  assetProfitLossOnDisposal: number | null;
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

export interface AssetCreateInput {
  farId: string;
  subClassification: string;
  assetDescription: string;
  serialNo?: string;
  qty?: number;
  status: string;
  dateAcquired: string;
  location: string;
  usefulLifeC1Years: number;
  usefulLifeC2Years: number;
  c1OpeningCost?: number;
  c2OpeningCost?: number;
  additionsC1?: number;
  additionsC2?: number;
  dateOfAddition?: string | null;
  accDepC1Opening?: number;
  accDepC2Opening?: number;
  /** Links the new asset as a child of an existing one at creation time — see the
   *  server's capitalizationParentSchema. Omitted means standalone, same as before. */
  parentFarId?: string;
}

export interface AssetFilters {
  center?: string[];
  capLocation?: string[];
  subClassification?: string[];
  status?: string[];
  dateAcquiredFrom?: string;
  dateAcquiredTo?: string;
  hasAddition?: boolean;
  search?: string;
  descriptionSearch?: string;
  globalSearch?: string;
  /** Excel-style per-column custom filter conditions — see columnFilters.ts. Additive to
   *  every field above (AND'd in), not a replacement — Register uses this for every
   *  column beyond the handful the named fields above already cover. */
  conditions?: import("./columnFilters.js").ColumnCondition[];
}
