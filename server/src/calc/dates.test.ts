import { describe, expect, it } from "vitest";
import { daysHeldInclusive, isAfter, isOnOrBefore, maxIsoDate, parseIsoDate } from "./dates.js";

describe("parseIsoDate", () => {
  it("parses a normal date", () => {
    expect(parseIsoDate("2025-04-01")).toBe(Date.UTC(2025, 3, 1));
  });

  it("handles a leap-year Feb 29 boundary", () => {
    expect(parseIsoDate("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  });
});

describe("daysHeldInclusive", () => {
  it("counts a normal multi-month span inclusively", () => {
    expect(daysHeldInclusive("2025-04-01", "2025-09-30")).toBe(183);
  });

  it("returns 1 for the same start and end date (boundary)", () => {
    expect(daysHeldInclusive("2025-04-01", "2025-04-01")).toBe(1);
  });

  it("returns a negative count when end precedes start (edge)", () => {
    expect(daysHeldInclusive("2025-09-30", "2025-04-01")).toBeLessThan(0);
  });
});

describe("isOnOrBefore / isAfter", () => {
  it("normal ordering", () => {
    expect(isOnOrBefore("2025-04-01", "2025-09-30")).toBe(true);
    expect(isAfter("2025-09-30", "2025-04-01")).toBe(true);
  });

  it("equal dates are on-or-before but not after (boundary)", () => {
    expect(isOnOrBefore("2025-04-01", "2025-04-01")).toBe(true);
    expect(isAfter("2025-04-01", "2025-04-01")).toBe(false);
  });
});

describe("maxIsoDate", () => {
  it("picks the latest of several dates", () => {
    expect(maxIsoDate(["2025-04-01", "2025-09-30", "2025-06-15"])).toBe("2025-09-30");
  });

  it("returns the only date when given a single-element array (boundary)", () => {
    expect(maxIsoDate(["2025-04-01"])).toBe("2025-04-01");
  });
});
