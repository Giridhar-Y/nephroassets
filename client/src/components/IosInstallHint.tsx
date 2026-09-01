import { useEffect, useState } from "react";
import { isStandalone } from "../hooks/usePwaInstall.js";
import { DismissIcon, ShareIcon } from "../lib/icons.js";

const DISMISSED_KEY = "nephroassets.iosInstallHintDismissed";

// iOS Safari has no beforeinstallprompt (or any install-prompt API at all) — "Add to
// Home Screen" only exists inside Safari's own Share sheet, so the best this app can do
// is point at it. The standard iOS-Safari-not-Chrome/Firefox/Edge detection: those other
// iOS browsers are all WebKit wrappers whose UA string still contains "Safari", so they
// have to be explicitly excluded rather than matched.
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  return isIos && isSafari;
}

export function IosInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === "true";
    } catch {
      // Private-browsing/storage-disabled — treat as not-dismissed, just won't persist.
    }
    setShow(!dismissed && !isStandalone() && isIosSafari());
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, "true");
    } catch {
      // Nothing to do — it just reappears next visit, which is a mild inconvenience,
      // not a functional break.
    }
  }

  return (
    <div className="fixed inset-x-4 bottom-4 z-40 flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm shadow-lg sm:inset-x-auto sm:right-4 sm:max-w-sm print:hidden">
      <ShareIcon fontSize={20} className="shrink-0 text-accent" />
      <p className="flex-1 text-gray-700">
        Install NephroAssets: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <DismissIcon fontSize={14} />
      </button>
    </div>
  );
}
