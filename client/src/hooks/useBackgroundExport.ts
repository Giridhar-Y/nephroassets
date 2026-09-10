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
 *  either way, only which two API functions and what text differ.
 *
 *  `isExporting` stays true for the WHOLE job lifecycle — job creation through every
 *  PENDING/PROCESSING poll tick — not just the brief POST that creates it. An earlier
 *  version tracked only that initial POST, so the toolbar button sprang back to its
 *  normal state the instant the job was created while the real work (which can run for
 *  minutes at 200k+ rows) was still silently polling underneath it — no visual feedback,
 *  and nothing stopped a second click from starting a duplicate job in the meantime. */
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
  const [isExporting, setIsExporting] = useState(false);

  // RegisterPage/ActivityLogPage build `config` as a fresh object literal every render
  // (startingMessage in particular often embeds a just-computed row count) — a ref
  // instead of a useCallback dependency means startExport always sees the LATEST config
  // without needing to recreate itself (and without the classic stale-closure bug a
  // memoized callback capturing an old `config` would have).
  const configRef = useRef(config);
  configRef.current = config;

  const startExport = useCallback(async (params: TParams) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const { jobId } = await configRef.current.createJob(params);
      showToast(configRef.current.startingMessage);
      pollExportJob(jobId, configRef.current, addNotification, setIsExporting);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not start the export.", "error");
      setIsExporting(false);
    }
  }, [isExporting, showToast, addNotification]);

  return { isExporting, startExport };
}

function pollExportJob(
  jobId: string,
  config: {
    fetchJob: (jobId: string) => Promise<ExportJobStatus>;
    buildCompletedMessage: (job: ExportJobStatus) => string;
    downloadLabel?: string;
  },
  addNotification: ReturnType<typeof useNotifications>["addNotification"],
  setIsExporting: (value: boolean) => void
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
      setIsExporting(false);
      addNotification(config.buildCompletedMessage(job), "success", {
        link: job.fileUrl ?? undefined,
        linkLabel: config.downloadLabel ?? "Download CSV"
      });
      return;
    }
    if (job.status === "FAILED") {
      setIsExporting(false);
      addNotification(job.errorMessage ?? "Background export failed.", "error");
      return;
    }
    setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}
