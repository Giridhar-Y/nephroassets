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
  /** Opening Gross Block, as at FY Start — live-classified from dateAcquired/
   *  dateOfAddition against the *current* FY Start, not the raw stored
   *  c1/c2OpeningCost field. See engine.ts's `splitTranche` for why. */
  openingGrossBlock: number;
  /** Additions Gross Block "during FY" — the complement of `openingGrossBlock`: a
   *  cost tranche dated on/after FY Start (and on/before this view's effective end
   *  date). Also live-classified, not the raw stored additionsC1/C2 field. */
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
  /** Latest of Date Acquired, Date of Addition, every Transfer date, and Date of
   *  Disposal — whichever of those events actually apply on or before AS_AT. Distinct
   *  from `AssetInput.lastDateOfTransaction` (a stored column touched only by Transfer
   *  routes) — this is the fuller definition the Register/Export screens display. */
  lastDateOfTransaction: IsoDate;
  /** Profit/(Loss) on Disposal for the asset as a whole = saleValue − (c1.wdvAtDisposal +
   *  c2.wdvAtDisposal), saleValue counted once against the combined WDV — matching the
   *  reference workbook's Methodology sheet ("Profit/(Loss) = Sale Value − Total WDV at
   *  Disposal") and its AI6 formula. Deliberately named differently from
   *  `ComponentResult.profitLossOnDisposal`: each per-component field independently
   *  subtracts the *full* saleValue (there's no per-component sale price to split), so
   *  summing c1's and c2's double-counts saleValue — the exact bug this field exists to
   *  prevent a repeat of. Consumers that want the asset's total Profit/(Loss) must use
   *  this field, never `c1.profitLossOnDisposal + c2.profitLossOnDisposal`. */
  assetProfitLossOnDisposal: number | null;
}
