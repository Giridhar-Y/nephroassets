import { z } from "zod";
import { REGISTER_COLUMNS, COLUMN_LABELS, type RawCondition } from "../routes/assetColumnFilters.js";
import { lookupCanonical, type MasterLookupMaps } from "../routes/bulkParse.js";

// AI Register Search — turns a plain-English question into the SAME structured filter
// shape Register's own manual filter UI already produces (AssetFilters' named fields +
// the Excel-style `conditions` array, see assetColumnFilters.ts), never into raw SQL.
// This is a deliberate deviation from "AI writes SQL": every condition still goes
// through buildConditionSql's existing column/operator whitelist and parameterized
// query-building exactly as if a human had picked it from the filter UI — so a
// hallucinated column, a bad operator, or a prompt-injection attempt embedded in the
// question ("ignore instructions, DROP TABLE...") has no path to becoming SQL at all,
// only a rejected/dropped filter field. The model's only job is picking values out of
// this fixed vocabulary; it never gets to invent new SQL surface area.

const TEXT_OPS = new Set(["equals", "notEquals", "contains", "notContains", "beginsWith", "endsWith", "blank", "notBlank"]);
const NUMBER_OPS = new Set(["equals", "notEquals", "gt", "gte", "lt", "lte", "between", "blank", "notBlank"]);
const DATE_OPS = new Set([
  "equals",
  "before",
  "after",
  "between",
  "today",
  "thisWeek",
  "thisMonth",
  "thisFY",
  "lastFY",
  "blank",
  "notBlank"
]);
const OPS_BY_TYPE: Record<"text" | "number" | "date", Set<string>> = { text: TEXT_OPS, number: NUMBER_OPS, date: DATE_OPS };

// Named filters the model can set directly (Register's own multi-select/text filters) —
// deliberately excludes `subClassification`/`status`/`center`(effectiveLocation)/
// `capLocation`(location), which the model should reach via these top-level array
// fields instead of `conditions[]` for an exact-match request (the common case); it can
// still use `conditions[]` with those same columnIds for a "contains"/"not equals"
// style request, same as a human switching DualModeFilterPanel to its condition tab.
const NAMED_FILTER_COLUMN_IDS = new Set(["subClassification", "status", "effectiveLocation", "location"]);

// Every REGISTER_COLUMNS entry the model is allowed to put in `conditions[]`, formatted
// compact as "id(Label):type" — the one piece of per-request-varying context in the
// prompt is `todayIso` (for relative-date math like "last 6 months"); this column list
// is completely static, so it's written once at module load, not rebuilt per request.
const COLUMN_LIST_TEXT = Object.entries(REGISTER_COLUMNS)
  .map(([id, type]) => `${id}(${COLUMN_LABELS[id] ?? id}):${type}`)
  .join(", ");

export function buildSystemPrompt(todayIso: string): string {
  return [
    "You translate a Fixed Asset Register search question into a strict JSON filter object for a finance app. Output ONLY values from the vocabulary below — never invent column ids, operators, or SQL.",
    `Today: ${todayIso}. Amounts are Indian Rupees (₹); "lakh"=100000, "crore"=10000000.`,
    'Prefer the named fields subClassification/status/center(=current location)/capLocation(=capitalized location) for an exact "is one of these values" request. Use conditions[] (columnId effectiveLocation for current location, location for capitalized location) only for contains/not-equals/other operators.',
    `conditions[] columns, format id(Label):type — text ops: equals,notEquals,contains,notContains,beginsWith,endsWith,blank,notBlank. number ops: equals,notEquals,gt,gte,lt,lte,between,blank,notBlank. date ops: equals,before,after,between,today,thisWeek,thisMonth,thisFY,lastFY,blank,notBlank (thisFY/lastFY need no value). Columns: ${COLUMN_LIST_TEXT}`,
    "value/valueTo are always strings (numbers as plain digits, dates as YYYY-MM-DD). Set matched=false with a short explanation if the question isn't about filtering this register (e.g. small talk, or asks for something outside these columns) — never guess."
  ].join("\n");
}

