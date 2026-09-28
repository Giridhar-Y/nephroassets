import ExcelJS from "exceljs";
import { csvLine } from "./assetsExport.js";
import { CATEGORY_LABELS, formatIstTimestamp, humanizeAction, resolveFinancialYear, shapeRow, type RawRow } from "./activityLog.js";

// The Activity Log export, as Finance reconciles it: an Events sheet (one row per log
// entry: who, when, what, which asset, which approval) and a Changes sheet (one row per
// changed field, linked back by Event ID), with amounts as real numbers. The CSV (the
// background export) is the Changes layout with each event's date/user/asset repeated.
//
// Log entries were written by many routes over time, in a few shapes; each is read here:
//   - Edit Asset: { changed, before, after }
//   - an update with a before-snapshot: { ...new values, previous: { ...old values } }
//     (additions, disposals, transfers, Masters updates)
//   - a delete/undo (the Delete Log): a snapshot of what was removed -> Old Value only
//   - a create: the entered values -> New Value only

/** The module forms' own labels (Capitalization, Addition, Disposal, Transfer, Edit
 *  Asset, Masters), as on screen. Unlisted keys fall back to a readable field name. */
const FIELD_LABELS: Record<string, string> = {
  farId: "FAR ID",
  subClassification: "Sub Classification",
  assetDescription: "Asset Description",
  serialNo: "Serial No",
  qty: "Qty",
  status: "Status",
  dateAcquired: "Date Acquired",
  location: "Location",
  toLocation: "Destination Center",
  transactionDate: "Transfer Date",
  usefulLifeC1Years: "Component 1 Useful Life (Years)",
  usefulLifeC2Years: "Component 2 Useful Life (Years)",
  c1OpeningCost: "Component 1 Opening Cost",
  c2OpeningCost: "Component 2 Opening Cost",
  additionsC1: "Additions C1",
  additionsC2: "Additions C2",
  dateOfAddition: "Date of Addition",
  parentFarId: "Parent Asset",
  accDepC1Opening: "Opening Accumulated Depreciation (Component 1)",
  accDepC2Opening: "Opening Accumulated Depreciation (Component 2)",
  dateOfDisposal: "Disposal Date",
  saleValue: "Sale Value",
  deletionsC1: "Deletions C1",
  deletionsC2: "Deletions C2",
  code: "Code",
  name: "Name",
  description: "Description",
  defaultUsefulLifeC1Years: "Default C1 Life (yrs)",
  defaultUsefulLifeC2Years: "Default C2 Life (yrs)",
  hasComponent2: "Has Component 2",
  active: "Active",
  grants: "Permissions",
  added: "Permissions added",
  removed: "Permissions removed"
};
const FIELD_ORDER = new Map(Object.keys(FIELD_LABELS).map((k, i) => [k, i]));

/** Rupee amounts: written as number cells (2 decimals). */
const AMOUNT_FIELDS = new Set([
  "c1OpeningCost",
  "c2OpeningCost",
  "additionsC1",
  "additionsC2",
  "accDepC1Opening",
  "accDepC2Opening",
  "saleValue",
  "deletionsC1",
  "deletionsC2"
]);

/** Bookkeeping in the log entry, not a field of the record: shown as Notes on the event. */
const META_KEYS = new Set([
  "source",
  "sourceFilename",
  "previous",
  "type",
  "reason",
  "changed",
  "before",
  "after",
  "childrenDisposed",
  "cascadedChildren",
  "cascadedFromParentFarId",
  "transferId",
  "id",
  "roleId",
  "record",
  "assetsUpdated",
  "transfersUpdated",
  "usersUpdated"
]);

export interface ExportEvent {
  eventId: string;
  timestamp: string;
  financialYear: string;
  user: string;
  module: string;
  action: string;
  record: string;
  center: string;
  submittedBy: string;
  approvedBy: string;
  requestId: number | null;
  reason: string;
  notes: string;
}

