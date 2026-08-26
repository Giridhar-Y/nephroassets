import { describe, expect, it } from "vitest";
import { addYearsToIsoDate } from "./format.js";

describe("addYearsToIsoDate", () => {
  it("adds whole years calendar-correctly", () => {
    expect(addYearsToIsoDate("2020-06-15", 5)).toBe("2025-06-15");
  });

  it("adds a fractional year as an approximate day offset", () => {
    // 0.5 * 365.25 rounds to 183 days; 2020 is a leap year so Jan 1 + 183 days is Jul 2.
    expect(addYearsToIsoDate("2020-01-01", 0.5)).toBe("2020-07-02");
  });

  it("handles a leap-day capitalization date", () => {
    expect(addYearsToIsoDate("2020-02-29", 4)).toBe("2024-02-29");
  });

  it("returns null for zero or negative useful life", () => {
    expect(addYearsToIsoDate("2020-01-01", 0)).toBeNull();
    expect(addYearsToIsoDate("2020-01-01", -1)).toBeNull();
  });
});
