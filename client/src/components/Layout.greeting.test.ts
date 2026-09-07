import { describe, expect, it } from "vitest";
import { formatGreeting } from "./Layout.js";

describe("formatGreeting", () => {
  it("greets by time of day on a first visit today", () => {
    expect(formatGreeting("Priya", 8, false)).toBe("Good morning, Priya");
    expect(formatGreeting("Priya", 13, false)).toBe("Good afternoon, Priya");
    expect(formatGreeting("Priya", 20, false)).toBe("Good evening, Priya");
  });

  it("switches to a plain welcome-back on a same-day return visit, regardless of hour", () => {
    expect(formatGreeting("Priya", 8, true)).toBe("Welcome back, Priya");
    expect(formatGreeting("Priya", 20, true)).toBe("Welcome back, Priya");
  });

  it("boundary hours land on the correct time-of-day bucket", () => {
    expect(formatGreeting("Priya", 11, false)).toBe("Good morning, Priya");
    expect(formatGreeting("Priya", 12, false)).toBe("Good afternoon, Priya");
    expect(formatGreeting("Priya", 16, false)).toBe("Good afternoon, Priya");
    expect(formatGreeting("Priya", 17, false)).toBe("Good evening, Priya");
  });
});
