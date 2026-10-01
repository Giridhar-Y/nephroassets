import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "../db/pool.js";
import { invalidateReportTotalsCache } from "../db/reportTotalsCache.js";
import { dispatchAfterWrite } from "./prewarmRequests.js";
import { kickPrewarmAfterWrite, resetPrewarmPassStateForTests, runPrewarmPass } from "./dashboardPrewarm.js";

// Re-warming after a write clears the report cache: on Vercel a GitHub workflow dispatch
// throttled across instances; on a long-running server an in-process pass, throttled and
// never overlapping another pass.

const dispatches = () =>
  (vi.mocked(fetch).mock.calls as Array<[string, ...unknown[]]>).filter(([url]) => String(url).includes("dashboard-prewarm.yml/dispatches")).length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  await (await getPool()).query(`DELETE FROM report_prewarm_dispatch`);
  vi.stubEnv("GITHUB_DISPATCH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_DISPATCH_REPO", "owner/repo");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  resetPrewarmPassStateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPrewarmPassStateForTests();
});

describe("Vercel: dispatch after a write, at most once per 10 minutes", () => {
  it("the first write dispatches; later writes inside 10 minutes don't; after 10 minutes it dispatches again", async () => {
    const db = await getPool();
    expect(await dispatchAfterWrite(db)).toBe(true);
    expect(await dispatchAfterWrite(db)).toBe(false);
    expect(await dispatchAfterWrite(db)).toBe(false);
    expect(dispatches()).toBe(1);

    await db.query(`UPDATE report_prewarm_dispatch SET last_dispatch_at = NOW() - INTERVAL '9 minutes'`);
    expect(await dispatchAfterWrite(db)).toBe(false);
    await db.query(`UPDATE report_prewarm_dispatch SET last_dispatch_at = NOW() - INTERVAL '11 minutes'`);
    expect(await dispatchAfterWrite(db)).toBe(true);
    expect(dispatches()).toBe(2);
  });

  it("many instances writing at once still start exactly one run (the throttle lives in the database)", async () => {
    const db = await getPool();
    const results = await Promise.all(Array.from({ length: 8 }, () => dispatchAfterWrite(db)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(dispatches()).toBe(1);
  });

  it("every cache-clearing write goes through it: two invalidations on Vercel start one run", async () => {
    vi.stubEnv("VERCEL", "1");
    const db = await getPool();
    expect(await invalidateReportTotalsCache(db)).toBe(true);
    expect(await invalidateReportTotalsCache(db)).toBe(true);
    expect(dispatches()).toBe(1);
  });

  it("a failed dispatch never fails the write", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await invalidateReportTotalsCache(await getPool())).toBe(true);
  });
});

describe("long-running server: one pass at a time", () => {
  it("never starts a second pass while one is running", async () => {
    const db = await getPool();
    const gate = deferred();
    const pass = vi.fn(() => gate.promise);
    const first = runPrewarmPass(db, pass);
    expect(await runPrewarmPass(db, pass)).toBe(false); // refused, not queued
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await first).toBe(true);
    expect(await runPrewarmPass(db, async () => {})).toBe(true); // free again afterwards
  });

  it("a pass that throws still frees the guard", async () => {
    const db = await getPool();
    expect(await runPrewarmPass(db, async () => Promise.reject(new Error("scan failed")))).toBe(true);
    expect(await runPrewarmPass(db, async () => {})).toBe(true);
  });

  it("a write kicks a pass, at most once per 10 minutes, never alongside a running pass, and only where the timer runs", async () => {
    const db = await getPool();
    const pass = vi.fn(async () => {});
    expect(kickPrewarmAfterWrite(db, 0, pass)).toBe(false); // no timer (Vercel, tests): no-op
    expect(pass).not.toHaveBeenCalled();

    resetPrewarmPassStateForTests({ timerStarted: true });
    const t0 = 1_000_000;
    expect(kickPrewarmAfterWrite(db, t0, pass)).toBe(true);
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(1));
    expect(kickPrewarmAfterWrite(db, t0 + 9 * 60_000, pass)).toBe(false); // throttled
    expect(kickPrewarmAfterWrite(db, t0 + 10 * 60_000, pass)).toBe(true);
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2));

    // A pass already running (the timer's): the kick is skipped and doesn't use up the throttle.
    resetPrewarmPassStateForTests({ timerStarted: true });
    const gate = deferred();
    const running = runPrewarmPass(db, () => gate.promise);
    expect(kickPrewarmAfterWrite(db, t0, pass)).toBe(false);
    gate.resolve();
    await running;
    expect(kickPrewarmAfterWrite(db, t0 + 1, pass)).toBe(true);
  });
});
