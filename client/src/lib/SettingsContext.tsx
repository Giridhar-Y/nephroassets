import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchSettingsOrNull, updateSettings as updateSettingsApi } from "../api/client.js";
import type { FySettings } from "./types.js";

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
  const [settings, setSettings] = useState<FySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSettingsOrNull();
      setSettings(result);
      setNotConfigured(result === null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

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
      await saveSettings({ ...settings, asAt });
    },
    [settings, saveSettings]
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
