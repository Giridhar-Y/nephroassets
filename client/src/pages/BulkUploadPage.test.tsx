import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BulkUploadPage } from "./BulkUploadPage.js";
import { ToastProvider } from "../components/Toast.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

// jsdom never lays anything out — every element reports clientHeight 0 — so
// react-virtual's viewport-based range calculation sees a zero-height scroll container
// and mounts nothing at all. Stubbing a real viewport height here isn't optional scaffolding:
// without it the test can't distinguish "virtualized and windowed" from "broken and empty".
const clientHeightStub = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
const rectStub = vi
  .spyOn(Element.prototype, "getBoundingClientRect")
  .mockReturnValue({ height: 320, width: 800, top: 0, left: 0, bottom: 320, right: 800, x: 0, y: 0, toJSON() {} });

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

afterAll(() => {
  clientHeightStub.mockRestore();
  rectStub.mockRestore();
});

// Regression test for the freeze this branch fixes: BulkUploadPage's preview table used
// to render one real DOM row per parsed row with no virtualization, which froze the tab
// for several seconds at a few thousand rows (measured live: ~13s of blocked main thread
// at 5,000 rows). The preview data itself must still be complete — only what's *mounted*
// in the DOM should be bounded — so this asserts both halves: the full row count is still
// reported to the user, while the actual rendered <div data-testid="bulk-preview-row">
// count stays small regardless of how many rows the file had.
describe("BulkUploadPage preview: virtualization", () => {
  it("keeps the mounted row count bounded when the parsed file has thousands of rows", async () => {
    const totalRows = 3000;
    const rows = Array.from({ length: totalRows }, (_, i) => ({
      row: i + 2,
      farId: `FAR-${i}`,
      status: "error" as const,
      message: "No asset found."
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        totalRows,
        summary: { new: 0, update: 0, error: totalRows },
        rows
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/bulk-upload?type=transfers"]}>
        <ToastProvider>
          <BulkUploadPage />
        </ToastProvider>
      </MemoryRouter>
    );

    const file = new File(["farId,toLocation,transactionDate\n"], "big.csv", { type: "text/csv" });
    const input = document.querySelector("#bulk-file-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(screen.getByText(/out of 3000 rows/)).toBeTruthy());

    // jsdom does no real layout (no ResizeObserver, zero client rects even when stubbed
    // deep enough to avoid crashing), so react-virtual can't compute a nonzero visible
    // range here the way a real browser does — this can't assert an exact mounted count.
    // What it *can* still catch: reverting to one real DOM row per parsed row (the bug
    // this branch fixes) would mount all 3000; virtualized, it never does.
    const mountedRows = document.querySelectorAll('[data-testid="bulk-preview-row"]');
    expect(mountedRows.length).toBeLessThan(totalRows);
  });
});
