import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { z } from "zod";

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
  classified: Array<{ row: number; farId: string; status: "new" | "update" }>,
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
