import { useEffect, useState } from "react";
import { fetchApprovalPreview, isPendingApproval, type ApprovalModule } from "../api/approvals.js";

export const TASKS_CHANGED = "nephroassets:tasks-changed";

/** Would my entry in this module need approval (at this amount), and who reviews it
 *  first? Forms use it to label their button "Submit for approval". Debounced lightly
 *  so typing an amount doesn't fire a request per keystroke. */
export function useApprovalPreview(module: ApprovalModule, amount?: number): { applies: boolean; nextReviewers?: string } {
  const [state, setState] = useState<{ applies: boolean; nextReviewers?: string }>({ applies: false });
  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      fetchApprovalPreview(module, amount)
        .then((r) => current && setState({ applies: r.applies, nextReviewers: r.nextReviewers }))
        .catch(() => {});
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [module, amount]);
  return state;
}

/** If a save came back as "sent for approval", the message to show instead of the usual
 *  success toast (and the Tasks badge/notifications are refreshed). */
export function approvalMessage(result: unknown): string | null {
  if (!isPendingApproval(result)) return null;
  window.dispatchEvent(new Event(TASKS_CHANGED));
  return result.pendingApproval.message;
}

/** For a batch of saves (e.g. disposing several assets): how many went for approval. */
export function approvalSummary(results: unknown[]): { pending: number; message: string | null } {
  const pending = results.filter(isPendingApproval);
  if (pending.length === 0) return { pending: 0, message: null };
  window.dispatchEvent(new Event(TASKS_CHANGED));
  const first = pending[0]!.pendingApproval;
  return {
    pending: pending.length,
    message: pending.length === 1 ? first.message : `${pending.length} requests sent to ${first.nextReviewers} for approval.`
  };
}
