// ISO date strings, format "YYYY-MM-DD".
export type IsoDate = string;

export interface FySettings {
  asAt: IsoDate;
  fyStart: IsoDate;
  fyEnd: IsoDate;
  daysInFy: number;
}

export interface AssetInput {
  farId: string;
  subClassification: string;
  assetDescription: string;
  serialNo: string;
  qty: number;
  status: string;
  dateAcquired: IsoDate;
  location: string;
  revisedLocation: string | null;
  lastDateOfTransaction: IsoDate | null;

  usefulLifeC1Years: number;
  usefulLifeC2Years: number;

  c1OpeningCost: number;
  c2OpeningCost: number;
  additionsC1: number;
  additionsC2: number;
  dateOfAddition: IsoDate | null;

  dateOfDisposal: IsoDate | null;
  deletionsC1: number;
  deletionsC2: number;
  saleValue: number;

  accDepC1Opening: number;
  accDepC2Opening: number;
}

export interface TransferRecord {
  farId: string;
  transactionDate: IsoDate;
  location: string;
}

export interface ComponentResult {
  effectiveEndDate: IsoDate;
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
