import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage.js";
import type { DashboardSummary } from "../api/client.js";
import { formatCurrency, formatCurrencyCompact } from "../lib/format.js";

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

// FYTD and Since Inception deliberately differ (an extra prior-FY disposal folded into
// allTime only) so the scope toggle test below can prove it actually switches data, not
// just relabels the same numbers.
const SUMMARY: DashboardSummary = {
  asAt: "2026-08-17",
  totals: {
    grossBlock: 81066831400,
    openingGrossBlock: 79000000000,
    additionsFytd: 2066831400,
    closingAccDep: 21825665600,
    nbv: 59241165800,
    assetCount: 3018,
    qtyTotal: 3019
  },
  // Deliberately NOT 3018 (== totals.assetCount) — a status-count badge showing the same
  // number as the Asset Count tile would make "3018" ambiguous on the page and mask a
  // real duplicate-render bug behind a self-inflicted fixture collision.
  statusCounts: [
    { status: "Active", count: 3000 },
    { status: "Disposed", count: 18 }
  ],
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
      disposalCount: 5
    }
  },
  nbvTrend: [
    { asAt: "2025-12-31", nbv: 58000000000 },
    { asAt: "2026-06-30", nbv: 59241165800 }
  ],
  exceptions: {
    negativeNbv: EXCEPTION_ZERO,
    fullyDepreciatedActive: EXCEPTION_ZERO,
    pastUsefulLifeActive: EXCEPTION_ZERO,
    bigDisposalSwings: EXCEPTION_ZERO,
    missingData: EXCEPTION_ZERO
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function renderDashboard() {
  const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(SUMMARY));
  vi.stubGlobal("fetch", fetchMock);
  render(<DashboardPage />);
  await waitFor(() => expect(screen.getByText("3018")).toBeTruthy());
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

  it("requests the summary for asAt only — no center/subClassification query params", async () => {
    const fetchMock = await renderDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = fetchMock.mock.calls[0]![0] as string;
    expect(requestedUrl).toContain("asAt=2026-08-17");
    expect(requestedUrl).not.toContain("center=");
    expect(requestedUrl).not.toContain("subClassification=");
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
    const openingCompact = escapeRegExp(formatCurrencyCompact(SUMMARY.totals.openingGrossBlock));
    const additionsCompact = escapeRegExp(formatCurrencyCompact(SUMMARY.totals.additionsFytd));
    const openingEl = screen.getByText(new RegExp(`Opening ${openingCompact}`));
    const additionsEl = screen.getByText(new RegExp(`\\+Additions ${additionsCompact} FYTD`));
    expect(openingEl).toBeTruthy();
    expect(additionsEl).toBeTruthy();
    // Full-precision figure is still there, just moved to the title (hover/tap), not lost.
    expect(openingEl.title).toBe(formatCurrency(SUMMARY.totals.openingGrossBlock));
    expect(additionsEl.title).toBe(formatCurrency(SUMMARY.totals.additionsFytd));
  });

  it("shows FYTD Disposal P&L by default and switches to Since Inception via the toggle", async () => {
    await renderDashboard();
    // FYTD figures from SUMMARY.disposalPL.
    expect(screen.getByText("2 disposals")).toBeTruthy();
    expect(screen.getByText(new RegExp(`Gains ${escapeRegExp(formatCurrency(SUMMARY.disposalPL.gains))}`))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Since Inception" }));

    // allTime figures now shown instead — proves the toggle actually swaps data, not
    // just a label.
    expect(screen.getByText("5 disposals")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`Gains ${escapeRegExp(formatCurrency(SUMMARY.disposalPL.allTime.gains))}`))
    ).toBeTruthy();
    expect(screen.queryByText("2 disposals")).toBeNull();
  });

  it("always shows FYTD Deletions and Sale Proceeds regardless of the scope toggle", async () => {
    await renderDashboard();
    const deletions = new RegExp(`Deletions \\(Cost, FYTD\\) ${escapeRegExp(formatCurrency(SUMMARY.disposalPL.totalDeletions))}`);
    const proceeds = new RegExp(`Sale Proceeds \\(FYTD\\) ${escapeRegExp(formatCurrency(SUMMARY.disposalPL.saleProceeds))}`);
    expect(screen.getByText(deletions)).toBeTruthy();
    expect(screen.getByText(proceeds)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Since Inception" }));

    expect(screen.getByText(deletions)).toBeTruthy();
    expect(screen.getByText(proceeds)).toBeTruthy();
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
    const grossBlockEl = screen.getByText(formatCurrencyCompact(SUMMARY.totals.grossBlock));
    const accDepEl = screen.getByText(formatCurrencyCompact(SUMMARY.totals.closingAccDep));
    const nbvEl = screen.getByText(formatCurrencyCompact(SUMMARY.totals.nbv));

    expect(grossBlockEl.title).toBe(formatCurrency(SUMMARY.totals.grossBlock));
    expect(accDepEl.title).toBe(formatCurrency(SUMMARY.totals.closingAccDep));
    expect(nbvEl.title).toBe(formatCurrency(SUMMARY.totals.nbv));

    // The old full-precision strings should be nowhere in the visible text — only in
    // the title attributes just asserted above.
    expect(screen.queryByText(formatCurrency(SUMMARY.totals.grossBlock))).toBeNull();
    expect(screen.queryByText(formatCurrency(SUMMARY.totals.closingAccDep))).toBeNull();
    expect(screen.queryByText(formatCurrency(SUMMARY.totals.nbv))).toBeNull();
  });

  it("uses whitespace-nowrap, not truncate, on the KPI headline values", async () => {
    await renderDashboard();
    const nbvEl = screen.getByText(formatCurrencyCompact(SUMMARY.totals.nbv));
    expect(nbvEl.className).toContain("whitespace-nowrap");
    expect(nbvEl.className).not.toContain("truncate");
  });

  it("shows the Depreciation Run-Rate headline as compact currency too", async () => {
    await renderDashboard();
    const el = screen.getByText(formatCurrencyCompact(SUMMARY.depreciationFytd));
    expect(el.title).toBe(formatCurrency(SUMMARY.depreciationFytd));
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