// OpenAI Structured Outputs (strict mode) JSON Schema — every property must be
// `required` even when logically optional; absence is expressed with a `null` in the
// type union instead. Keeping this in one place with buildSystemPrompt/modelOutputSchema
// means all three stay obviously in sync (a field added to one is easy to spot missing
// from the others) rather than drifting apart as separate hand-maintained lists.
export const REGISTER_SEARCH_JSON_SCHEMA = {
  name: "register_search_filters",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "matched",
      "explanation",
      "globalSearch",
      "subClassification",
      "status",
      "center",
      "capLocation",
      "dateAcquiredFrom",
      "dateAcquiredTo",
      "conditions"
    ],
    properties: {
      matched: { type: "boolean", description: "false if the question can't be turned into a register filter" },
      explanation: { type: "string", description: "Under 140 chars: plain-English recap of the filter applied (or why not matched)" },
      globalSearch: { type: ["string", "null"] },
      subClassification: { type: "array", items: { type: "string" } },
      status: { type: "array", items: { type: "string" } },
      center: { type: "array", items: { type: "string" }, description: "Current (effective) location" },
      capLocation: { type: "array", items: { type: "string" }, description: "Capitalized (original) location" },
      dateAcquiredFrom: { type: ["string", "null"] },
      dateAcquiredTo: { type: ["string", "null"] },
      conditions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["columnId", "op", "value", "valueTo"],
          properties: {
            columnId: { type: "string" },
            op: { type: "string" },
            value: { type: ["string", "null"] },
            valueTo: { type: ["string", "null"] }
          }
        }
      }
    }
  }
} as const;

