// A heavy report (dashboard-totals/trend, audit-reconciliation) for a date that isn't
// cached answers 202 { status: "preparing" } on Vercel: the server has queued the date
// for the out-of-Vercel pre-warm job instead of running a scan that can only time out
// there (server/src/jobs/prewarmRequests.ts). The page polls the same request until
// the real payload arrives.
export interface ReportPreparing {
  status: "preparing";
  asAt: string;
}

export const PREPARING_POLL_MS = 15_000;
/** The job normally takes 2-4 min (runner start-up + the scan); past this, stop polling
 *  and say so rather than spin forever. */
export const PREPARING_GIVE_UP_MS = 10 * 60_000;

export function isPreparing(value: unknown): value is ReportPreparing {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "preparing";
}

/** Resolves with the real payload, `undefined` if `isCurrent()` turned false (the page
 *  moved on — a newer load, a different date, unmount), or throws once
 *  PREPARING_GIVE_UP_MS has passed. `onPreparing` fires on each "still preparing". */
export async function fetchUntilReady<T>(
  fetcher: () => Promise<T | ReportPreparing>,
  { onPreparing, isCurrent }: { onPreparing: () => void; isCurrent: () => boolean }
): Promise<T | undefined> {
  const started = Date.now();
  for (;;) {
    const res = await fetcher();
    if (!isCurrent()) return undefined;
    if (!isPreparing(res)) return res;
    onPreparing();
    if (Date.now() - started >= PREPARING_GIVE_UP_MS) {
      throw new Error("These figures are still being prepared after 10 minutes. Try Refresh again in a few minutes.");
    }
    await new Promise((resolve) => setTimeout(resolve, PREPARING_POLL_MS));
    if (!isCurrent()) return undefined;
  }
}
