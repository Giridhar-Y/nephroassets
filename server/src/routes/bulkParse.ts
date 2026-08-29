import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { z } from "zod";
import type pg from "pg";

// Cells come back from ExcelJS as plain values, Dates, or rich objects (formula results,
// hyperlinks, rich text runs) depending on the source file — normalize all of them to the
// plain strings the shared zod schemas expect. A real Date-typed cell always becomes ISO
// here (see bulkDate below for why that's fine alongside user-typed DD-MM-YYYY text).
export function toCellString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: ExcelJS.CellValue; richText?: Array<{ text: string }> };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.result !== undefined) return toCellString(v.result);
    if (v.text !== undefined) return String(v.text);
    return "";
  }
  return String(value).trim();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DDMMYYYY_RE = /^(0[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2])-\d{4}$/;

function ddmmyyyyToIso(value: string): string {
  const [d, m, y] = value.split("-");
  return `${y}-${m}-${d}`;
}

// Reverse of ddmmyyyyToIso above — for rendering an ISO date back into an error message
// in the app's day-first display convention. A plain string rearrangement, no Date
// object and no timezone risk.
export function isoToDDMMYYYY(value: string): string {
  const [y, m, d] = value.split("-");
  return `${d}-${m}-${y}`;
}

// Bulk upload's date columns are DD-MM-YYYY, matching the rest of the app's day-first
// display convention — parsed positionally (day, then month) rather than via `Date` or
// any locale-dependent parsing, so "01-02-2026" always means 1 February, never 2 January.
// A genuine ISO string is also accepted as-is: ExcelJS hands back real Date-typed .xlsx
// cells already normalized to ISO (see toCellString above), and that value is unambiguous
// since it came from Excel's internal date, not user-typed text.
export const bulkDate = z.string().transform((v, ctx) => {
  if (ISO_DATE_RE.test(v)) return v;
  if (DDMMYYYY_RE.test(v)) return ddmmyyyyToIso(v);
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid date '${v}' — expected DD-MM-YYYY.` });
  return z.NEVER;
});

// Masters bulk upload's `active` column: accepts true/false or Active/Inactive
// (case-insensitive), matching the badge labels shown in the Masters screen itself.
export const bulkActive = z
  .string()
  .transform((v, ctx) => {
    const s = v.trim().toLowerCase();
    if (["true", "active", "1", "yes"].includes(s)) return true;
    if (["false", "inactive", "0", "no"].includes(s)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid value '${v}' — expected true/false or Active/Inactive.` });
    return z.NEVER;
  })
  .optional();

export async function loadWorksheet(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith(".csv")) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    // exceljs's default CSV reader guesses numbers *and* dates per-cell (via dayjs,
    // including a bare "MM-DD-YYYY" format) before our own schemas ever see the text —
    // "01-08-2026" silently became 8 Jan instead of the intended 1 Aug. Turning that off
    // and handing back every cell as a plain string makes our zod schemas (z.coerce.number,
    // bulkDate) the only thing that ever interprets a cell's contents.
    return workbook.csv.read(stream, { map: (datum: string) => (datum === "" ? null : datum) });
  }
  // exceljs's own .d.ts globally redeclares a non-generic `Buffer extends ArrayBuffer`,
  // which collides with @types/node's generic Buffer and makes this call fail
  // type-checking even though it's correct at runtime (verified against real files below).
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The file has no worksheet.");
  return worksheet;
}

export interface RowError {
  row: number;
  farId: string | null;
  message: string;
}

/** Reads the header row, then validates every data row against `schema`. Keeps the
 *  original spreadsheet row number alongside each valid row so a later DB-level failure
 *  (not found, already disposed, ...) can still be reported against the right row. */
