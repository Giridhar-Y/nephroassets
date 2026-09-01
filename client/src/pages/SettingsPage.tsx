import { useCallback, useEffect, useState } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { Tooltip } from "../components/Tooltip.js";
import { useToast } from "../components/Toast.js";
import { formatCurrency, formatDate, formatDateTime } from "../lib/format.js";
import { depreciationFormulaText } from "../lib/depreciationFormula.js";
import {
  fetchSettingsAuditLog,
  previewDaysInFy,
  updateDaysInFy,
  type DaysInFyPreview,
  type SettingsAuditLogEntry
} from "../api/client.js";
import type { FySettings } from "../lib/types.js";
import { DepreciationIcon, ErrorIcon, HistoryIcon, SettingsIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { hasPermission } from "../lib/permissions.js";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// First-run default: "Figures as of" starts on today rather than blank.
const BLANK_FORM: FySettings = { asAt: todayIso(), fyStart: "", fyEnd: "", daysInFy: 365 };

export function SettingsPage() {
  const { settings, loading, notConfigured, saveSettings } = useSettings();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [form, setForm] = useState<FySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (form) return;
    if (settings) setForm(settings);
    else if (notConfigured) setForm(BLANK_FORM);
  }, [settings, notConfigured, form]);

  if (loading || !form) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="h-64 w-96 animate-pulse rounded-xl bg-gray-100" />
      </div>
    );
  }

  const update = (patch: Partial<FySettings>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
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
      showToast(`Settings saved. Figures now shown as of ${formatDate(form!.asAt)}.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save settings.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        bordered={false}
        subtitle="These control every figure in NephroAssets: the cut-off date used for depreciation, and the financial year
        it falls within."
      />
      {notConfigured && hasPermission(user, "settings", "edit") && (
        <p className="mt-3 max-w-xl rounded-md bg-accent-light px-3 py-2 text-sm text-accent-hover">
          Welcome! Set up your financial year below to get started.
        </p>
      )}
      {notConfigured && !hasPermission(user, "settings", "edit") && (
        <p className="mt-3 max-w-xl rounded-md bg-accent-light px-3 py-2 text-sm text-accent-hover">
          The financial year hasn't been set up yet — contact an admin to get started.
        </p>
      )}

      {hasPermission(user, "settings", "edit") ? (
        <div className="mt-6 max-w-md rounded-xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-1">
            <label htmlFor="settings-as-at" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <Tooltip text="The date depreciation and every figure in the register is calculated as of. Must fall within the financial year below. Every role can also change this from the header's Figures As Of control.">
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
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <Tooltip text="The total number of days in the financial year, used to spread depreciation evenly across it. Usually 365, or 366 in a leap year.">
                Days in Financial Year
              </Tooltip>
            </label>
            <p className="text-sm text-ink">
              {settings ? settings.daysInFy : form.daysInFy}{" "}
              <span className="text-xs text-gray-400">
                — managed from Depreciation Formula Settings below
              </span>
            </p>
          </div>

          {error && (
            <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
              <ErrorIcon fontSize={15} />
              {error}
            </p>
          )}

          <button
            type="button"
            className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      ) : (
        settings && (
          <div className="mt-6 max-w-md rounded-xl bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-500">
              Contact an admin to change the financial year. You can still change{" "}
              <strong>Figures As Of</strong> from the control in the header — that's not restricted.
            </p>
          </div>
        )
      )}

      {hasPermission(user, "settings", "edit") && settings && <DepreciationFormulaSettings daysInFy={settings.daysInFy} />}
    </div>
  );
}

// Tier 1 of a larger idea (raw formula editing) deliberately not built yet — see the
// formula display below for why letting admins type arbitrary formulas is out of scope
// for now. Only DAYS_FY is a genuine policy knob (confirmed via investigation: SLM is the
// only method implemented, the depreciation cap is a fixed math invariant, and rounding
// only ever happens at display time) — this section exists to give that one real
// parameter a confirm-step preview and an audit trail it doesn't get from the plain
// PUT /api/settings form above.
function DepreciationFormulaSettings({ daysInFy }: { daysInFy: number }) {
  const { reload } = useSettings();
  const { showToast } = useToast();
  const [draftDays, setDraftDays] = useState(daysInFy);
  const [preview, setPreview] = useState<DaysInFyPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<SettingsAuditLogEntry[] | null>(null);

  useEffect(() => {
    setDraftDays(daysInFy);
  }, [daysInFy]);

  const loadAuditLog = useCallback(() => {
    fetchSettingsAuditLog()
      .then((res) => setAuditLog(res.items))
      .catch(() => setAuditLog([]));
  }, []);

  useEffect(() => {
    loadAuditLog();
  }, [loadAuditLog]);

  async function handlePreview() {
    if (!Number.isInteger(draftDays) || draftDays < 1 || draftDays > 366) {
      setError("Must be a whole number between 1 and 366.");
      return;
    }
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await previewDaysInFy(draftDays));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compute preview.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await updateDaysInFy(draftDays);
      showToast(`Days in Financial Year changed to ${draftDays}.`);
      setPreview(null);
      await reload();
      loadAuditLog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save change.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="mt-6 max-w-2xl rounded-xl bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <DepreciationIcon fontSize={18} />
        Depreciation Formula Settings
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        The parameters behind every depreciation figure in the register — admin only. There's no "closed period"
        concept in NephroAssets yet, so a change here reaches every past period's numbers immediately, not just the
        current one. Review the preview carefully before confirming.
      </p>

      <div className="mt-4 rounded-md bg-gray-50 p-3">
        <pre className="whitespace-pre-wrap font-mono text-xs text-gray-700">{depreciationFormulaText(daysInFy)}</pre>
        <p className="mt-2 text-xs text-gray-500">
          Method: Straight-Line (SLM) — the only method implemented, not configurable. The depreciation cap (closing
          accumulated depreciation can never exceed gross block) is a fixed accounting invariant, not a policy
          choice. Rounding only ever happens for on-screen display — the calculation itself is never rounded.
        </p>
      </div>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="days-fy-draft" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Days in Financial Year (DAYS_FY)
          </label>
          <input
            id="days-fy-draft"
            type="number"
            min={1}
            max={366}
            className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={draftDays}
            onChange={(e) => setDraftDays(Number(e.target.value))}
          />
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handlePreview}
          disabled={previewing || draftDays === daysInFy}
        >
          {previewing ? "Calculating…" : "Preview Change"}
        </button>
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
          <ErrorIcon fontSize={15} />
          {error}
        </p>
      )}

      {preview && (
        <DaysInFyConfirmModal
          oldValue={daysInFy}
          newValue={draftDays}
          preview={preview}
          confirming={confirming}
          onCancel={() => setPreview(null)}
          onConfirm={handleConfirm}
        />
      )}

      <div className="mt-6 border-t border-gray-100 pt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
          <HistoryIcon fontSize={14} />
          Change History
        </h3>
        {auditLog === null ? (
          <p className="mt-2 text-xs text-gray-400">Loading…</p>
        ) : auditLog.length === 0 ? (
          <p className="mt-2 text-xs text-gray-400">No changes recorded yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100">
            {auditLog.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between py-2 text-xs">
                <span className="text-gray-600">
                  <span className="font-medium text-ink">{entry.username ?? "Unknown user"}</span> changed{" "}
                  <span className="font-medium text-ink">{entry.field}</span> from{" "}
                  <span className="font-mono">{entry.oldValue}</span> to{" "}
                  <span className="font-mono">{entry.newValue}</span>
                </span>
                <span className="text-gray-400">{formatDateTime(entry.changedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DaysInFyConfirmModal({
  oldValue,
  newValue,
  preview,
  confirming,
  onCancel,
  onConfirm
}: {
  oldValue: number;
  newValue: number;
  preview: DaysInFyPreview;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <DepreciationIcon fontSize={18} />
          Confirm Days in Financial Year Change
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          <strong>{oldValue}</strong> → <strong>{newValue}</strong>
        </p>

        <div className="mt-4 rounded-md bg-gray-50 p-3 text-sm text-ink">
          <p>
            {preview.assetsChanged} of {preview.totalAssets} assets' current-period depreciation would change.
          </p>
          <p className="mt-1">
            Total period depreciation: {formatCurrency(preview.currentTotalPeriodDep)} →{" "}
            {formatCurrency(preview.projectedTotalPeriodDep)} ({preview.delta >= 0 ? "+" : ""}
            {formatCurrency(preview.delta)})
          </p>
        </div>

        <p className="mt-3 text-xs text-gray-500">
          This takes effect immediately for every period's figures once confirmed — past periods aren't protected
          from it either.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
            onClick={onCancel}
            disabled={confirming}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? "Saving…" : "Confirm & Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
