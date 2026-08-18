import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { ASSET_UPSERT_COLUMNS, bulkAssetRowSchema, bulkAssetRowValues } from "./assetSchema.js";

// Cells come back from ExcelJS as plain values, Dates, or rich objects (formula results,
// hyperlinks, rich text runs) depending on the source file — normalize all of them to the
// plain strings the shared zod schema (and its ISO-date regex) expects.
function toCellString(value: ExcelJS.CellValue): string {
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

async function loadWorksheet(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
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

export default async function bulkUploadRoutes(app: FastifyInstance) {
  // Bulk Uploads: parse a CSV/XLSX of assets (columns named after the shared AssetInput
  // fields, e.g. farId, subClassification, c1OpeningCost…), validate every row, and
  // upsert by FAR ID so the same file can both import new assets and correct existing
  // ones. Rows that fail validation are reported but don't block the valid rows.
  app.post("/api/assets/bulk-upload", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: "No file was uploaded." };
    }

    const buffer = await file.toBuffer();
    let worksheet: ExcelJS.Worksheet;
    try {
      worksheet = await loadWorksheet(buffer, file.filename);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    const headers: string[] = [];
    worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber] = toCellString(cell.value);
    });
    if (headers.filter(Boolean).length === 0) {
      reply.code(400);
      return { error: "The file has no header row." };
    }

    const errors: Array<{ row: number; farId: string | null; message: string }> = [];
    const validRows: Array<ReturnType<typeof bulkAssetRowSchema.parse>> = [];

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

      const parsed = bulkAssetRowSchema.safeParse(record);
      if (!parsed.success) {
        const farId = typeof record.farId === "string" ? record.farId : null;
        errors.push({
          row: rowNumber,
          farId,
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        });
        return;
      }
      validRows.push(parsed.data);
    });

    let upserted = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      const client = await db.connect();
      const updateAssignments = ASSET_UPSERT_COLUMNS.filter((c) => c !== "far_id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      try {
        await client.query("BEGIN");
        for (const row of validRows) {
          await client.query(
            `INSERT INTO assets (${ASSET_UPSERT_COLUMNS.join(", ")})
             VALUES (${ASSET_UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (far_id) DO UPDATE SET ${updateAssignments}`,
            bulkAssetRowValues(row)
          );
          upserted++;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    return { totalRows: validRows.length + errors.length, upserted, errors };
  });
}
