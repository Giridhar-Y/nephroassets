// Client-side chunking for Assets Bulk Upload, needed once a file is too big for one
// request: Vercel's Node serverless functions enforce a hard, non-configurable ~4.5MB
// request body limit (no config anywhere raises it) — a real historical-import file
// (hundreds of thousands of rows) blows past that by a wide margin. The fix here is
// pure text-line splitting of the ORIGINAL file's bytes, not a parse-then-reformat
// round trip through a library — every row's raw text is passed through into its chunk
// completely unchanged, so there's zero risk of a chunked upload behaving differently
// from today's single-request one for the exact same file. That's also why this only
// supports CSV: an XLSX file is a binary zip container, not line-splittable this way,
// and reformatting it through a parse/re-serialize library to chunk it would reopen
// exactly the drift risk this design avoids — a large XLSX file is asked to be re-saved
// as CSV instead (Bulk Upload's own "Download Template" already produces CSV).

// Below this size, the existing single-request upload (previewBulkUpload/
// commitBulkUpload in api/client.ts) is used completely unchanged — chunking only
// kicks in for a file that would actually risk the ~4.5MB platform ceiling.
export const CHUNK_THRESHOLD_BYTES = 3 * 1024 * 1024; // 3MB
// Rows per chunk request. Conservative for a ~21-column Assets row (see
// server/src/routes/assetSchema.ts's BULK_ASSET_ROW_COLUMNS): even long descriptions/
// serial numbers keep a chunk well under both this app's own 20MB @fastify/multipart
// limit and Vercel's ~4.5MB one.
export const CHUNK_ROWS = 2000;

/** Splits raw CSV text into logical lines — respecting RFC4180-style quoted fields that
 *  may themselves contain a literal newline or comma, so a quoted multi-line cell isn't
 *  mistaken for a row boundary. Returns each line's raw text verbatim (quotes and all),
 *  not parsed into fields — chunking only needs to know where rows START and END, never
 *  what's inside them. Handles both \n and \r\n line endings; a trailing blank line (a
 *  file ending in a newline) is dropped, matching how a spreadsheet-authored CSV usually
 *  ends without becoming a spurious empty row. */
export function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "\r" && !inQuotes) {
      // Swallow \r; the following \n (if any) ends the line below. A lone \r (old
      // Mac-style line ending) also ends the line here.
      if (text[i + 1] !== "\n") {
        lines.push(current);
        current = "";
      }
    } else if (ch === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Splits one CSV line into its fields, unescaping doubled quotes inside a quoted
 *  field ("" -> ") — only ever used to read the farId column for the whole-file
 *  duplicate check below; row content is otherwise never parsed or reassembled field
 *  by field, only passed through as whole lines (see splitCsvLines's own comment). */
export function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export interface ParsedCsv {
  header: string[];
  /** One entry per data row (header excluded), in file order — raw line text. */
  dataLines: string[];
}

export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  const text = await file.text();
  const lines = splitCsvLines(text).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("The file has no header row.");
  const header = splitCsvFields(lines[0]!).map((h) => h.trim());
  return { header, dataLines: lines.slice(1) };
}

export interface DuplicateFarIdError {
  /** 1-based, matching the server's own row numbering (header = row 1, first data row =
   *  row 2), so it can be merged directly into an aggregated preview/result alongside
   *  server-reported row errors. */
  row: number;
  farId: string;
  message: string;
}

/** Same rule and message wording as bulkUpload.ts's own rejectDuplicateFarIds (case-
 *  insensitive, second-and-later occurrence flagged) — done once up front, across the
 *  WHOLE file, specifically because chunking would otherwise let a duplicate spanning
 *  two different chunks slip past (each chunk is validated independently server-side,
 *  so a dup split across a chunk boundary would silently upsert-over instead of erroring
 *  — the exact "silent overwrite" bug that check was originally added to prevent). */
export function findDuplicateFarIds(header: string[], dataLines: string[]): DuplicateFarIdError[] {
  const farIdCol = header.findIndex((h) => h === "farId");
  if (farIdCol === -1) return []; // schema validation on the server will reject the missing column itself
  const seen = new Set<string>();
  const duplicates: DuplicateFarIdError[] = [];
  dataLines.forEach((line, i) => {
    const farId = (splitCsvFields(line)[farIdCol] ?? "").trim();
    if (farId === "") return;
    const key = farId.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({
        row: i + 2, // +1 for the header row, +1 to convert this 0-based index to 1-based
        farId,
        message: `Duplicate FAR ID "${farId}" — already appears earlier in this file.`
      });
      return;
    }
    seen.add(key);
  });
  return duplicates;
}

export interface CsvChunk {
  /** Blob ready to upload, same header + this chunk's rows only — give it a ".csv"
   *  filename when appending to FormData (loadWorksheet on the server picks its CSV vs
   *  XLSX reader off the filename extension, not the content). */
  blob: Blob;
  /** Number of ORIGINAL data lines already consumed by earlier chunks — added to a
   *  server-reported row number (which is chunk-relative) to recover the row's real
   *  position in the original file for display. */
  rowOffset: number;
}

/** Splits (header, dataLines) — with the duplicate rows from findDuplicateFarIds
 *  already removed by the caller — into upload-ready blobs of `chunkRows` rows each
 *  (default CHUNK_ROWS). A caller whose per-row commit does several sequential DB round
 *  trips instead of Assets' single batched INSERT (Disposals/Transfers — see
 *  BulkUploadPage.tsx's CHUNK_ROWS_OVERRIDE) passes a smaller value so one chunk still
 *  finishes inside Vercel's 60s function limit. */
export function chunkCsvRows(header: string[], dataLines: string[], chunkRows: number = CHUNK_ROWS): CsvChunk[] {
  const headerLine = header.map((h) => (/[",\r\n]/.test(h) ? `"${h.replace(/"/g, '""')}"` : h)).join(",");
  const chunks: CsvChunk[] = [];
  for (let i = 0; i < dataLines.length; i += chunkRows) {
    const rows = dataLines.slice(i, i + chunkRows);
    const csv = [headerLine, ...rows].join("\r\n");
    chunks.push({ blob: new Blob([csv], { type: "text/csv;charset=utf-8;" }), rowOffset: i });
  }
  return chunks;
}
