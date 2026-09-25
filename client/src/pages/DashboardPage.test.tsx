import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage.js";
import type { DashboardFastSummary, DashboardTotals, DashboardTrend } from "../api/client.js";
import { formatCurrency, formatCurrencyCompact, formatDateTime } from "../lib/format.js";

// Expected currency text always comes from the app's own formatCurrency, never
// hand-typed — Intl's actual digit grouping for large values isn't the plain
// lakh/crore grouping you'd get by eye (currencySign: "accounting" changes it), so a
// hand-typed expectation would be guessing at ICU behavior instead of testing against it.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// DashboardPage only reads settings.asAt — mocking the hook directly (rather than
// wrapping in the real SettingsProvider, which itself needs AuthProvider and its own
// /api/auth/me + /api/settings fetches) keeps this test scoped to DashboardPage's own
// logic, the same way BulkUploadPage.test.tsx doesn't drag in unrelated providers either.
vi.mock("../lib/SettingsContext.js", () => ({
  useSettings: () => ({
    settings: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
  })
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const EXCEPTION_ZERO = { count: 0 };

// Since 2026-09-05, DashboardPage fetches 3 independent pieces in sequence (fast
// summary, totals, trend — see api/client.ts's own comment) instead of one combined
// response. Split into 3 fixtures matching that.
const FAST: DashboardFastSummary = {
  asAt: "2026-08-17",
  totals: { assetCount: 3018, qtyTotal: 3019 },
  // Deliberately NOT 3018 (== totals.assetCount) — a status-count badge showing the same
  // number as the Asset Count tile would make "3018" ambiguous on the page and mask a
  // real duplicate-render bug behind a self-inflicted fixture collision.
  statusCounts: [
    { status: "Active", count: 3000 },
    { status: "Disposed", count: 18 }
  ]
};

// FYTD and Since Inception deliberately differ (an extra prior-FY disposal folded into
// allTime only) so the scope toggle test below can prove it actually switches data, not
// just relabels the same numbers.
const TOTALS: DashboardTotals = {
  totals: {
    grossBlock: 81066831400,
    openingGrossBlock: 79000000000,
    additionsFytd: 2066831400,
    closingAccDep: 21825665600,
    nbv: 59241165800
  },
  depreciationFytd: 5000000,
  disposalPL: {
    gains: 100000,
    losses: -20000,
    disposalCount: 2,
    totalDeletions: 300000,
    saleProceeds: 380000,
    allTime: {
      gains: 250000,
      losses: -80000,
      disposalCount: 5,
      totalDeletions: 900000,
      saleProceeds: 1100000
    }
  },
  exceptions: {
    negativeNbv: EXCEPTION_ZERO,
    fullyDepreciatedActive: EXCEPTION_ZERO,
    pastUsefulLifeActive: EXCEPTION_ZERO,
    bigDisposalSwings: EXCEPTION_ZERO,
    missingData: { count: 213853 }
  },
  computedAt: "2026-09-23T08:30:00.000Z"
};

const TREND: DashboardTrend = {
  nbvTrend: [
    { asAt: "2025-12-31", nbv: 58000000000 },
    { asAt: "2026-06-30", nbv: 59241165800 }
  ],
  computedAt: "2026-09-23T08:15:00.000Z"
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function renderDashboard() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("dashboard-totals")) return Promise.resolve(jsonResponse(TOTALS));
    if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
    if (url.includes("dashboard-summary")) return Promise.resolve(jsonResponse(FAST));
    throw new Error(`renderDashboard: unexpected fetch URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<DashboardPage />);
  // Waits for all 3 pieces (sequential, not concurrent — see DashboardPage.tsx's own
  // comment) to have arrived, not just the first — most existing assertions below read
  // totals/trend-derived text that only renders once its own piece loads.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeTruthy());
  return fetchMock;
}

describe("DashboardPage: Center/Sub Classification filters removed", () => {
  it("renders no Center or Sub Classification picker", async () => {
    await renderDashboard();
    expect(screen.queryByLabelText("Center")).toBeNull();
    expect(screen.queryByLabelText("Sub Classification")).toBeNull();
    expect(screen.queryByText("All Centers")).toBeNull();
    expect(screen.queryByText("All Sub Classifications")).toBeNull();
  });

  it("requests all 3 pieces for asAt only — no center/subClassification query params", async () => {
    const fetchMock = await renderDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/reports/dashboard-summary"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/reports/dashboard-totals"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/reports/dashboard-trend"))).toBe(true);
    for (const url of urls) {
      expect(url).toContain("asAt=2026-08-17");
      expect(url).not.toContain("center=");
      expect(url).not.toContain("subClassification=");
    }
  });

  // The whole point of splitting the endpoint (see DashboardPage.tsx's own comment):
  // the two slow requests must never fire concurrently with each other, so they never
  // compete for the same database CPU the way the pre-split combined query did.
  it("fetches the 3 pieces in sequence, never firing totals and trend concurrently", async () => {
    const callOrder: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callOrder.push(url);
      if (url.includes("dashboard-totals")) return Promise.resolve(jsonResponse(TOTALS));
      if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
      return Promise.resolve(jsonResponse(FAST));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(callOrder[0]).toContain("dashboard-summary");
    expect(callOrder[1]).toContain("dashboard-totals");
    expect(callOrder[2]).toContain("dashboard-trend");
  });
});

describe("DashboardPage: new KPI fields", () => {
  it("shows total Qty alongside Asset Count as a distinct figure", async () => {
    await renderDashboard();
    expect(screen.getByText("3018")).toBeTruthy();
    expect(screen.getByText(/Σ Qty:\s*3,019/)).toBeTruthy();
  });

  it("shows the Opening + Additions breakdown under Gross Block, compact but with full precision on hover", async () => {
    await renderDashboard();
    const openingCompact = escapeRegExp(formatCurrencyCompact(TOTALS.totals.openingGrossBlock));
    const additionsCompact = escapeRegExp(formatCurrencyCompact(TOTALS.totals.additionsFytd));
    const openingEl = screen.getByText(new RegExp(`Opening ${openingCompact}`));
    const additionsEl = screen.getByText(new RegExp(`\\+Additions ${additionsCompact} FYTD`));
    expect(openingEl).toBeTruthy();
    expect(additionsEl).toBeTruthy();
    // Full-precision figure is still there, just moved to the title (hover/tap), not lost.
    expect(openingEl.title).toBe(formatCurrency(TOTALS.totals.openingGrossBlock));
    expect(additionsEl.title).toBe(formatCurrency(TOTALS.totals.additionsFytd));
  });

  it("shows FYTD Disposal P&L by default and switches to Since Inception via the toggle", async () => {
    await renderDashboard();
    // FYTD figures from TOTALS.disposalPL.
    expect(screen.getByText("2 disposals")).toBeTruthy();
    expect(screen.getByText(new RegExp(`Gains ${escapeRegExp(formatCurrency(TOTALS.disposalPL.gains))}`))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Since Inception" }));

    // allTime figures now shown instead — proves the toggle actually swaps data, not
    // just a label.
    expect(screen.getByText("5 disposals")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`Gains ${escapeRegExp(formatCurrency(TOTALS.disposalPL.allTime.gains))}`))
    ).toBeTruthy();
    expect(screen.queryByText("2 disposals")).toBeNull();
  });

  it("switches Deletions and Sale Proceeds with the scope toggle too", async () => {
    await renderDashboard();
    const deletions = (v: number) => new RegExp(`Deletions \\(Cost\\) ${escapeRegExp(formatCurrency(v))}`);
    const proceeds = (v: number) => new RegExp(`Sale Proceeds ${escapeRegExp(formatCurrency(v))}`);
    expect(screen.getByText(deletions(TOTALS.disposalPL.totalDeletions))).toBeTruthy();
    expect(screen.getByText(proceeds(TOTALS.disposalPL.saleProceeds))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Since Inception" }));

    expect(screen.getByText(deletions(TOTALS.disposalPL.allTime.totalDeletions))).toBeTruthy();
    expect(screen.getByText(proceeds(TOTALS.disposalPL.allTime.saleProceeds))).toBeTruthy();
  });
});

// Regression coverage for a real display bug: the KPI tiles' headline values used to
// render formatCurrency's full-precision string (e.g. "₹81,06,68,314") at text-3xl/text-xl
// inside a narrow grid-cols-4 card with `truncate` — genuinely wide enough to overflow and
// get silently clipped, which reads as a wrong number rather than a display bug. These
// assert the compact string is what's actually shown, and that the full-precision figure
// is still reachable (via `title`), not simply dropped.
describe("DashboardPage: KPI headline values are compact, not full-precision", () => {
  it("shows Gross Block, Accumulated Depreciation, and Net Block as compact currency", async () => {
    await renderDashboard();
    const grossBlockEl = screen.getByText(formatCurrencyCompact(TOTALS.totals.grossBlock));
    const accDepEl = screen.getByText(formatCurrencyCompact(TOTALS.totals.closingAccDep));
    const nbvEl = screen.getByText(formatCurrencyCompact(TOTALS.totals.nbv));

    expect(grossBlockEl.title).toBe(formatCurrency(TOTALS.totals.grossBlock));
    expect(accDepEl.title).toBe(formatCurrency(TOTALS.totals.closingAccDep));
    expect(nbvEl.title).toBe(formatCurrency(TOTALS.totals.nbv));

    // The old full-precision strings should be nowhere in the visible text — only in
    // the title attributes just asserted above.
    expect(screen.queryByText(formatCurrency(TOTALS.totals.grossBlock))).toBeNull();
    expect(screen.queryByText(formatCurrency(TOTALS.totals.closingAccDep))).toBeNull();
    expect(screen.queryByText(formatCurrency(TOTALS.totals.nbv))).toBeNull();
  });

  it("uses whitespace-nowrap, not truncate, on the KPI headline values", async () => {
    await renderDashboard();
    const nbvEl = screen.getByText(formatCurrencyCompact(TOTALS.totals.nbv));
    expect(nbvEl.className).toContain("whitespace-nowrap");
    expect(nbvEl.className).not.toContain("truncate");
  });

  it("shows the Depreciation Run-Rate headline as compact currency too", async () => {
    await renderDashboard();
    const el = screen.getByText(formatCurrencyCompact(TOTALS.depreciationFytd));
    expect(el.title).toBe(formatCurrency(TOTALS.depreciationFytd));
  });
});

// Regression coverage for the removed By Sub Classification / By Location panels — both
// the panels themselves and the fields that fed them (subClassificationBreakdown/
// locationBreakdown) are gone from the page and the DashboardSummary type.
describe("DashboardPage: Sub Classification/Location breakdown panels removed", () => {
  it("renders neither breakdown panel", async () => {
    await renderDashboard();
    expect(screen.queryByText(/By Sub Classification/)).toBeNull();
    expect(screen.queryByText(/By Location/)).toBeNull();
  });
});

describe("DashboardPage: header, Missing Data tile, refresh and loading", () => {
  it("has no page title/subtitle and no Missing Data tile, but keeps the other 4 exception tiles", async () => {
    await renderDashboard();
    expect(screen.queryByText("Finance FAR Dashboard")).toBeNull();
    expect(screen.queryByText(/single-screen overview/)).toBeNull();
    expect(screen.queryByText("Missing Data")).toBeNull();
    expect(screen.queryByText("213853")).toBeNull();
    for (const label of ["Negative NBV", "Fully Depreciated, Still Active", "Past Useful Life, Still Active", "Big Disposal Swings (> ₹1L)"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the older cached timestamp as Last updated", async () => {
    await renderDashboard();
    expect(screen.getByText(new RegExp(`^Last updated: ${escapeRegExp(formatDateTime(TREND.computedAt))} · checked `))).toBeTruthy();
  });

  it("Refresh re-fetches all 3 pieces and never shows the old figures while the new ones load", async () => {
    const fetchMock = await renderDashboard();
    let releaseTotals!: () => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("dashboard-totals"))
        return new Promise((resolve) => (releaseTotals = () => resolve(jsonResponse(TOTALS))));
      if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
      return Promise.resolve(jsonResponse(FAST));
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    // Totals request is in flight: the old Gross Block must not be on screen.
    expect(screen.queryByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();

    releaseTotals();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(screen.getByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeTruthy());
  });
});

describe("DashboardPage: a failed request resolves to an error state, never an endless skeleton", () => {
  it("dashboard-totals 504 → figures show as unavailable, header says so, and the timeout isn't retried", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("dashboard-totals"))
        return Promise.resolve({ ok: false, status: 504, json: async () => ({ error: "Gateway Timeout" }) } as Response);
      if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
      return Promise.resolve(jsonResponse(FAST));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText(/^Some figures couldn't load · tried at /)).toBeTruthy());
    expect(fetchMock.mock.calls.filter((c) => (c[0] as string).includes("dashboard-totals"))).toHaveLength(1);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3); // Gross Block, Acc Dep, Net Block
    // Pieces that did load still render — the trend and asset count aren't held hostage.
    expect(screen.getByText(String(FAST.totals.assetCount))).toBeTruthy();
    expect(screen.getByText("Net Block Trend")).toBeTruthy();
  });

  it("Refresh after a failure re-fires the requests and visibly shows the new attempt time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-24T06:00:00Z"));
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("dashboard-totals"))
          return Promise.resolve({ ok: false, status: 504, json: async () => ({ error: "Gateway Timeout" }) } as Response);
        if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
        return Promise.resolve(jsonResponse(FAST));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<DashboardPage />);

      const first = `tried at ${new Date("2026-09-24T06:00:00Z").toLocaleTimeString("en-IN")}`;
      await waitFor(() => expect(screen.getByText(new RegExp(escapeRegExp(first)))).toBeTruthy());

      vi.setSystemTime(new Date("2026-09-24T06:01:07Z"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

      const second = `tried at ${new Date("2026-09-24T06:01:07Z").toLocaleTimeString("en-IN")}`;
      await waitFor(() => expect(screen.getByText(new RegExp(escapeRegExp(second)))).toBeTruthy());
      expect(fetchMock.mock.calls.filter((c) => (c[0] as string).includes("dashboard-totals"))).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DashboardPage: a date that isn't cached yet (202 preparing on Vercel)", () => {
  it("shows the Preparing banner with no error, polls every 15s, and loads automatically once ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let totalsReady = false;
      const preparing = { ok: true, status: 202, json: async () => ({ status: "preparing", asAt: "2026-08-17" }) } as Response;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("dashboard-totals")) return Promise.resolve(totalsReady ? jsonResponse(TOTALS) : preparing);
        if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse(TREND));
        return Promise.resolve(jsonResponse(FAST));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<DashboardPage />);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getByText(/Preparing figures for 17-08-2026\. Dates not viewed recently take about 2–4 minutes\./)).toBeTruthy();
      expect(screen.queryByText(/couldn't load/)).toBeNull();
      expect(screen.queryByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeNull(); // skeleton, not a number

      totalsReady = true;
      await act(() => vi.advanceTimersByTimeAsync(15_000));

      expect(fetchMock.mock.calls.filter((c) => (c[0] as string).includes("dashboard-totals"))).toHaveLength(2);
      expect(screen.getByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeTruthy();
      expect(screen.queryByText(/Preparing figures/)).toBeNull();
      expect(screen.getByText(new RegExp(`^Last updated: ${escapeRegExp(formatDateTime(TREND.computedAt))} · checked `))).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DashboardPage: Refresh after a data change reflects it", () => {
  it("shows the new figures and computedAt, and the 'checked' time moves even when nothing changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-25T06:00:00Z"));
      let current: DashboardTotals = TOTALS;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("dashboard-totals")) return Promise.resolve(jsonResponse(current));
        if (url.includes("dashboard-trend")) return Promise.resolve(jsonResponse({ ...TREND, computedAt: current.computedAt }));
        return Promise.resolve(jsonResponse(FAST));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<DashboardPage />);
      await waitFor(() => expect(screen.getByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeTruthy());
      const checked1 = new Date("2026-09-25T06:00:00Z").toLocaleTimeString("en-IN");
      expect(screen.getByText(new RegExp(`· checked ${escapeRegExp(checked1)}$`))).toBeTruthy();

      // Nothing changed: Refresh still visibly registers (the checked time moves).
      vi.setSystemTime(new Date("2026-09-25T06:02:10Z"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      const checked2 = new Date("2026-09-25T06:02:10Z").toLocaleTimeString("en-IN");
      await waitFor(() => expect(screen.getByText(new RegExp(`· checked ${escapeRegExp(checked2)}$`))).toBeTruthy());

      // The data changed (the server recomputed): Refresh shows the new figures and time.
      current = {
        ...TOTALS,
        totals: { ...TOTALS.totals, grossBlock: 99_000_000_000 },
        computedAt: "2026-09-25T06:05:00.000Z"
      };
      vi.setSystemTime(new Date("2026-09-25T06:05:30Z"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByText(formatCurrencyCompact(99_000_000_000))).toBeTruthy());
      expect(screen.queryByText(formatCurrencyCompact(TOTALS.totals.grossBlock))).toBeNull();
      expect(screen.getByText(new RegExp(`^Last updated: ${escapeRegExp(formatDateTime("2026-09-25T06:05:00.000Z"))}`))).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
