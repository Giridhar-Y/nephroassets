import type { AssetInput, FySettings, TransferRecord } from "../calc/types.js";

export interface AssetRow {
  far_id: string;
  sub_classification: string;
  asset_description: string;
  serial_no: string | null;
  qty: string | number;
  status: string;
  date_acquired: string;
  location: string;
  revised_location: string | null;
  last_date_of_transaction: string | null;
  useful_life_c1_years: string | number;
  useful_life_c2_years: string | number;
  c1_opening_cost: string | number;
  c2_opening_cost: string | number;
  additions_c1: string | number;
  additions_c2: string | number;
  date_of_addition: string | null;
  date_of_disposal: string | null;
  deletions_c1: string | number;
  deletions_c2: string | number;
  sale_value: string | number;
  acc_dep_c1_opening: string | number;
  acc_dep_c2_opening: string | number;
}

export interface TransferRow {
  far_id: string;
  transaction_date: string;
  location: string;
}

export interface SettingsRow {
  as_at: string;
  fy_start: string;
  fy_end: string;
  days_in_fy: number;
}

export function mapAssetRow(row: AssetRow): AssetInput {
  return {
    farId: row.far_id,
    subClassification: row.sub_classification,
    assetDescription: row.asset_description,
    serialNo: row.serial_no ?? "",
    qty: Number(row.qty),
    status: row.status,
    dateAcquired: row.date_acquired,
    location: row.location,
    revisedLocation: row.revised_location,
    lastDateOfTransaction: row.last_date_of_transaction,
    usefulLifeC1Years: Number(row.useful_life_c1_years),
    usefulLifeC2Years: Number(row.useful_life_c2_years),
    c1OpeningCost: Number(row.c1_opening_cost),
    c2OpeningCost: Number(row.c2_opening_cost),
    additionsC1: Number(row.additions_c1),
    additionsC2: Number(row.additions_c2),
    dateOfAddition: row.date_of_addition,
    dateOfDisposal: row.date_of_disposal,
    deletionsC1: Number(row.deletions_c1),
    deletionsC2: Number(row.deletions_c2),
    saleValue: Number(row.sale_value),
    accDepC1Opening: Number(row.acc_dep_c1_opening),
    accDepC2Opening: Number(row.acc_dep_c2_opening)
  };
}

export function mapTransferRow(row: TransferRow): TransferRecord {
  return { farId: row.far_id, transactionDate: row.transaction_date, location: row.location };
}

export function mapSettingsRow(row: SettingsRow): FySettings {
  return { asAt: row.as_at, fyStart: row.fy_start, fyEnd: row.fy_end, daysInFy: row.days_in_fy };
}
