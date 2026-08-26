import { describe, expect, it } from "vitest";
import { depreciationFormulaText } from "./depreciationFormula.js";

describe("depreciationFormulaText", () => {
  it("embeds the current DAYS_FY value in both per-tranche lines", () => {
    const text = depreciationFormulaText(365);
    expect(text).toContain("DaysHeldOpening / 365");
    expect(text).toContain("DaysHeldAddition / 365");
  });

  it("reflects a changed DAYS_FY value", () => {
    expect(depreciationFormulaText(366)).toContain("/ 366");
  });
});
