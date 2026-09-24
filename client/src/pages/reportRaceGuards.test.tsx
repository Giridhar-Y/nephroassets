import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCurrency } from "../lib/format.js";

// Review finding 2026-09-24: Register Summary, Depreciation Posting and Location Summary
// set state from whichever response arrived last. Rapid date reversal (A → B → back to
// A) with B's response arriving LAST must still end on A's figures.

vi.mock("../lib/SettingsContext.js", () => ({
  useSettings: () => ({ settings: { asAt: "2026-09-24", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 } })
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const pending = new Map<string, Deferred<unknown>[]>();
function nextFor(key: string) {
  const d = deferred<unknown>();
  pending.set(key, [...(pending.get(key) ?? []), d]);
  return d.promise;
}

// The export button pulls in app-level providers (toasts, notifications) irrelevant here.
vi.mock("../components/ui/ExportButton.js", () => ({ ExportButton: () => null }));

vi.mock("../api/client.js", () => ({
  fetchDepreciationPosting: (asAt: string) => nextFor(`dep:${asAt}`),
  fetchRegisterSummary: (f: { dateAcquiredFrom?: string }) => nextFor(`sum:${f.dateAcquiredFrom ?? ""}`),
  fetchCenters: async () => [],
  fetchSubClassifications: async () => [],
  fetchStatuses: async () => [],
  getRegisterSummaryExportUrl: () => "",
  getDepreciationPostingExportUrl: () => ""
}));

afterEach(() => {
  cleanup();
  pending.clear();
});

const posting = (total: number) => ({ asAt: "x", totalPeriodDepreciation: total, breakdown: [] });

describe("Depreciation Posting: rapid date reversal", () => {
  it("A → B → A with B's slow response arriving last still shows A's total", async () => {
    const { DepreciationPostingPage } = await import("./DepreciationPostingPage.js");
    render(<DepreciationPostingPage />);
    await act(async () => {});
    const input = document.getElementById("dep-date") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "2026-06-30" } }); // B
    fireEvent.change(input, { target: { value: "2026-09-24" } }); // back to A

    const [firstA, secondA] = pending.get("dep:2026-09-24")!;
    const [b] = pending.get("dep:2026-06-30")!;
    await act(async () => secondA!.resolve(posting(111)));
    await act(async () => b!.resolve(posting(999))); // stale, arrives last
    await act(async () => firstA!.resolve(posting(555))); // stale too

    expect(screen.getAllByText(formatCurrency(111)).length).toBeGreaterThan(0);
    expect(screen.queryByText(formatCurrency(999))).toBeNull();
    expect(screen.queryByText(formatCurrency(555))).toBeNull();
  });
});

describe("Register Summary: rapid filter reversal", () => {
  const summary = (assetCount: number) => ({
    asAt: "2026-09-24",
    columns: [],
    groups: [{ subClassification: "S", status: "Active", location: "L", assetCount }],
    grandTotal: { assetCount },
    filterSummaryText: ""
  });

  it("filter B's slow response arriving after the reverted filter's response doesn't overwrite it", async () => {
    const { RegisterSummaryPage } = await import("./RegisterSummaryPage.js");
    render(<RegisterSummaryPage />);
    await act(async () => {});
    const from = document.getElementById("summary-date-from") as HTMLInputElement;

    fireEvent.change(from, { target: { value: "2020-01-01" } }); // B
    fireEvent.change(from, { target: { value: "" } }); // back to no filter

    const [, latest] = pending.get("sum:")!;
    const [b] = pending.get("sum:2020-01-01")!;
    await act(async () => latest!.resolve(summary(4242)));
    await act(async () => b!.resolve(summary(7)));

    expect(screen.getAllByText("4242").length).toBeGreaterThan(0);
    expect(screen.queryByText("7")).toBeNull();
  });
});
