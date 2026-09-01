import { usePwaInstall } from "../hooks/usePwaInstall.js";
import { InstallIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

// Lives in the top header bar (dark chrome) next to Figures As Of — a global,
// occasional action, not part of any one page's own toolbar. Renders nothing until
// Chrome has actually fired beforeinstallprompt (so nothing shows in Firefox/Safari, or
// before Chrome decides the page is installable), and disappears again once installed.
export function InstallAppButton() {
  const { canInstall, promptInstall } = usePwaInstall();
  const { showToast } = useToast();

  if (!canInstall) return null;

  return (
    <button
      type="button"
      onClick={async () => {
        const outcome = await promptInstall();
        if (outcome === "accepted") showToast("NephroAssets installed.");
      }}
      className="flex items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-2.5 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-white/20"
    >
      <InstallIcon fontSize={16} />
      Install App
    </button>
  );
}
