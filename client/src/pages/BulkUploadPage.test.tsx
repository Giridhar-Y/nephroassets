import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      message: "No asset found.",
      data: { farId: `FAR-${i}` }
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

  // Regression test for a follow-up report: virtualization must never make the tail of a
  // large file unreachable — a hard row cap, a stale `count`, or a query that only fetched
  // a subset would all look identical to the "fast, bounded DOM" test above (which only
  // proves rendering is windowed, not that the window covers the WHOLE file). The
  // scrollable range's total height is `count * rowHeight`, computed from the same
  // `previewRows` array the table reads from — independent of jsdom's inability to lay out
  // real pixels — so asserting it matches the full row count directly catches any bug that
  // silently shrinks what's actually scrollable to less than the full parsed dataset.
  it("keeps the full parsed row count scrollable, not just fast to render", async () => {
    const totalRows = 5000;
    const rows = Array.from({ length: totalRows }, (_, i) => ({
      row: i + 2,
      farId: `FAR-${i}`,
      status: "error" as const,
      message: "No asset found.",
      data: { farId: `FAR-${i}` }
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

    await waitFor(() => expect(screen.getByText(/out of 5000 rows/)).toBeTruthy());
    expect(screen.getByText(/Showing all 5000 rows/)).toBeTruthy();

    const ROW_HEIGHT = 28;
    const spacer = document.querySelector('[data-testid="bulk-preview-scroll-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe(`${totalRows * ROW_HEIGHT}px`);
  });
});

// Regression coverage for the fullscreen expand toggle: the inline and expanded views
// call the exact same render function (renderPreviewTable in BulkUploadPage.tsx) so they
// can never show different data, but the two are still separate DOM subtrees (unmount/
// remount, not mounted-but-hidden) — these tests catch a version where that render
// function silently diverges, or where the portal/listener/scroll-lock isn't cleaned up
// when leaving the expanded view.
describe("BulkUploadPage preview: expand to full screen", () => {
  async function renderSmallPreview() {
    const rows = [
      {
        row: 2,
        farId: "FAR-EXPAND-1",
        status: "new" as const,
        message: undefined,
        data: { farId: "FAR-EXPAND-1", toLocation: "Center-002", transactionDate: "2024-03-01" }
      },
      {
        row: 3,
        farId: "FAR-EXPAND-2",
        status: "error" as const,
        message: "No asset found.",
        data: { farId: "FAR-EXPAND-2", toLocation: "Center-003", transactionDate: "2024-03-02" }
      }
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ totalRows: 2, summary: { new: 1, update: 0, error: 1 }, rows }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/bulk-upload?type=transfers"]}>
        <ToastProvider>
          <BulkUploadPage />
        </ToastProvider>
      </MemoryRouter>
    );

    const file = new File(["farId,toLocation,transactionDate\n"], "small.csv", { type: "text/csv" });
    const input = document.querySelector("#bulk-file-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(screen.getByText(/out of 2 rows/)).toBeTruthy());
    return fetchMock;
  }

  afterEach(() => {
    // Belt-and-suspenders: a bug that skips the effect's cleanup would otherwise leak
    // the lock into the next test instead of failing this one.
    document.body.style.overflow = "";
  });

  it("expands into a fullscreen overlay showing the same table, then collapses back", async () => {
    await renderSmallPreview();
    // react-virtual never computes a nonzero range in jsdom (no real ResizeObserver — see
    // the virtualization describe block above), so individual row cells never mount here
    // either way; the column headers and the virtualizer's own scroll-height output don't
    // depend on that and are what this asserts stays identical across the toggle.
    expect(screen.getAllByTitle("toLocation").length).toBeGreaterThan(0);
    let spacer = document.querySelector('[data-testid="bulk-preview-scroll-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe("56px"); // 2 rows * 28px
    expect(document.body.style.overflow).not.toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /expand table to full screen/i }));

    // Same field columns and the same virtualized height — rendered by the same function,
    // not a second, potentially-stale copy.
    expect(screen.getAllByTitle("toLocation").length).toBeGreaterThan(0);
    spacer = document.querySelector('[data-testid="bulk-preview-scroll-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe("56px");
    expect(document.body.style.overflow).toBe("hidden");
    // Confirm/Cancel stay reachable without collapsing back first.
    expect(screen.getByRole("button", { name: /confirm upload/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /exit full screen/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /exit full screen/i }));

    expect(screen.getByRole("button", { name: /expand table to full screen/i })).toBeTruthy();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.getAllByTitle("toLocation").length).toBeGreaterThan(0);
  });

  it("closes on Escape and releases the body scroll lock", async () => {
    await renderSmallPreview();

    fireEvent.click(screen.getByRole("button", { name: /expand table to full screen/i }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: /expand table to full screen/i })).toBeTruthy();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  // Confirm Upload moves straight from "preview" to "result" without ever flipping
  // `expanded` back to false itself — the fullscreen view is meant to carry straight
  // through into the result step's own error table (one `expanded` flag serves both
  // steps) rather than snapping back to inline and losing the reviewer's place. This
  // asserts that handoff, and that the result step's own Collapse control (not just
  // Escape) actually leaves the overlay from there and releases the body scroll lock —
  // a real bug hit while building this: an effect keyed only on `expanded` never
  // re-ran on the step change, so its cleanup (removing the Escape listener, restoring
  // body.style.overflow) never fired even after the preview portal was long gone. The
  // fix keys the effect on `step` too.
  it("carries the fullscreen view from preview straight into the result step, and collapsing there releases the lock", async () => {
    const fetchMock = await renderSmallPreview();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        totalRows: 2,
        processed: 1,
        added: 1,
        updated: 0,
        errors: [{ row: 3, farId: "FAR-EXPAND-2", message: "No asset found." }]
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /expand table to full screen/i }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /confirm upload/i }));

    await waitFor(() => expect(screen.getByText(/row.*processed successfully/i)).toBeTruthy());
    // Still expanded — the result step's own error table, not a snap back to inline.
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: /exit full screen/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /exit full screen/i }));

    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("also expands the result step's own error table when reached without ever expanding the preview", async () => {
    const fetchMock = await renderSmallPreview();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        totalRows: 2,
        processed: 1,
        added: 1,
        updated: 0,
        errors: [{ row: 3, farId: "FAR-EXPAND-2", message: "No asset found." }]
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm upload/i }));
    await waitFor(() => expect(screen.getByText(/row.*processed successfully/i)).toBeTruthy());
    expect(document.body.style.overflow).not.toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /expand table to full screen/i }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