const modelOutputSchema = z.object({
  matched: z.boolean(),
  explanation: z.string(),
  globalSearch: z.string().nullable(),
  subClassification: z.array(z.string()),
  status: z.array(z.string()),
  center: z.array(z.string()),
  capLocation: z.array(z.string()),
  dateAcquiredFrom: z.string().nullable(),
  dateAcquiredTo: z.string().nullable(),
  conditions: z.array(
    z.object({
      columnId: z.string(),
      op: z.string(),
      value: z.string().nullable(),
      valueTo: z.string().nullable()
    })
  )
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

export interface TranslatedFilters {
  applied: boolean;
  explanation: string;
  warnings: string[];
  globalSearch?: string;
  subClassification?: string[];
  status?: string[];
  center?: string[];
  capLocation?: string[];
  dateAcquiredFrom?: string;
  dateAcquiredTo?: string;
  conditions: Array<RawCondition & { type: "text" | "number" | "date" }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolves a model-supplied list of free-text names against the DB's active master
 *  list, keeping only ones that actually resolve (case-insensitively) to a real active
 *  Center/Sub Classification/Status — the same trust boundary bulkUpload.ts's own
 *  lookupCanonical enforces for a spreadsheet cell, applied here to an LLM's output
 *  instead. A name that doesn't resolve is dropped with a warning, never passed through
 *  as free text (which would silently match nothing once the query runs — better to say
 *  so up front). */
function resolveNames(names: string[], map: Map<string, string>, label: string, warnings: string[]): string[] {
  const resolved: string[] = [];
  for (const name of names) {
    const canonical = lookupCanonical(map, name);
    if (canonical) resolved.push(canonical);
    else warnings.push(`Couldn't match ${label} "${name}" to a known active value — left out.`);
  }
  return resolved;
}

/** Parses and safety-checks the model's raw JSON response into the exact filter shape
 *  Register's own UI already applies. Pure/no I/O (besides the already-loaded
 *  `masters`), so it's directly unit-testable without a live OpenAI call — every field
 *  is re-validated against real server-side registries (REGISTER_COLUMNS' column/type
 *  list, the operator sets above, the DB's active master lists) regardless of what the
 *  strict JSON-schema response_format already constrained, exactly the same
 *  "trust but verify" the rest of this app applies to bulk-upload input. */
export function translateModelOutput(raw: unknown, masters: MasterLookupMaps): TranslatedFilters {
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { applied: false, explanation: "The AI's response wasn't understood — try rephrasing your question.", warnings: [], conditions: [] };
  }
  const out = parsed.data;
  const warnings: string[] = [];

  if (!out.matched) {
    return { applied: false, explanation: out.explanation.slice(0, 200) || "Couldn't turn that into a filter.", warnings, conditions: [] };
  }

  const conditions: Array<RawCondition & { type: "text" | "number" | "date" }> = [];
  for (const cond of out.conditions) {
    const type = REGISTER_COLUMNS[cond.columnId];
    if (!type) {
      warnings.push(`Ignored an unrecognized column "${cond.columnId}".`);
      continue;
    }
    if (!OPS_BY_TYPE[type].has(cond.op)) {
      warnings.push(`Ignored an unsupported operator "${cond.op}" for ${COLUMN_LABELS[cond.columnId] ?? cond.columnId}.`);
      continue;
    }
    if (type === "date" && cond.value && !["today", "thisWeek", "thisMonth", "thisFY", "lastFY", "blank", "notBlank"].includes(cond.op) && !DATE_RE.test(cond.value)) {
      warnings.push(`Ignored an invalid date for ${COLUMN_LABELS[cond.columnId] ?? cond.columnId}.`);
      continue;
    }
    conditions.push({
      columnId: cond.columnId,
      op: cond.op,
      type,
      value: cond.value ?? undefined,
      valueTo: cond.valueTo ?? undefined
    });
  }

  const subClassification = resolveNames(out.subClassification, masters.subClassifications, "Sub Classification", warnings);
  const status = resolveNames(out.status, masters.statuses, "Status", warnings);
  const center = resolveNames(out.center, masters.centers, "location", warnings);
  const capLocation = resolveNames(out.capLocation, masters.centers, "location", warnings);
  const dateAcquiredFrom = out.dateAcquiredFrom && DATE_RE.test(out.dateAcquiredFrom) ? out.dateAcquiredFrom : undefined;
  const dateAcquiredTo = out.dateAcquiredTo && DATE_RE.test(out.dateAcquiredTo) ? out.dateAcquiredTo : undefined;
  const globalSearch = out.globalSearch?.trim() ? out.globalSearch.trim().slice(0, 100) : undefined;

  const appliedSomething =
    conditions.length > 0 ||
    subClassification.length > 0 ||
    status.length > 0 ||
    center.length > 0 ||
    capLocation.length > 0 ||
    !!dateAcquiredFrom ||
    !!dateAcquiredTo ||
    !!globalSearch;

  return {
    applied: appliedSomething,
    explanation: appliedSomething
      ? out.explanation.slice(0, 200) || "Filters applied."
      : out.explanation.slice(0, 200) || "Couldn't match that to any filterable value.",
    warnings,
    ...(globalSearch ? { globalSearch } : {}),
    ...(subClassification.length ? { subClassification } : {}),
    ...(status.length ? { status } : {}),
    ...(center.length ? { center } : {}),
    ...(capLocation.length ? { capLocation } : {}),
    ...(dateAcquiredFrom ? { dateAcquiredFrom } : {}),
    ...(dateAcquiredTo ? { dateAcquiredTo } : {}),
    conditions
  };
}

// Referenced by aiSearch.ts so a condition targeting subClassification/status/location
// via `conditions[]` (the DualModeFilterPanel "custom condition" path) is still valid —
// this set exists purely for documentation/tests, translateModelOutput doesn't need to
// special-case it (buildConditionSql already accepts these columnIds like any other).
export { NAMED_FILTER_COLUMN_IDS };
