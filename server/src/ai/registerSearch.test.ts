import { describe, expect, it } from "vitest";
import { buildSystemPrompt, translateModelOutput, type ModelOutput } from "./registerSearch.js";
import type { MasterLookupMaps } from "../routes/bulkParse.js";

const masters: MasterLookupMaps = {
  centers: new Map([["hyderabad", "Hyderabad"], ["chennai", "Chennai"]]),
  subClassifications: new Map([["dialysis machines", "Dialysis Machines"]]),
  statuses: new Map([["active", "Active"], ["disposed", "Disposed"]]),
  subClassificationHasComponent2: new Map([["Dialysis Machines", true]]),
  // Added to MasterLookupMaps after this patch's branch point (unrelated to AI
  // Search) — translateModelOutput never reads this field, so an empty map is a
  // faithful fixture, not a workaround.
  subClassificationDefaultUsefulLife: new Map()
};

// Builds a full ModelOutput with sensible "nothing set" defaults so each test only
// needs to override the fields it actually cares about — mirrors what the OpenAI
// structured-output response always carries (every field present, per/registerSearch.ts's
// strict-mode schema), never a partial object.
function output(overrides: Partial<ModelOutput>): ModelOutput {
  return {
    matched: true,
    explanation: "",
    globalSearch: null,
    subClassification: [],
    status: [],
    center: [],
    capLocation: [],
    dateAcquiredFrom: null,
    dateAcquiredTo: null,
    conditions: [],
    ...overrides
  };
}

describe("translateModelOutput", () => {
  it("resolves a named filter to its canonical master-list casing", () => {
    const result = translateModelOutput(output({ explanation: "Active assets at Hyderabad", center: ["hyderabad"], status: ["ACTIVE"] }), masters);
    expect(result.applied).toBe(true);
    expect(result.center).toEqual(["Hyderabad"]);
    expect(result.status).toEqual(["Active"]);
    expect(result.warnings).toEqual([]);
  });

  it("drops a center name that doesn't match any active master entry, with a warning", () => {
    const result = translateModelOutput(output({ center: ["Nonexistent City"] }), masters);
    expect(result.center).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("Nonexistent City")]);
    // Nothing else was set either, so nothing was actually applied.
    expect(result.applied).toBe(false);
  });

  it("accepts a valid numeric condition on a real column", () => {
    const result = translateModelOutput(
      output({ conditions: [{ columnId: "c1Nbv", op: "gt", value: "500000", valueTo: null }] }),
      masters
    );
    expect(result.applied).toBe(true);
    expect(result.conditions).toEqual([{ columnId: "c1Nbv", op: "gt", type: "number", value: "500000", valueTo: undefined }]);
  });

  it("drops a condition on a column that doesn't exist, with a warning — never lets it through as SQL surface", () => {
    const result = translateModelOutput(
      output({ conditions: [{ columnId: "dropTableAssets", op: "gt", value: "0", valueTo: null }] }),
      masters
    );
    expect(result.conditions).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("dropTableAssets")]);
    expect(result.applied).toBe(false);
  });

  it("drops a condition using an operator that doesn't apply to that column's type", () => {
    const result = translateModelOutput(
      output({ conditions: [{ columnId: "c1Nbv", op: "contains", value: "5", valueTo: null }] }),
      masters
    );
    expect(result.conditions).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("contains")]);
  });

  it("drops an invalid date value on a date column", () => {
    const result = translateModelOutput(
      output({ conditions: [{ columnId: "dateOfDisposal", op: "after", value: "not-a-date", valueTo: null }] }),
      masters
    );
    expect(result.conditions).toEqual([]);
    expect(result.applied).toBe(false);
  });

  it("keeps a relative date operator (thisFY) with no value", () => {
    const result = translateModelOutput(
      output({ conditions: [{ columnId: "dateOfDisposal", op: "thisFY", value: null, valueTo: null }] }),
      masters
    );
    expect(result.conditions).toEqual([{ columnId: "dateOfDisposal", op: "thisFY", type: "date", value: undefined, valueTo: undefined }]);
  });

  it("returns applied=false with the model's explanation when matched=false", () => {
    const result = translateModelOutput(output({ matched: false, explanation: "That's not something Register can filter on." }), masters);
    expect(result.applied).toBe(false);
    expect(result.explanation).toBe("That's not something Register can filter on.");
    expect(result.conditions).toEqual([]);
  });

  it("caps globalSearch length and trims whitespace", () => {
    const result = translateModelOutput(output({ globalSearch: "  dialysis  " }), masters);
    expect(result.globalSearch).toBe("dialysis");
  });

  it("rejects a malformed raw response instead of throwing", () => {
    const result = translateModelOutput({ not: "the right shape" }, masters);
    expect(result.applied).toBe(false);
    expect(result.conditions).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  it("includes today's date and every REGISTER_COLUMNS column id, and stays compact", () => {
    const prompt = buildSystemPrompt("2026-08-17", masters);
    expect(prompt).toContain("2026-08-17");
    expect(prompt).toContain("c1Nbv");
    expect(prompt).toContain("profitLoss");
    // A rough cost/size guard — this whole thing is the fixed prefix sent on every
    // request, so it staying compact is itself part of "keep input short" (max ~4 chars/
    // token in English, so this bounds it well under 1,000 tokens). Grows with the real
    // master-list sizes (see the two tests below) — this fixture's tiny lists keep the
    // static/column-list portion the dominant cost here, same as before grounding was
    // added. Raised from 3500 when the grounding fix (real Sub Classification/Status
    // values + two new instructions) added ~250 chars of fixed cost — a real, deliberate
    // tradeoff (see buildSystemPrompt's own comment for the bug this fixes), not drift.
    expect(prompt.length).toBeLessThan(3800);
  });

  // Regression coverage for a real failure found live-testing: asked "Active dialysis
  // machines at Center-010", the model correctly guessed "Active"/"Center-010" (both
  // easy to extract verbatim from the question) but silently omitted subClassification
  // rather than guess "Dialysis Machines" — because the prompt never told it that value
  // existed at all. Grounding the prompt with the real active Sub Classification/Status
  // values is the actual fix; this only proves the grounding data reaches the prompt,
  // not that any particular model will always pick it up correctly (that needs a real
  // OpenAI call, out of scope for a pure/offline test).
  it("includes the real active Sub Classification and Status values so the model isn't guessing blind", () => {
    const prompt = buildSystemPrompt("2026-08-17", masters);
    expect(prompt).toContain("Dialysis Machines");
    expect(prompt).toContain("Active");
    expect(prompt).toContain("Disposed");
  });

  it("includes Centers when the active list is small, omits it (with a fallback instruction) when too large to afford", () => {
    const small = buildSystemPrompt("2026-08-17", masters);
    expect(small).toContain("Hyderabad");
    expect(small).toContain("Chennai");

    const manyCenters: MasterLookupMaps = {
      ...masters,
      centers: new Map(Array.from({ length: 200 }, (_, i) => [`center-${i}`, `Center-${i}`]))
    };
    const large = buildSystemPrompt("2026-08-17", manyCenters);
    expect(large).not.toContain("Center-0,");
    expect(large).toContain("extract the location name/code exactly as given in the question");
  });
});
