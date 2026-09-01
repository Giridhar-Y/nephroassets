import { useState } from "react";
import { ExportIcon, RetryIcon } from "../../lib/icons.js";
import { useToast } from "../Toast.js";
import { Button } from "./Button.js";

// Every "Export to Excel" in the app (Register, Audit Reconciliation, Transfer &
// Depreciation Report) used to be a plain <a href> — the browser handled the download
// fine, but gave no in-app feedback and nothing stopped a second click from kicking off
// a duplicate export while the first was still streaming. This fetches the file itself
// so it can show progress and disable itself while one is in flight; the filename comes
// from the response's own Content-Disposition header, same one the server already sets.
//
// No determinate progress bar: the export streams from the server (assetsExport.ts's
// PassThrough) without a Content-Length, so there's no total byte count to show a real
// percentage against — an indeterminate spinner is the honest option here, not a
// simplification.
export function ExportButton({
  url,
  label = "Export to Excel",
  size = "sm"
}: {
  url: string | undefined;
  label?: string;
  size?: "sm" | "md";
}) {
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (!url || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Export failed (${res.status}).`);
      }
      const blob = await res.blob();
      const filename = /filename="?([^"]+)"?/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "export.xlsx";
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
      showToast(`${filename} downloaded.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Export failed. Please try again.", "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button variant="secondary" size={size} onClick={handleExport} disabled={!url || exporting}>
      {exporting ? <RetryIcon fontSize={14} className="animate-spin" /> : <ExportIcon fontSize={14} />}
      {exporting ? "Exporting…" : label}
    </Button>
  );
}
