import { ExportIcon, RetryIcon } from "../../lib/icons.js";
import { useExport } from "../../hooks/useExport.js";
import { Button } from "./Button.js";

// Every "Export to Excel" in the app (Register, Audit Reconciliation, Transfer &
// Depreciation Report) used to be a plain <a href> — the browser handled the download
// fine, but gave no in-app feedback and nothing stopped a second click from kicking off
// a duplicate export while the first was still streaming. This fetches the file itself
// so it can show progress and disable itself while one is in flight; the filename comes
// from the response's own Content-Disposition header, same one the server already sets.
// The fetch/blob/download logic itself lives in useExport (hooks/useExport.ts).
//
// No determinate progress bar: the export streams from the server (assetsExport.ts's
// PassThrough) without a Content-Length, so there's no total byte count to show a real
// percentage against — an indeterminate spinner is the honest option here, not a
// simplification.
export function ExportButton({
  url,
  label = "Export to Excel",
  size = "sm",
  shortcutHint,
  exporting: exportingProp,
  onExport
}: {
  url: string | undefined;
  label?: string;
  size?: "sm" | "md";
  /** Shown in the button's title attribute (e.g. "Export to Excel (Ctrl+Shift+E)") —
   *  only set by Register, the one screen with that shortcut wired up. Audit
   *  Reconciliation/Transfer & Depreciation Report render this same component but don't
   *  pass this, so their tooltip stays exactly as it was rather than advertising a
   *  shortcut that doesn't work there. */
  shortcutHint?: string;
  /** Controls export state from outside instead of this component managing its own —
   *  Register does this so its Ctrl+Shift+E shortcut (hooks/useExport.ts, called once at
   *  the page level) and this button share one `exporting` state, rather than two
   *  independent ones that could let a shortcut-triggered export and a button click race
   *  each other. Same controlled/uncontrolled convention AssetGrid's expanded/density
   *  props already use — provide both together, or neither to keep this component's own
   *  internal state (every page but Register). */
  exporting?: boolean;
  onExport?: () => void;
}) {
  const isControlled = exportingProp !== undefined;
  const internal = useExport(url);
  const exporting = isControlled ? exportingProp : internal.exporting;
  const runExport = isControlled ? onExport! : internal.runExport;

  return (
    <Button variant="secondary" size={size} onClick={runExport} disabled={!url || exporting} title={shortcutHint}>
      {exporting ? <RetryIcon fontSize={14} className="animate-spin" /> : <ExportIcon fontSize={14} />}
      {exporting ? "Exporting…" : label}
    </Button>
  );
}
