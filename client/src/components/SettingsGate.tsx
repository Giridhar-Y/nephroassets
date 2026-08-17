import { Link } from "react-router-dom";
import { useSettings } from "../lib/SettingsContext.js";
import type { ReactNode } from "react";

/** Wraps a page that needs FY settings to do anything useful. Shows a designed prompt
 *  instead of a stuck skeleton when settings haven't been configured yet (first run),
 *  and a designed error state if loading them genuinely failed. */
export function SettingsGate({ children }: { children: ReactNode }) {
  const { loading, notConfigured, error, reload } = useSettings();

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white">
        <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-center">
        <p className="text-sm font-medium text-gray-600">Couldn't load settings.</p>
        <p className="text-xs text-gray-400">{error}</p>
        <button type="button" className="mt-2 text-xs font-semibold text-accent hover:underline" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (notConfigured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-center">
        <p className="text-sm font-medium text-gray-600">Your financial year hasn't been set up yet.</p>
        <p className="max-w-sm text-xs text-gray-400">
          Set the cut-off date and financial year in Settings before working with the register.
        </p>
        <Link
          to="/settings"
          className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
        >
          Go to Settings
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
