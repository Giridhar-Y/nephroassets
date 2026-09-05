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

function joinSorted(values: Iterable<string>): string {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)).join(", ");
}

// Real master-list values were previously left out of the prompt entirely — the model
// only ever saw the FIELD NAMES (subClassification/status/center), never the actual
// active values, so it had to guess an exact string from world knowledge alone. Found
// investigating a real live-tested failure: asked "Active dialysis machines at
// Center-010", the model correctly guessed "Active" and "Center-010" (both easy — one's
// generic, the other was typed verbatim in the question) but silently OMITTED
// subClassification entirely rather than guess "Dialysis Machines" wrong — while its own
// `explanation` field claimed it had. Grounding the prompt with the real active values
// fixes the guessing problem at the source; the two instructions below fix the two
// failure modes that guessing left behind (omitting a named entity, and an explanation
// that overclaims what was actually set).
export function buildSystemPrompt(
  todayIso: string,
  masters: Pick<MasterLookupMaps, "subClassifications" | "statuses" | "centers">
): string {
  const subClassificationList = joinSorted(masters.subClassifications.values());
  const statusList = joinSorted(masters.statuses.values());
  // Centers can run into the hundreds at this app's real scale (500+, per its own
  // documented target) — inlining all of them on every request would meaningfully
  // inflate token cost for comparatively little benefit, since a location named in the
  // question is usually specific enough to extract directly. Included only when small
  // enough that the cost is negligible; above that, the model makes its own best-effort
  // extraction and resolveNames' post-hoc validation (with a visible warning on a miss)
  // is the safety net instead — same graceful-degradation shape, just without the
  // grounding this size of list can't afford.
  const centerValues = [...new Set(masters.centers.values())];
  const centerList = centerValues.length <= 150 ? joinSorted(centerValues) : null;

  return [
    "You translate a Fixed Asset Register search question into a strict JSON filter object for a finance app. Output ONLY values from the vocabulary below — never invent column ids, operators, or SQL.",
    `Today: ${todayIso}. Amounts are Indian Rupees (₹); "lakh"=100000, "crore"=10000000.`,
    `Active Sub Classifications: ${subClassificationList}`,
    `Active Statuses: ${statusList}`,
    centerList
      ? `Active Centers (locations): ${centerList}`
      : "Centers/locations aren't listed here (too many) — extract the location name/code exactly as given in the question; an unmatched value is dropped server-side with a warning, so a best-effort attempt is safe.",
    'Prefer the named fields subClassification/status/center(=current location)/capLocation(=capitalized location) for an exact "is one of these values" request — use the EXACT spelling/casing from the active lists above (or the question\'s own text for a center, if centers aren\'t listed), never a paraphrase or synonym; a value that doesn\'t match exactly is silently dropped. Use conditions[] (columnId effectiveLocation for current location, location for capitalized location) only for contains/not-equals/other operators — NEVER also add a conditions[] equals entry for a column already covered by one of these named fields; that produces two duplicate filters for the same thing, not one. There is no named field for Date Acquired — always express it via conditions[] (columnId dateAcquired, ops before/after/between/etc.), never any other way.',
    `conditions[] columns, format id(Label):type — text ops: equals,notEquals,contains,notContains,beginsWith,endsWith,blank,notBlank. number ops: equals,notEquals,gt,gte,lt,lte,between,blank,notBlank. date ops: equals,before,after,between,today,thisWeek,thisMonth,thisFY,lastFY,blank,notBlank (thisFY/lastFY need no value). Columns: ${COLUMN_LIST_TEXT}`,
    // Most cost/value columns are split per-component (c1X/c2X) with no combined column
    // at all — the model has to pick ONE dynamically based on what the question actually
    // says, not guess inconsistently run to run. totalWdv/profitLoss are the two genuine
    // exceptions (already combined columns), stated explicitly so the model doesn't
    // needlessly split those into c1/c2 too.
    "Pick the column that matches what the question actually asks, dynamically per question — never a fixed default. NBV/Gross Block/Acc Dep/Opening NBV/Period Depreciation each have separate c1/c2 columns with no combined column at all: if the question says \"C2\"/\"component 2\" use the c2 column, otherwise use the c1 column (the common case). \"WDV\"/\"written down value\" alone means totalWdv (already C1+C2 combined) — do not split it. \"Profit\"/\"loss\"/\"gain on disposal\" means profitLoss (already combined).",
    "value/valueTo are always strings (numbers as plain digits, dates as YYYY-MM-DD). Set matched=false with a short explanation if the question isn't about filtering this register (e.g. small talk, or asks for something outside these columns) — never guess.",
    "Every entity the question explicitly names (a sub classification, status, or location) MUST appear in the output — attempt the closest matching value from the active lists above rather than omitting it. A wrong guess is dropped safely server-side and costs nothing; silently omitting a named entity produces an incomplete filter with no visible sign anything was left out.",
    "explanation must describe ONLY the filters you actually set in the fields above — never mention a value you left out or didn't include."
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
      // No dateAcquiredFrom/dateAcquiredTo — see this schema's own git history for why:
      // having both this AND conditions[] (columnId dateAcquired) meant the model could
      // (and did) populate both for the same request, producing a duplicate, and
      // RegisterPage has no chip UI for these fields at all (legacy, kept only for old
      // saved links) — so a value set here filtered data with no visible way to see or
      // remove it. conditions[] is now the ONLY path for Date Acquired, which already has
      // a real, removable chip.
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

  let conditions: Array<RawCondition & { type: "text" | "number" | "date" }> = [];
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
  const globalSearch = out.globalSearch?.trim() ? out.globalSearch.trim().slice(0, 100) : undefined;

  // Dedup: the model shouldn't ever set both a named field AND an equals-op condition
  // on the column that same named field already covers (found live: "Dialysis machines"
  // produced both subClassification=["Dialysis Machines"] AND a conditions[] entry
  // "subClassification equals Dialysis Machines" — two chips for one filter). The named
  // field is always the intended channel for an exact-match request per the prompt's own
  // instruction; a same-column equals condition alongside it is redundant by
  // construction, not a legitimate second constraint, so it's dropped silently (not a
  // warning — the result is correct either way, there's nothing wrong to flag). Only
  // equals is dropped: a genuinely different operator (contains, notEquals, ...) on the
  // same column is a real, distinct constraint the named field can't express, kept as-is.
  const namedFieldPopulated: Record<string, boolean> = {
    subClassification: subClassification.length > 0,
    status: status.length > 0,
    effectiveLocation: center.length > 0,
    location: capLocation.length > 0
  };
  conditions = conditions.filter((cond) => !(cond.op === "equals" && namedFieldPopulated[cond.columnId]));

  const appliedSomething =
    conditions.length > 0 || subClassification.length > 0 || status.length > 0 || center.length > 0 || capLocation.length > 0 || !!globalSearch;

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
    conditions
  };
}

// Referenced by aiSearch.ts so a condition targeting subClassification/status/location
// via `conditions[]` (the DualModeFilterPanel "custom condition" path) is still valid —
// this set exists purely for documentation/tests, translateModelOutput doesn't need to
// special-case it (buildConditionSql already accepts these columnIds like any other).
export { NAMED_FILTER_COLUMN_IDS };
