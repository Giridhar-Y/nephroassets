import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { WarningIcon } from "../lib/icons.js";

/** Shown by Layout.tsx once useIdleLogout's warning threshold (28 min idle) is
 *  crossed. Backdrop-click/Escape both count as "stay active" — dismissing it is itself
 *  a deliberate action, not something that should require re-reading the countdown. */
export function InactivityWarningModal({
  secondsRemaining,
  onStayActive,
  onSignOutNow
}: {
  secondsRemaining: number;
  onStayActive: () => void;
  onSignOutNow: () => void;
}) {
  return (
    <Modal onClose={onStayActive} onEscape={onStayActive} onBackdropClick={onStayActive} widthClassName="max-w-sm" stacked>
      <>
        <h2 className="flex items-center gap-2 text-base font-semibold text-amber-600">
          <WarningIcon fontSize={18} />
          Session Timeout Warning
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          You have been inactive. For your security, you will be automatically signed out in{" "}
          <span className="font-semibold text-ink">{secondsRemaining}s</span>.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="destructive" onClick={onSignOutNow}>
            Sign Out Now
          </Button>
          <Button variant="primary" onClick={onStayActive}>
            Stay Signed In
          </Button>
        </div>
      </>
    </Modal>
  );
}
