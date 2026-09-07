import { useCallback, useState } from "react";
import { useToast } from "../components/Toast.js";
import { useNotifications } from "../lib/NotificationsContext.js";

// Fetch-and-download logic shared by ExportButton (its own click) and any page that also
// wants to trigger the same export from elsewhere — e.g. Register's Ctrl+Shift+E shortcut
// — without duplicating the fetch/blob/Content-Disposition parsing, or re-deriving the
// "don't double-fire while one's already in flight" guard in two places. `exporting` is
// exposed so a caller (a keyboard shortcut, a disabled state elsewhere) can check it
// without needing its own copy.
export function useExport(url: string | undefined) {
  const { showToast } = useToast();
  // A large export can take up to ~18s (see assetsExport.ts's own timing notes), and
  // this fetch has no AbortController tied to the calling component's lifecycle — if the
  // user navigates away before it resolves, this keeps running and still downloads the
  // file, but the toast below is easy to miss from wherever they've since scrolled to.
  // addNotification gives that completion a persistent record instead of a transient one.
  const { addNotification } = useNotifications();
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
      addNotification(`${filename} downloaded.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed. Please try again.";
      showToast(message, "error");
      addNotification(message, "error");
    } finally {
      setExporting(false);
    }
  }, [url, exporting, showToast, addNotification]);

  return { exporting, runExport };
}
