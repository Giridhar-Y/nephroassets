import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { Tooltip } from "../components/Tooltip.js";
import type { FySettings } from "../lib/types.js";

function daysBetweenInclusive(start: string, end: string): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start + "T00:00:00Z").getTime();
  const endMs = new Date(end + "T00:00:00Z").getTime();
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  return days > 0 ? days : null;
}

const BLANK_FORM: FySettings = { asAt: "", fyStart: "", fyEnd: "", daysInFy: 365 };

export function SettingsPage() {
  const { settings, loading, notConfigured, saveSettings } = useSettings();
  const [form, setForm] = useState<FySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (form) return;
    if (settings) setForm(settings);
    else if (notConfigured) setForm(BLANK_FORM);
  }, [settings, notConfigured, form]);

  const calculatedDays = useMemo(
    () => (form ? daysBetweenInclusive(form.fyStart, form.fyEnd) : null),
    [form]
  );

  if (loading || !form) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="h-64 w-96 animate-pulse rounded-xl bg-gray-100" />
      </div>
    );
  }

  const update = (patch: Partial<FySettings>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
  };

  const validationError = (): string | null => {
    if (!form.fyStart || !form.fyEnd || !form.asAt) return "All fields are required.";
    if (form.fyEnd <= form.fyStart) return "Financial Year End must be after Financial Year Start.";
    if (form.asAt < form.fyStart || form.asAt > form.fyEnd) {
      return "“Figures as of” must fall within the financial year.";
    }
    if (!Number.isInteger(form.daysInFy) || form.daysInFy < 1 || form.daysInFy > 366) {
      return "Days in Financial Year must be a whole number between 1 and 366.";
    }
    return null;
  };

  async function handleSave() {
    const validation = validationError();
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveSettings(form!);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="text-base font-semibold text-ink">Settings</h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">
        These control every figure in NephroAssets: the cut-off date used for depreciation, and the financial year
        it falls within.
      </p>
      {notConfigured && (
        <p className="mt-3 max-w-xl rounded-md bg-accent-light px-3 py-2 text-sm text-accent-hover">
          Welcome! Set up your financial year below to get started.
        </p>
      )}

      <div className="mt-6 max-w-md rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="settings-as-at" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            <Tooltip text="The date depreciation and every figure in the register is calculated as of. Must fall within the financial year below.">
              Figures As Of
            </Tooltip>
          </label>
          <input
            id="settings-as-at"
            type="date"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={form.asAt}
            min={form.fyStart}
            max={form.fyEnd}
            onChange={(e) => update({ asAt: e.target.value })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="settings-fy-start" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Financial Year Start (FY Start)
          </label>
          <input
            id="settings-fy-start"
            type="date"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={form.fyStart}
            onChange={(e) => update({ fyStart: e.target.value })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="settings-fy-end" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Financial Year End (FY End)
          </label>
          <input
            id="settings-fy-end"
            type="date"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={form.fyEnd}
            onChange={(e) => update({ fyEnd: e.target.value })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="settings-days-fy" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            <Tooltip text="The total number of days in the financial year, used to spread depreciation evenly across it. Usually 365, or 366 in a leap year.">
              Days in Financial Year
            </Tooltip>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="settings-days-fy"
              type="number"
              min={1}
              max={366}
              className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={form.daysInFy}
              onChange={(e) => update({ daysInFy: Number(e.target.value) })}
            />
            {calculatedDays !== null && calculatedDays !== form.daysInFy && (
              <button
                type="button"
                className="text-xs font-medium text-accent hover:underline"
                onClick={() => update({ daysInFy: calculatedDays })}
              >
                Use {calculatedDays} (calculated from FY Start/End)
              </button>
            )}
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        {saved && !error && <p className="mt-4 text-sm text-accent-hover">Settings saved.</p>}

        <button
          type="button"
          className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
