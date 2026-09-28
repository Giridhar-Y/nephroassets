import { describe, expect, it } from "vitest";
import { addYearsToIsoDate, formatCurrency, formatCurrencyPrecise, isNegativeFormattedCurrency } from "./format.js";

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

// Hand-typed on purpose: Intl's en-IN "accounting" currency pattern uses Western grouping
// (₹1,000,000), which is how every amount in the app was shown until this was pinned.
describe("formatCurrency / formatCurrencyPrecise: Indian grouping", () => {
  it("groups by lakh and crore", () => {
    expect(formatCurrency(0)).toBe("₹0");
    expect(formatCurrency(999)).toBe("₹999");
    expect(formatCurrency(1000)).toBe("₹1,000");
    expect(formatCurrency(100000)).toBe("₹1,00,000");
    expect(formatCurrency(1000000)).toBe("₹10,00,000");
    expect(formatCurrency(81066831.4)).toBe("₹8,10,66,831");
    expect(formatCurrency(4572287396.22)).toBe("₹4,57,22,87,396");
  });

  it("shows negatives in parentheses, still with Indian grouping", () => {
    expect(formatCurrency(-1234567)).toBe("(₹12,34,567)");
    expect(isNegativeFormattedCurrency(formatCurrency(-1234567))).toBe(true);
    expect(formatCurrency(-0.4)).toBe("₹0"); // rounds to zero: no "(₹0)"
    expect(isNegativeFormattedCurrency(formatCurrency(5))).toBe(false);
  });

  it("keeps paise in the precise variant", () => {
    expect(formatCurrencyPrecise(2263256.5)).toBe("₹22,63,256.50");
    expect(formatCurrencyPrecise(22632.5678)).toBe("₹22,632.5678");
    expect(formatCurrencyPrecise(-21598.5)).toBe("(₹21,598.50)");
    expect(formatCurrencyPrecise(0)).toBe("₹0.00");
  });
});
