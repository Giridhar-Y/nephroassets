import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCenters } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// request() (the shared GET/POST fetch wrapper every api/client.ts function funnels
// through) retries a transient failure on GET requests — 5xx status codes always did;
// this covers the gap that motivated this test file: fetch() itself throwing (offline,
// DNS, a dropped connection) previously wasn't retried at all, unlike a 5xx response.
describe("request() retry behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once on a thrown network error, then returns the successful result", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(["Center-A", "Center-B"]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCenters();

    expect(result).toEqual(["Center-A", "Center-B"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 504 Gateway Timeout, then returns the successful result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Gateway Timeout" }, 504))
      .mockResolvedValueOnce(jsonResponse(["Center-A"]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCenters();

    expect(result).toEqual(["Center-A"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws once every retry attempt is exhausted, rather than retrying forever", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCenters()).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(3); // RETRYABLE_ATTEMPTS
  });
});