export interface ExportChange {
  field: string;
  oldValue: string | number | null;
  newValue: string | number | null;
  /** A rupee amount: 2-decimal number format. Other numbers (Qty, Useful Life) stay plain. */
  amount: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

/** A field value as the export shows it: amounts as numbers, dates DD-MM-YYYY, Yes/No,
 *  permission lists readable. Entered values are never rounded. */
function exportValue(key: string, value: unknown): string | number | null {
  if (isEmpty(value)) return null;
  if (AMOUNT_FIELDS.has(key) && Number.isFinite(Number(value))) return Number(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return ddmmyyyy(value);
  if (Array.isArray(value))
    return value
      .map((v) => (isPlainObject(v) && "module" in v && "action" in v ? `${String(v.module)}: ${String(v.action)}` : isPlainObject(v) ? JSON.stringify(v) : String(v)))
      .join(", ");
  if (isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

/** The field-level changes one log entry records (see the shapes listed at the top). */
export function deriveChanges(row: Pick<RawRow, "src" | "action" | "details">): ExportChange[] {
  const d = (row.details ?? {}) as Record<string, unknown>;
  const rows: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
  if (row.action === "asset_edit" && isPlainObject(d.before) && isPlainObject(d.after)) {
    const before = d.before;
    const after = d.after;
    const keys = Array.isArray(d.changed) ? (d.changed as string[]) : [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const k of keys) rows.push({ key: k, oldValue: before[k], newValue: after[k] });
  } else {
    const previous = isPlainObject(d.previous) ? d.previous : null;
    // A create lists only the fields actually filled in: its zero amounts and empty
    // fields (unused Mid-Year Additions, Component 2 on a C1-only asset, ...) add rows
    // without information (and ~5 rows per capitalization across the whole log).
    const isCreate = row.src !== "delete" && !previous;
    for (const [k, v] of Object.entries(d)) {
      if (META_KEYS.has(k)) continue;
      if (previous && k in previous) rows.push({ key: k, oldValue: previous[k], newValue: v });
      else if (row.src === "delete") rows.push({ key: k, oldValue: v, newValue: null });
      else if (isCreate && (v === 0 || v === "0")) continue;
      else rows.push({ key: k, oldValue: null, newValue: v });
    }
    // A previous value whose field isn't restated: a disposal doesn't store its new
    // status (always "Disposed"); anything else was cleared.
    if (previous)
      for (const [k, v] of Object.entries(previous))
        if (!(k in d)) rows.push({ key: k, oldValue: v, newValue: row.action === "disposal_create" && k === "status" ? "Disposed" : null });
  }
  return rows
    .filter((r) => !(isEmpty(r.oldValue) && isEmpty(r.newValue)))
    .sort((a, b) => (FIELD_ORDER.get(a.key) ?? 999) - (FIELD_ORDER.get(b.key) ?? 999))
    .map((r) => ({
      field: fieldLabel(r.key),
      oldValue: exportValue(r.key, r.oldValue),
      newValue: exportValue(r.key, r.newValue),
      amount: AMOUNT_FIELDS.has(r.key)
    }));
}

function eventNotes(d: Record<string, unknown>): string {
  const notes: string[] = [];
  if (d.source === "bulk") notes.push(`Bulk upload${d.sourceFilename ? ` (${String(d.sourceFilename)})` : ""}`);
  if (Array.isArray(d.childrenDisposed) && d.childrenDisposed.length) notes.push(`Children disposed: ${d.childrenDisposed.join(", ")}`);
  if (Array.isArray(d.cascadedChildren) && d.cascadedChildren.length)
    notes.push(`Also applied to children: ${d.cascadedChildren.map((c) => (isPlainObject(c) ? String(c.farId) : String(c))).join(", ")}`);
  if (d.cascadedFromParentFarId) notes.push(`Moved with parent ${String(d.cascadedFromParentFarId)}`);
  return notes.join("; ");
}

export function toExportEvent(row: RawRow, fyStartMonth: number, fyStartDay: number): ExportEvent {
  const item = shapeRow(row);
  const d = (row.details ?? {}) as Record<string, unknown>;
  const approvals = row.approvals ?? [];
  const requestId = row.approval_request_id ? Number(row.approval_request_id) : null;
  const center = typeof d.location === "string" ? d.location : row.src === "masters" ? "" : (row.asset_center ?? "");
  return {
    eventId: `${row.src[0]!.toUpperCase()}-${row.id}`,
    timestamp: formatIstTimestamp(item.createdAt),
    financialYear: resolveFinancialYear(item.createdAt, fyStartMonth, fyStartDay),
    user: item.actorUsername ?? "Unknown user",
    module: CATEGORY_LABELS[item.category],
    action: (item.details?.type as string | undefined) ?? humanizeAction(item.action),
    record: row.far_id ?? String(d.record ?? d.code ?? d.name ?? ""),
    center,
    submittedBy: requestId ? (item.actorUsername ?? "") : "",
    approvedBy: approvals
      .map((a) => `Step ${a.step}: ${a.by ?? "Unknown user"}, ${formatIstTimestamp(new Date(a.at).toISOString())}${a.comment ? ` ("${a.comment}")` : ""}`)
      .join("; "),
    requestId,
    reason: row.reason ?? "",
    notes: eventNotes(d)
  };
}

// --- Workbook (direct export) ------------------------------------------------------------

const AMOUNT_FMT = "#,##0.00;(#,##0.00);0.00";
const EVENT_HEADERS = [
  "Event ID",
  "Date & Time (IST)",
  "Financial Year",
  "User",
  "Module",
  "Action",
  "FAR ID / Master",
  "Center",
  "Submitted By",
  "Approved By",
  "Request",
  "Reason",
  "Notes"
];
const CHANGE_HEADERS = ["Event ID", "FAR ID / Master", "Field", "Old Value", "New Value"];

export interface ActivityWorkbook {
  addEvent(event: ExportEvent, changes: ExportChange[]): void;
  finish(): Promise<ExcelJS.Buffer>;
}

/** Excel's hard limit on rows per sheet. A sheet is never allowed past it (Excel would
 *  "repair" the file by silently dropping everything beyond): the rows continue on
 *  "Changes (2)", "Changes (3)", ... (and "Events (2)" in the unlikely event it's needed). */
export const EXCEL_MAX_ROWS = 1_048_576;
const HEADER_ROWS = 5;

/** Two sheets with a shared header band; rows are added one event at a time. `appUrl`
 *  (the app's origin) turns request numbers into links to the request in Tasks.
 *  `maxRowsPerSheet` exists for tests (Excel's limit otherwise). */
export function createActivityWorkbook(
  header: { generatedLine: string; filterLine: string; appUrl: string | null },
  maxRowsPerSheet: number = EXCEL_MAX_ROWS
): ActivityWorkbook {
  const workbook = new ExcelJS.Workbook();
  const addSheet = (base: "Events" | "Changes", part: number) => {
    const name = part === 1 ? base : `${base} (${part})`;
    const sheet = workbook.addWorksheet(name);
    const headers = base === "Events" ? EVENT_HEADERS : CHANGE_HEADERS;
    sheet.columns = (base === "Events" ? [12, 18, 12, 16, 16, 24, 22, 20, 16, 40, 12, 28, 36] : [12, 22, 34, 22, 22]).map((width) => ({ width }));
    writeHeaderBand(sheet, headers, `NephroPlus - Activity Log Export: ${name}`);
    return sheet;
  };
  const writeHeaderBand = (sheet: ExcelJS.Worksheet, headers: readonly string[], title: string) => {
    const titleCell = sheet.getRow(1).getCell(1);
    titleCell.value = title;
    sheet.mergeCells(1, 1, 1, headers.length);
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    titleCell.font = { color: { argb: "FFFFFFFF" }, bold: true, size: 12 };
    for (const [rowNumber, text] of [
      [2, header.generatedLine],
      [3, header.filterLine]
    ] as const) {
      sheet.getRow(rowNumber).getCell(1).value = text;
      sheet.mergeCells(rowNumber, 1, rowNumber, headers.length);
      sheet.getRow(rowNumber).getCell(1).font = { italic: true, color: { argb: "FF52525B" } };
    }
    const headerRow = sheet.getRow(HEADER_ROWS);
    headers.forEach((h, i) => (headerRow.getCell(i + 1).value = h));
    headerRow.font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: HEADER_ROWS }];
  };
  let events = addSheet("Events", 1);
  let changes = addSheet("Changes", 1);
  let eventsPart = 1;
  let changesPart = 1;
  let nextEventRow = HEADER_ROWS + 1;
  let nextChangeRow = HEADER_ROWS + 1;

  return {
    addEvent(event, eventChanges) {
      if (nextEventRow > maxRowsPerSheet) {
        events = addSheet("Events", ++eventsPart);
        nextEventRow = HEADER_ROWS + 1;
      }
      const eventRowNumber = nextEventRow++;
      const eventsSheetName = events.name;
      const row = events.getRow(eventRowNumber);
      [
        event.eventId,
        event.timestamp,
        event.financialYear,
        event.user,
        event.module,
        event.action,
        event.record,
        event.center,
        event.submittedBy,
        event.approvedBy,
        null,
        event.reason,
        event.notes
      ].forEach((v, i) => (row.getCell(i + 1).value = v === "" ? null : v));
      if (event.requestId !== null) {
        row.getCell(11).value = header.appUrl
          ? { text: `#${event.requestId}`, hyperlink: `${header.appUrl}/#/tasks?tab=all&request=${event.requestId}` }
          : `#${event.requestId}`;
      }
      for (const change of eventChanges) {
        if (nextChangeRow > maxRowsPerSheet) {
          changes = addSheet("Changes", ++changesPart);
          nextChangeRow = HEADER_ROWS + 1;
        }
        const c = changes.getRow(nextChangeRow++);
        c.getCell(1).value = { text: event.eventId, hyperlink: `#'${eventsSheetName}'!A${eventRowNumber}` };
        c.getCell(2).value = event.record || null;
        c.getCell(3).value = change.field;
        for (const [col, v] of [
          [4, change.oldValue],
          [5, change.newValue]
        ] as const) {
          c.getCell(col).value = v;
          if (typeof v === "number" && change.amount) c.getCell(col).numFmt = AMOUNT_FMT;
        }
      }
    },
    finish: () => workbook.xlsx.writeBuffer()
  };
}

// --- CSV (background export) -------------------------------------------------------------

export const CHANGES_CSV_HEADER = csvLine([
  "Event ID",
  "Date & Time (IST)",
  "User",
  "FAR ID / Master",
  "Module",
  "Action",
  "Field",
  "Old Value",
  "New Value",
  "Request"
]);

/** One event as Changes-layout CSV lines; an event with no field changes still gets one
 *  line, so no event is dropped from the file. Amounts stay plain numbers. */
export function changesCsvLines(event: ExportEvent, eventChanges: ExportChange[]): string[] {
  const base = [event.eventId, event.timestamp, event.user, event.record, event.module, event.action];
  const request = event.requestId !== null ? `#${event.requestId}` : "";
  if (eventChanges.length === 0) return [csvLine([...base, "", "", "", request])];
  return eventChanges.map((c) => csvLine([...base, c.field, c.oldValue, c.newValue, request]));
}
