import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisposalModal } from "./DisposalModal.js";
import { ToastProvider } from "./Toast.js";
import type { AssetInput, AssetListItem } from "../lib/types.js";

function asset(overrides: Partial<AssetInput>): AssetListItem {
  const base: AssetInput = {
    farId: "X",
    subClassification: "Test-Sub",
    assetDescription: "Test Asset",
    serialNo: "",
    qty: 1,
    status: "Active",
    dateAcquired: "2020-01-01",
    location: "Center-A",
    revisedLocation: null,
    lastDateOfTransaction: null,
    parentFarId: null,
    disposedViaParentFarId: null,
    hasChildren: false,
    usefulLifeC1Years: 5,
    usefulLifeC2Years: 5,
    c1OpeningCost: 1000,
    c2OpeningCost: 0,
    additionsC1: 0,
    additionsC2: 0,
    dateOfAddition: null,
    dateOfDisposal: null,
    deletionsC1: 0,
    deletionsC2: 0,
    saleValue: 0,
    accDepC1Opening: 0,
    accDepC2Opening: 0,
    ...overrides
  };
  return {
    asset: base,
    result: {
      farId: base.farId,
      c1: { nbv: 500 } as AssetListItem["result"]["c1"],
      c2: {} as AssetListItem["result"]["c2"],
      effectiveLocation: base.location,
      lastDateOfTransaction: base.dateAcquired,
      assetProfitLossOnDisposal: null
    }
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const P1 = asset({ farId: "P1", assetDescription: "Parent Machine", hasChildren: true });
const C1 = asset({ farId: "C1", assetDescription: "Auto Child One", parentFarId: "P1" });
const C2 = asset({ farId: "C2", assetDescription: "Manually Added Child", parentFarId: "P1" });
const M1 = asset({ farId: "M1", assetDescription: "Standalone Asset" });

function routeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";

  if (url.startsWith("/api/assets?") && url.includes("search=P1")) {
    return Promise.resolve(jsonResponse({ items: [P1], nextCursor: null, asAt: "2026-01-01" }));
  }
  if (url.startsWith("/api/assets?") && url.includes("search=C2")) {
    return Promise.resolve(jsonResponse({ items: [C2], nextCursor: null, asAt: "2026-01-01" }));
  }
  if (url.startsWith("/api/assets?") && url.includes("search=M1")) {
    return Promise.resolve(jsonResponse({ items: [M1], nextCursor: null, asAt: "2026-01-01" }));
  }
  // AssetSelectionEditor's auto-include-children fetch: a parentFarId=equals condition.
  if (url.startsWith("/api/assets?") && url.includes("parentFarId")) {
    return Promise.resolve(jsonResponse({ items: [C1, C2], nextCursor: null, asAt: "2026-01-01" }));
  }
  if (url.includes("/disposal/preview")) {
    // Real server behavior: a child asset can't be previewed (or disposed) directly when
    // its parent is also in the batch — only a root gets its own call. A test mock that
    // accepted a preview for any FAR ID wouldn't have caught DisposalModal calling this
    // for children too.
    const farId = decodeURIComponent(url.split("/api/assets/")[1]!.split("/disposal")[0]!);
    if (farId === "C1" || farId === "C2") {
      return Promise.resolve(jsonResponse({ error: `This asset is a child of "P1" — dispose the parent instead.` }, false, 409));
    }
    return Promise.resolve(jsonResponse({ farId, c1Wdv: 500, c2Wdv: 0, totalWdv: 500, profitLoss: 0 }));
  }
  if (method === "PATCH" && url.includes("/disposal")) {
    const farId = decodeURIComponent(url.split("/api/assets/")[1]!.split("/disposal")[0]!);
    if (farId === "C1" || farId === "C2") {
      return Promise.resolve(jsonResponse({ error: `This asset is a child of "P1" — dispose the parent instead.` }, false, 409));
    }
    return Promise.resolve(jsonResponse({ farId, disposed: true, childrenDisposed: farId === "P1" ? ["C1", "C2"] : [] }));
  }
  throw new Error(`Unhandled fetch in test: ${method} ${url}`);
}

async function addBySearch(query: string, matchFarId: string) {
  const input = screen.getByPlaceholderText("Search FAR ID to add…");
  fireEvent.change(input, { target: { value: query } });
  const match = await screen.findByText(matchFarId, {}, { timeout: 1000 });
  fireEvent.click(match);
}

describe("DisposalModal — multi-select", () => {
  it("the Dispose button is disabled until at least one asset is added", () => {
    vi.stubGlobal("fetch", vi.fn(routeFetch));
    render(
      <ToastProvider>
        <DisposalModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );
    expect((screen.getByRole("button", { name: "Dispose" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adding a parent by search auto-includes its active children, each labeled with the relationship", async () => {
    vi.stubGlobal("fetch", vi.fn(routeFetch));
    render(
      <ToastProvider>
        <DisposalModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    await addBySearch("P1", "P1");

    await waitFor(() => expect(screen.getByText("C1")).toBeTruthy());
    expect(screen.getByText("C2")).toBeTruthy();
    expect(screen.getByText("Parent — 2 children included")).toBeTruthy();
    expect(screen.getAllByText("Child of P1")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Dispose" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removing the parent also removes the child it auto-added, but not one the user explicitly added first", async () => {
    vi.stubGlobal("fetch", vi.fn(routeFetch));
    render(
      <ToastProvider>
        <DisposalModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    // C2 is added explicitly FIRST — when P1 is added next, the auto-include fetch
    // returns [C1, C2] but C2 is already present, so only C1 gets marked auto-added.
    await addBySearch("C2", "C2");
    await addBySearch("P1", "P1");
    await waitFor(() => expect(screen.getByText("C1")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove P1"));

    // C1 (auto-added because of P1) is gone; C2 (explicitly added) survives.
    await waitFor(() => expect(screen.queryByText("P1")).toBeNull());
    expect(screen.queryByText("C1")).toBeNull();
    expect(screen.getByText("C2")).toBeTruthy();
  });

  it("submitting sends one disposal call per root and skips a child whose parent is also selected (cascade dedup)", async () => {
    const fetchMock = vi.fn(routeFetch);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ToastProvider>
        <DisposalModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    await addBySearch("P1", "P1");
    await waitFor(() => expect(screen.getByText("C1")).toBeTruthy());
    await addBySearch("M1", "M1");
    await waitFor(() => expect(screen.getByText("M1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Dispose" }));
    await waitFor(() => expect(screen.getByText("Confirm Disposal")).toBeTruthy());

    // Regression check: the preview step must only query roots (P1, M1) — previewing a
    // child (C1) directly is rejected server-side ("dispose the parent instead"), which
    // used to fail the whole Promise.all and surface that raw error here.
    await waitFor(() => {
      const previewCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("/disposal/preview"));
      expect(previewCalls).toHaveLength(2);
    });
    expect(screen.queryByText(/dispose the parent instead/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Confirm & Dispose/ }));
    await waitFor(() => {
      const disposalCalls = fetchMock.mock.calls.filter(
        ([url, init]) => (init as RequestInit | undefined)?.method === "PATCH" && (url as string).includes("/disposal")
      );
      expect(disposalCalls).toHaveLength(2); // P1 (root) and M1 (standalone) — not C1
    });
    const disposedFarIds = fetchMock.mock.calls
      .filter(([url, init]) => (init as RequestInit | undefined)?.method === "PATCH" && (url as string).includes("/disposal"))
      .map(([url]) => decodeURIComponent((url as string).split("/api/assets/")[1]!.split("/disposal")[0]!));
    expect(disposedFarIds.sort()).toEqual(["M1", "P1"]);
  });

  it("surfaces a server-rejected disposal (e.g. an out-of-scope center) as an inline error", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH" && url.includes("/disposal")) {
        return Promise.resolve(jsonResponse({ error: `No asset found with FAR ID "M1".` }, false, 404));
      }
      return routeFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ToastProvider>
        <DisposalModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    await addBySearch("M1", "M1");
    await waitFor(() => expect(screen.getByText("M1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dispose" }));
    await waitFor(() => expect(screen.getByText("Confirm Disposal")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Dispose/ }));

    await waitFor(() => expect(screen.getByText(/No asset found with FAR ID "M1"/)).toBeTruthy());
  });
});
