import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchSettingsOrNull, updateAsAt as updateAsAtApi, updateSettings as updateSettingsApi } from "../api/client.js";
import { useAuth } from "./AuthContext.js";
import type { FySettings } from "./types.js";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface SettingsContextValue {
  settings: FySettings | null;
  loading: boolean;
  /** True once loading has finished and there is genuinely no settings row yet (a
   *  first-run state) — distinct from `error`, which means the fetch itself failed. */
  notConfigured: boolean;
  error: string | null;
  setAsAt: (asAt: string) => Promise<void>;
  saveSettings: (next: FySettings) => Promise<void>;
  reload: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<FySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSettingsOrNull();
      if (result) {
        // "Figures as of" defaults to today on every fresh load, not whatever was last
        // left set — clamped to the configured financial year. An explicit change via
        // the AsAtControl still persists for that look, but a new visit starts at today.
        const today = todayIso();
        const asAt = today < result.fyStart ? result.fyStart : today > result.fyEnd ? result.fyEnd : today;
        setSettings(asAt === result.asAt ? result : await updateAsAtApi(asAt));
      } else {
        setSettings(null);
      }
      setNotConfigured(result === null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Every /api/* route needs a real session now (see server/src/auth/middleware.ts) —
  // this Provider sits above <HashRouter> so it mounts on /login too, before there's
  // any session to fetch settings with. Re-fetching whenever `user` changes (rather
  // than once on mount) is what makes the settings load correctly right after signing
  // in, instead of getting stuck on the 401 from that first, pre-login attempt; it also
  // clears stale settings on sign-out.
  useEffect(() => {
    if (!user) {
      setSettings(null);
      setNotConfigured(false);
      setError(null);
      setLoading(false);
      return;
    }
    reload();
  }, [user, reload]);

  const saveSettings = useCallback(async (next: FySettings) => {
    setError(null);
    try {
      const saved = await updateSettingsApi(next);
      setSettings(saved);
      setNotConfigured(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
      throw err;
    }
  }, []);

  const setAsAt = useCallback(
    async (asAt: string) => {
      if (!settings) return;
      setError(null);
      try {
        setSettings(await updateAsAtApi(asAt));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not change Figures As Of.");
        throw err;
      }
    },
    [settings]
  );

  return (
    <SettingsContext.Provider
      value={{ settings, loading, notConfigured, error, setAsAt, saveSettings, reload }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
