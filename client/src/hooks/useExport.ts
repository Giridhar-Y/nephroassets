import { useCallback, useState } from "react";
import { useToast } from "../components/Toast.js";

// Fetch-and-download logic shared by ExportButton (its own click) and any page that also
// wants to trigger the same export from elsewhere — e.g. Register's Ctrl+Shift+E shortcut
// — without duplicating the fetch/blob/Content-Disposition parsing, or re-deriving the
// "don't double-fire while one's already in flight" guard in two places. `exporting` is
// exposed so a caller (a keyboard shortcut, a disabled state elsewhere) can check it
// without needing its own copy.
export function useExport(url: string | undefined) {
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);

  const runExport = useCallback(async () => {
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
  }, [url, exporting, showToast]);

  return { exporting, runExport };
}
