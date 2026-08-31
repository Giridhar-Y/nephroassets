import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransferModal } from "./TransferModal.js";
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
      c1: {} as AssetListItem["result"]["c1"],
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

const P1 = asset({ farId: "P1", assetDescription: "Parent Machine", hasChildren: true, location: "Center-A" });
const C1 = asset({ farId: "C1", assetDescription: "Child Accessory", parentFarId: "P1", location: "Center-A" });
const M1 = asset({ farId: "M1", assetDescription: "Standalone Asset", location: "Center-B" });

function routeFetch(url: string): Promise<Response> {
  if (url === "/api/meta/centers") {
    return Promise.resolve(jsonResponse(["Center-A", "Center-B", "Center-C"]));
  }
  if (url.startsWith("/api/assets?") && url.includes("search=P1")) {
    return Promise.resolve(jsonResponse({ items: [P1], nextCursor: null, asAt: "2026-01-01" }));
  }
  if (url.startsWith("/api/assets?") && url.includes("search=M1")) {
    return Promise.resolve(jsonResponse({ items: [M1], nextCursor: null, asAt: "2026-01-01" }));
  }
  if (url.startsWith("/api/assets?") && url.includes("parentFarId")) {
    return Promise.resolve(jsonResponse({ items: [C1], nextCursor: null, asAt: "2026-01-01" }));
  }
  throw new Error(`Unhandled fetch in test: ${url}`);
}

async function addBySearch(query: string, matchFarId: string) {
  const input = screen.getByPlaceholderText("Search FAR ID to add…");
  fireEvent.change(input, { target: { value: query } });
  const match = await screen.findByText(matchFarId, {}, { timeout: 1000 });
  fireEvent.click(match);
}

describe("TransferModal — multi-select", () => {
  it("the Transfer button is disabled until at least one asset is added", async () => {
    vi.stubGlobal("fetch", vi.fn(routeFetch));
    render(
      <ToastProvider>
        <TransferModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );
    await waitFor(() => expect(screen.getByText("Center-A")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Transfer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adding a parent auto-includes its active children, and submits a batched call with every FAR ID", async () => {
    const fetchMock = vi.fn(
      (url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "POST" && url === "/api/transfers"
          ? Promise.resolve(jsonResponse({ transferred: 2, childrenIncluded: ["C1"] }))
          : routeFetch(url)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ToastProvider>
        <TransferModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    await addBySearch("P1", "P1");
    await waitFor(() => expect(screen.getByText("C1")).toBeTruthy());
    expect(screen.getByText("Parent — 1 child included")).toBeTruthy();
    expect(screen.getByText("Child of P1")).toBeTruthy();

    const destinationSelect = screen.getByLabelText("Destination Center") as HTMLSelectElement;
    fireEvent.change(destinationSelect, { target: { value: "Center-C" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(screen.getByText("Confirm Transfer")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Confirm & Transfer/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/transfers");
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.farIds.sort()).toEqual(["C1", "P1"]);
      expect(body.toLocation).toBe("Center-C");
    });
  });

  it("surfaces a batch center-scope rejection from the server as an inline error", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && url === "/api/transfers") {
        return Promise.resolve(jsonResponse({ error: `No asset found with FAR ID "M1".` }, false, 404));
      }
      return routeFetch(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ToastProvider>
        <TransferModal assets={[]} asAt="2026-01-01" defaultDate="2026-01-01" onClose={() => {}} onDone={() => {}} />
      </ToastProvider>
    );

    await addBySearch("M1", "M1");
    await waitFor(() => expect(screen.getByText("M1")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Destination Center"), { target: { value: "Center-C" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(screen.getByText("Confirm Transfer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Transfer/ }));

    await waitFor(() => expect(screen.getByText(/No asset found with FAR ID "M1"/)).toBeTruthy());
  });
});