export function parseWorksheetRows<S extends z.ZodTypeAny>(
  worksheet: ExcelJS.Worksheet,
  schema: S
): { validRows: Array<{ row: number; data: z.infer<S> }>; errors: RowError[] } {
  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = toCellString(cell.value);
  });
  if (headers.filter(Boolean).length === 0) {
    throw new Error("The file has no header row.");
  }

  const errors: RowError[] = [];
  const validRows: Array<{ row: number; data: z.infer<S> }> = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) return;
      const text = toCellString(cell.value);
      if (text !== "") record[header] = text;
    });
    if (Object.keys(record).length === 0) return; // fully blank row

    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      const farId = typeof record.farId === "string" ? record.farId : null;
      errors.push({
        row: rowNumber,
        farId,
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      });
      return;
    }
    validRows.push({ row: rowNumber, data: parsed.data });
  });

  return { validRows, errors };
}

export interface BulkPreviewRow {
  row: number;
  farId: string | null;
  status: "new" | "update" | "error";
  message?: string;
}

export interface BulkPreviewResult {
  totalRows: number;
  summary: { new: number; update: number; error: number };
  rows: BulkPreviewRow[];
}

/** Preview mode never writes to the DB — routes classify each schema-valid row as
 *  "new"/"update" (or push it into `errors` for a DB-level problem like an unknown FAR
 *  ID), and this merges that with the schema errors from parseWorksheetRows into one
 *  row-ordered list, so the UI can show every row's fate before Confirm Upload commits. */
export function mergePreviewRows(
  classified: Array<{ row: number; farId: string; status: "new" | "update"; message?: string }>,
  errors: RowError[]
): BulkPreviewResult {
  const rows: BulkPreviewRow[] = [
    ...classified,
    ...errors.map((e) => ({ row: e.row, farId: e.farId, status: "error" as const, message: e.message }))
  ].sort((a, b) => a.row - b.row);
  const summary = {
    new: rows.filter((r) => r.status === "new").length,
    update: rows.filter((r) => r.status === "update").length,
    error: rows.filter((r) => r.status === "error").length
  };
  return { totalRows: rows.length, summary, rows };
}

export interface MasterLookupMaps {
  /** lowercased value -> canonical (master list) casing, active entries only. */
  centers: Map<string, string>;
  subClassifications: Map<string, string>;
  statuses: Map<string, string>;
  /** canonical Sub Classification name -> has_component2 — lets any route that already
   *  resolved a canonical Sub Classification (via lookupCanonical) also check whether it
   *  allows Component 2, without a second query. See routes/componentTwoGuard.ts. */
  subClassificationHasComponent2: Map<string, boolean>;
}

/** Loaded fresh per request (not cached) — the whole point is that Masters (routes/
 *  masters.ts) can add/rename/deactivate entries and have every bulk upload immediately
 *  see the change, not a stale snapshot. Used by every bulk route that accepts a
 *  spreadsheet column for Center/Sub Classification/Status, so a value that doesn't match
 *  an active master entry is rejected instead of silently accepted as free text. */
export async function loadActiveMasterMaps(db: pg.Pool): Promise<MasterLookupMaps> {
  const [centers, subClasses, statuses] = await Promise.all([
    db.query<{ code: string }>(`SELECT code FROM centers WHERE active = TRUE`),
    db.query<{ name: string; has_component2: boolean }>(`SELECT name, has_component2 FROM sub_classifications WHERE active = TRUE`),
    db.query<{ name: string }>(`SELECT name FROM statuses WHERE active = TRUE`)
  ]);
  return {
    centers: new Map(centers.rows.map((r) => [r.code.toLowerCase(), r.code])),
    subClassifications: new Map(subClasses.rows.map((r) => [r.name.toLowerCase(), r.name])),
    statuses: new Map(statuses.rows.map((r) => [r.name.toLowerCase(), r.name])),
    subClassificationHasComponent2: new Map(subClasses.rows.map((r) => [r.name, r.has_component2]))
  };
}

/** Case-insensitive lookup, returning the master list's own canonical casing (not
 *  whatever casing the row happened to use) — undefined means no active entry matches. */
export function lookupCanonical(map: Map<string, string>, value: string): string | undefined {
  return map.get(value.toLowerCase());
}
