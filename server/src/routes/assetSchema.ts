import { z } from "zod";
import { bulkDate, isoToDDMMYYYY } from "./bulkParse.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// The calc engine (engine.ts) only ever looks at dateOfAddition — not whether additions
// are non-zero — to decide if an addition depreciates at all. A row with an addition
// amount but no date silently costs Gross Block without ever charging depreciation on it,
// forever; a date with no amount is just dead data. Shared by both schemas below since
// both the Capitalization form and bulk upload can set these fields.
function checkAdditionsPairing(
  data: { additionsC1: number; additionsC2: number; dateOfAddition: string | null },
  ctx: z.RefinementCtx
) {
  const hasAdditions = data.additionsC1 !== 0 || data.additionsC2 !== 0;
  if (hasAdditions && data.dateOfAddition === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dateOfAddition"],
      message: "dateOfAddition is required when additionsC1 or additionsC2 is non-zero."
    });
  } else if (!hasAdditions && data.dateOfAddition !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dateOfAddition"],
      message: "dateOfAddition is set but additionsC1 and additionsC2 are both zero."
    });
  }
}

// Shared with the Capitalization form (new-asset creation) and bulk upload's row
// validation, so both paths agree on what a valid asset looks like.
const assetCreateShape = z.object({
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

export const assetCreateSchema = assetCreateShape.superRefine(checkAdditionsPairing);

export type AssetCreateInput = z.infer<typeof assetCreateShape>;

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
// Its date columns are DD-MM-YYYY (see bulkDate in bulkParse.ts) rather than the ISO
// `isoDate` above, which stays tied to the Capitalization form's native <input
// type="date"> — the two paths intentionally use different date schemas.
export const bulkAssetRowSchema = assetCreateShape
  .extend({
    dateAcquired: bulkDate,
    dateOfAddition: bulkDate.optional().nullable().default(null),
    dateOfDisposal: bulkDate.optional().nullable().default(null),
    deletionsC1: z.coerce.number().min(0).default(0),
    deletionsC2: z.coerce.number().min(0).default(0),
    saleValue: z.coerce.number().min(0).default(0)
  })
  .superRefine((data, ctx) => {
    checkAdditionsPairing(data, ctx);
    // Same reasoning as checkAdditionsPairing: the calc engine (engine.ts) treats an
    // asset as disposed purely based on dateOfDisposal, but the Disposals screen and the
    // Register's Status filter both key off `status`. The single/bulk disposal endpoints
    // always set both together — bulk-uploading assets is the one path that can set them
    // independently, so it's the one path that needs to reject the mismatch explicitly.
    const isDisposedStatus = data.status === "Disposed";
    const hasDisposalDate = data.dateOfDisposal !== null;
    if (hasDisposalDate && !isDisposedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `dateOfDisposal is set but status is "${data.status}", not "Disposed".`
      });
    } else if (isDisposedStatus && !hasDisposalDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfDisposal"],
        message: `status is "Disposed" but dateOfDisposal is not set.`
      });
    }
    // An asset can't have been written off before it existed on the books. The
    // Capitalization form never sends dateOfDisposal (a new asset is never created
    // pre-disposed), so this only applies to bulk-uploaded rows carrying a historical
    // disposal already on record.
    if (hasDisposalDate && data.dateOfDisposal! < data.dateAcquired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfDisposal"],
        message: `Disposal date cannot be before the capitalization date (${isoToDDMMYYYY(data.dateAcquired)}).`
      });
    }
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
