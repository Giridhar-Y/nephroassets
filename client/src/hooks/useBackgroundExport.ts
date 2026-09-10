import { useCallback, useRef, useState } from "react";
import type { ExportJobStatus } from "../api/client.js";
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

/** A filtered export too large for its screen's synchronous route (RegisterPage.tsx,
 *  ActivityLogPage.tsx) — starts a background job and lets it run via polling, surfacing
 *  completion/failure through the existing Notification Bell instead of blocking on a
 *  single long-lived fetch. Generic over `TParams` (each screen POSTs its own filter
 *  shape) and takes its create/fetch calls and notification copy as config rather than
 *  hardcoding Register's — the polling/retry/notification logic itself is identical
 *  either way, only which two API functions and what text differ. */
export function useBackgroundExport<TParams>(config: {
  createJob: (params: TParams) => Promise<{ jobId: string }>;
  fetchJob: (jobId: string) => Promise<ExportJobStatus>;
  startingMessage: string;
  /** Built from the completed job so the row count in the notification is always the
   *  real, final processedRows — never a stale count captured before the job ran. */
  buildCompletedMessage: (job: ExportJobStatus) => string;
  downloadLabel?: string;
}) {
  const { showToast } = useToast();
  const { addNotification } = useNotifications();
  const [starting, setStarting] = useState(false);

  // RegisterPage/ActivityLogPage build `config` as a fresh object literal every render
  // (startingMessage in particular often embeds a just-computed row count) — a ref
  // instead of a useCallback dependency means startExport always sees the LATEST config
  // without needing to recreate itself (and without the classic stale-closure bug a
  // memoized callback capturing an old `config` would have).
  const configRef = useRef(config);
  configRef.current = config;

  const startExport = useCallback(async (params: TParams) => {
    if (starting) return;
    setStarting(true);
    try {
      const { jobId } = await configRef.current.createJob(params);
      showToast(configRef.current.startingMessage);
      pollExportJob(jobId, configRef.current, addNotification);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not start the export.", "error");
    } finally {
      setStarting(false);
    }
  }, [starting, showToast, addNotification]);

  return { starting, startExport };
}

function pollExportJob(
  jobId: string,
  config: {
    fetchJob: (jobId: string) => Promise<ExportJobStatus>;
    buildCompletedMessage: (job: ExportJobStatus) => string;
    downloadLabel?: string;
  },
  addNotification: ReturnType<typeof useNotifications>["addNotification"]
): void {
  const tick = async () => {
    let job;
    try {
      job = await config.fetchJob(jobId);
    } catch {
      setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    if (job.status === "COMPLETED") {
      addNotification(config.buildCompletedMessage(job), "success", {
        link: job.fileUrl ?? undefined,
        linkLabel: config.downloadLabel ?? "Download CSV"
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
