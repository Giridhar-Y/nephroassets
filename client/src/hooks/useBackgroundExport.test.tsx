import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ExportJobStatus } from "../api/client.js";
import { useBackgroundExport } from "./useBackgroundExport.js";

vi.mock("../components/Toast.js", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../lib/NotificationsContext.js", () => ({ useNotifications: () => ({ addNotification: vi.fn() }) }));

const job = (processedRows: number, totalRows: number | null, status: ExportJobStatus["status"] = "PROCESSING"): ExportJobStatus => ({
  id: "j",
  status,
  totalRows,
  processedRows,
  fileUrl: null,
  errorMessage: null,
  createdAt: "",
  completedAt: null
});

describe("useBackgroundExport", () => {
  it("runs the fallback (the direct export) when the server has no background storage (503)", async () => {
    const fallback = vi.fn();
    const { result } = renderHook(() =>
      useBackgroundExport<Record<string, never>>({
        createJob: () => Promise.reject(new ApiError("storage not configured", 503)),
        fetchJob: vi.fn(),
        startingMessage: "",
        buildCompletedMessage: () => "",
        fallback
      })
    );
    await act(() => result.current.startExport({}));
    expect(fallback).toHaveBeenCalledOnce();
    expect(result.current.isExporting).toBe(false);
  });

  it("shows a percentage from the job's processed/total rows while it runs", async () => {
    const fetchJob = vi.fn().mockResolvedValue(job(250, 1000));
    const { result } = renderHook(() =>
      useBackgroundExport<Record<string, never>>({
        createJob: () => Promise.resolve({ jobId: "j" }),
        fetchJob,
        startingMessage: "",
        buildCompletedMessage: () => ""
      })
    );
    await act(() => result.current.startExport({}, 1000));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchJob).toHaveBeenCalled();
    expect(result.current.progressLabel).toBe("Exporting in background… 25%");
  });
});
