import { useCallback, useState } from "react";
import { createExportJob, fetchExportJob } from "../api/client.js";
import type { AssetFilters } from "../lib/types.js";
import { useToast } from "../components/Toast.js";
import { useNotifications } from "../lib/NotificationsContext.js";

// How often the poll checks in — also, per assetsExportJobs.ts's own design, what
// actually drives the export forward: each GET .../jobs/:id call advances the job by one
// bounded slice of work server-side before responding (see that file's advanceExportJob).
// Vercel serverless has no background worker to fall back on, so this poll IS the
// "background" — closing the tab entirely pauses progress until it's reopened and this
// hook starts polling again; a best-effort server-side self-nudge covers most of that
// gap, but it's not guaranteed (see assetsExportJobs.ts's fireSelfNudge).
const POLL_INTERVAL_MS = 4000;

/** Register's "Export to Excel", for a request too large for the synchronous route (see
 *  RegisterPage.tsx's own threshold check) — starts a background job and lets it run via
 *  polling, surfacing completion/failure through the existing Notification Bell instead
 *  of blocking on a single long-lived fetch. */
export function useBackgroundExport() {
  const { showToast } = useToast();
  const { addNotification } = useNotifications();
  const [starting, setStarting] = useState(false);

  const startExport = useCallback(
    async (params: { asAt: string } & AssetFilters) => {
      if (starting) return;
      setStarting(true);
      try {
        const { jobId } = await createExportJob(params);
        showToast("Large export started in the background — you'll get a notification when it's ready.");
        pollExportJob(jobId, addNotification);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Could not start the export.", "error");
      } finally {
        setStarting(false);
      }
    },
    [starting, showToast, addNotification]
  );

  return { starting, startExport };
}

function pollExportJob(jobId: string, addNotification: ReturnType<typeof useNotifications>["addNotification"]): void {
  const tick = async () => {
    let job;
    try {
      job = await fetchExportJob(jobId);
    } catch {
      setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    if (job.status === "COMPLETED") {
      addNotification(`Register export ready (${job.processedRows.toLocaleString()} rows).`, "success", {
        link: job.fileUrl ?? undefined,
        linkLabel: "Download CSV"
      });
      return;
    }
    if (job.status === "FAILED") {
      addNotification(job.errorMessage ?? "Background export failed.", "error");
      return;
    }
    setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}
