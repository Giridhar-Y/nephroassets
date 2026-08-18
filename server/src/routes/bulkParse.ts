import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import type { z } from "zod";

// Cells come back from ExcelJS as plain values, Dates, or rich objects (formula results,
// hyperlinks, rich text runs) depending on the source file — normalize all of them to the
// plain strings the shared zod schemas (and their ISO-date regexes) expect.
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

export async function loadWorksheet(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith(".csv")) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return workbook.csv.read(stream);
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
