import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Shared with the Capitalization form (new-asset creation) and bulk upload's row
// validation, so both paths agree on what a valid asset looks like.
export const assetCreateSchema = z.object({
  farId: z.string().min(1),
  subClassification: z.string().min(1),
  assetDescription: z.string().min(1),
  serialNo: z.string().optional().default(""),
  qty: z.coerce.number().positive().default(1),
  status: z.string().min(1),
  dateAcquired: isoDate,
  location: z.string().min(1),
  usefulLifeC1Years: z.coerce.number().min(0),
  usefulLifeC2Years: z.coerce.number().min(0),
  c1OpeningCost: z.coerce.number().min(0).default(0),
  c2OpeningCost: z.coerce.number().min(0).default(0),
  additionsC1: z.coerce.number().min(0).default(0),
  additionsC2: z.coerce.number().min(0).default(0),
  dateOfAddition: isoDate.optional().nullable().default(null),
  accDepC1Opening: z.coerce.number().min(0).default(0),
  accDepC2Opening: z.coerce.number().min(0).default(0)
});

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;

export const ASSET_INSERT_COLUMNS = [
  "far_id",
  "sub_classification",
  "asset_description",
  "serial_no",
  "qty",
  "status",
  "date_acquired",
  "location",
  "useful_life_c1_years",
  "useful_life_c2_years",
  "c1_opening_cost",
  "c2_opening_cost",
  "additions_c1",
  "additions_c2",
  "date_of_addition",
  "acc_dep_c1_opening",
  "acc_dep_c2_opening"
] as const;

export function assetCreateValues(input: AssetCreateInput): unknown[] {
  return [
    input.farId,
    input.subClassification,
    input.assetDescription,
    input.serialNo,
    input.qty,
    input.status,
    input.dateAcquired,
    input.location,
    input.usefulLifeC1Years,
    input.usefulLifeC2Years,
    input.c1OpeningCost,
    input.c2OpeningCost,
    input.additionsC1,
    input.additionsC2,
    input.dateOfAddition,
    input.accDepC1Opening,
    input.accDepC2Opening
  ];
}

// Bulk upload rows may additionally carry a disposal already on record (real spreadsheets
// commonly include historical disposed assets), which the Capitalization form never sends.
export const bulkAssetRowSchema = assetCreateSchema.extend({
  dateOfDisposal: isoDate.optional().nullable().default(null),
  deletionsC1: z.coerce.number().min(0).default(0),
  deletionsC2: z.coerce.number().min(0).default(0),
  saleValue: z.coerce.number().min(0).default(0)
});

export type BulkAssetRowInput = z.infer<typeof bulkAssetRowSchema>;

export const ASSET_UPSERT_COLUMNS = [
  ...ASSET_INSERT_COLUMNS,
  "date_of_disposal",
  "deletions_c1",
  "deletions_c2",
  "sale_value"
] as const;

export function bulkAssetRowValues(input: BulkAssetRowInput): unknown[] {
  return [
    ...assetCreateValues(input),
    input.dateOfDisposal,
    input.deletionsC1,
    input.deletionsC2,
    input.saleValue
  ];
}
