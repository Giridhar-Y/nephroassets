import { useEffect, useState } from "react";

// Not in lib.dom.d.ts yet (the event is still non-standard/Chromium-only).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own non-standard flag — matchMedia alone doesn't cover it there.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Android/desktop Chrome only — listening for beforeinstallprompt suppresses Chrome's
// own automatic mini-infobar, so this app has to supply its own "Install App" trigger
// once the event has fired (see InstallAppButton). Firefox/Safari never fire this event
// at all; the button simply never appears there, which is correct — Safari gets its own
// manual-instructions hint instead (IosInstallHint), Firefox has no install path at all.
export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      setInstalled(true);
      setDeferredPrompt(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const canInstall = !installed && deferredPrompt !== null;

  async function promptInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    // Either way the prompt is now spent — Chrome only lets it fire once per event
    // instance — so drop it regardless of what the user chose.
    setDeferredPrompt(null);
    return outcome;
  }

  return { canInstall, promptInstall };
}
