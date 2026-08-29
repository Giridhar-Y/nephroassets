import { z } from "zod";
import { bulkDate, isoToDDMMYYYY } from "./bulkParse.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Real FAR IDs come in whatever format the source organization already uses — no
// enforced character set. Only non-empty is required; uniqueness is checked separately
// (a DB lookup in assets.ts/bulkUpload.ts), not by this schema.
export const farId = z.string().min(1, "FAR ID is required.");

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

// The engine's NBV math (openingNbv = openingGrossBlock - accDepOpening, and the
// end-of-life taper's taperNbv = openingCost + additions - accDepOpening) assumes an
// asset's opening accumulated depreciation never exceeds what it actually cost —
// otherwise NBV implies a value the accounting model has no meaning for. Real gap found
// via a leftover dev asset that had zero opening cost but nonzero opening accumulated
// depreciation on both components, which neither this schema nor Edit (routes/assets.ts,
// its own copy of this same check against a fetched rather than submitted cost) blocked.
// Shared by both schemas below.
function checkAccDepWithinCost(
  data: { c1OpeningCost: number; c2OpeningCost: number; accDepC1Opening: number; accDepC2Opening: number },
  ctx: z.RefinementCtx
) {
  if (data.accDepC1Opening > data.c1OpeningCost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accDepC1Opening"],
      message: `Component 1 Opening Acc. Dep. (${data.accDepC1Opening}) cannot exceed Component 1 Opening Cost (${data.c1OpeningCost}).`
    });
  }
  if (data.accDepC2Opening > data.c2OpeningCost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accDepC2Opening"],
      message: `Component 2 Opening Acc. Dep. (${data.accDepC2Opening}) cannot exceed Component 2 Opening Cost (${data.c2OpeningCost}).`
    });
  }
}

// Shared with the Capitalization form (new-asset creation) and bulk upload's row
// validation, so both paths agree on what a valid asset looks like.
const assetCreateShape = z.object({
  farId,
  subClassification: z.string().min(1),
  assetDescription: z.string().min(1),
  serialNo: z.string().optional().default(""),
  qty: z.coerce.number().positive().default(1),
  status: z.string().min(1),
  dateAcquired: isoDate,
  location: z.string().min(1),
  // Deliberately no .int() — a fractional useful life (e.g. a 2.5-year license or lease
  // term) is a real, supported case; the calc engine's end-of-life taper handles
  // fractional years correctly (see engine.ts's eol/remLife comment). 0 is also
  // deliberately allowed: it means "not depreciated" (hasUsefulLife gate in engine.ts),
  // a real case for e.g. land.
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

export const assetCreateSchema = assetCreateShape.superRefine((data, ctx) => {
  checkAdditionsPairing(data, ctx);
  checkAccDepWithinCost(data, ctx);
});

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
    checkAccDepWithinCost(data, ctx);
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
    // Same reasoning against the addition date: a row can't record an addition dated
    // after the asset was already disposed. engine.ts already gates an addition dated
    // after the effective end date out of Gross Block/depreciation entirely (treats it
    // as "hasn't happened yet"), so this wouldn't corrupt figures — but it's confusing,
    // silently-dropped data rather than a rejected one, so reject it here instead.
    if (hasDisposalDate && data.dateOfAddition !== null && data.dateOfDisposal! < data.dateOfAddition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfDisposal"],
        message: `Disposal date cannot be before the addition date (${isoToDDMMYYYY(data.dateOfAddition)}).`
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
