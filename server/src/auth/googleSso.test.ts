import { describe, expect, it } from "vitest";
import { isAllowedGoogleEmail } from "./googleSso.js";

describe("isAllowedGoogleEmail", () => {
  it("allows a verified email on the configured domain", () => {
    expect(isAllowedGoogleEmail("alice@nephroplus.com", true, "nephroplus.com")).toBe(true);
  });

  it("is case-insensitive on both the email domain and the configured domain", () => {
    expect(isAllowedGoogleEmail("Alice@NephroPlus.com", true, "nephroplus.com")).toBe(true);
    expect(isAllowedGoogleEmail("alice@nephroplus.com", true, "NephroPlus.com")).toBe(true);
  });

  it("rejects an unverified email even on the right domain", () => {
    expect(isAllowedGoogleEmail("alice@nephroplus.com", false, "nephroplus.com")).toBe(false);
  });

  it("rejects a different domain", () => {
    expect(isAllowedGoogleEmail("alice@gmail.com", true, "nephroplus.com")).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(isAllowedGoogleEmail(undefined, true, "nephroplus.com")).toBe(false);
  });
});
