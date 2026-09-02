import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useExport } from "./useExport.js";
import { ToastProvider } from "../components/Toast.js";

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

function okResponse(filename: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "Content-Disposition" ? `attachment; filename="${filename}"` : null) },
    blob: async () => new Blob(["fake xlsx bytes"])
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useExport", () => {
  it("does nothing when url is undefined — no fetch, exporting never flips true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useExport(undefined), { wrapper });

    await act(async () => {
      await result.current.runExport();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.exporting).toBe(false);
  });

  it("fetches and downloads the file, toggling `exporting` for the duration", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse("far-export.xlsx"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });

    const { result } = renderHook(() => useExport("/api/assets/export"), { wrapper });
    expect(result.current.exporting).toBe(false);

    await act(async () => {
      await result.current.runExport();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/assets/export");
    expect(result.current.exporting).toBe(false);
  });

  // The guard this Ctrl+Shift+E (RegisterPage) and the Export button both rely on to
  // never race each other (see ExportButton's exporting/onExport props) — a re-trigger
  // while one export is already in flight must not fetch a second time.
  it("guards against re-entrancy: re-triggering while an export is already in flight does not fetch again", async () => {
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });

    const { result } = renderHook(() => useExport("/api/assets/export"), { wrapper });

    act(() => {
      result.current.runExport(); // starts; leaves `exporting` true with the fetch still pending
    });
    expect(result.current.exporting).toBe(true);

    // Re-triggering now (the same guard a shortcut fired right after a button click, or
    // vice versa, would hit) must not issue a second fetch.
    await act(async () => {
      await result.current.runExport();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(okResponse("far-export.xlsx"));
      await pending;
    });
    expect(result.current.exporting).toBe(false);
  });

  it("surfaces a friendly error via toast and clears `exporting` when the fetch itself fails", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExport("/api/assets/export"), { wrapper });

    await act(async () => {
      await result.current.runExport();
    });

    expect(result.current.exporting).toBe(false); // not left stuck "exporting" after a failure
  });
});
