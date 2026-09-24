import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUntilReady, PREPARING_GIVE_UP_MS, PREPARING_POLL_MS } from "./preparing.js";

const PREPARING = { status: "preparing" as const, asAt: "2026-04-01" };

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchUntilReady", () => {
  it("polls every 15s while preparing, then resolves with the real payload", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(PREPARING).mockResolvedValueOnce(PREPARING).mockResolvedValueOnce({ ok: 1 });
    const onPreparing = vi.fn();
    const result = fetchUntilReady(fetcher, { onPreparing, isCurrent: () => true });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PREPARING_POLL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1); // not before 15s
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PREPARING_POLL_MS);

    await expect(result).resolves.toEqual({ ok: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onPreparing).toHaveBeenCalledTimes(2);
  });

  it("stops polling (resolves undefined) once the page has moved on", async () => {
    vi.useFakeTimers();
    let current = true;
    const fetcher = vi.fn().mockResolvedValue(PREPARING);
    const result = fetchUntilReady(fetcher, { onPreparing: () => {}, isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(PREPARING_POLL_MS * 3);
    await expect(result).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives up with a clear message after 10 minutes instead of polling forever", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(PREPARING);
    const result = fetchUntilReady(fetcher, { onPreparing: () => {}, isCurrent: () => true });
    const assertion = expect(result).rejects.toThrow(/still being prepared after 10 minutes/);
    await vi.advanceTimersByTimeAsync(PREPARING_GIVE_UP_MS + PREPARING_POLL_MS);
    await assertion;
    expect(fetcher.mock.calls.length).toBe(PREPARING_GIVE_UP_MS / PREPARING_POLL_MS + 1);
  });
});
