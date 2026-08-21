import { useEffect, useState, type ReactNode } from "react";
import { createAsset, fetchCenters, fetchStatuses, fetchSubClassifications } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import type { AssetCreateInput } from "../lib/types.js";
import { AddCircleIcon, ErrorIcon, PassIcon } from "../lib/icons.js";

function blankForm(defaultDate: string): AssetCreateInput {
  return {
    farId: "",
    subClassification: "",
    assetDescription: "",
    serialNo: "",
    qty: 1,
    status: "Active",
    dateAcquired: defaultDate,
    location: "",
    usefulLifeC1Years: 0,
    usefulLifeC2Years: 0,
    c1OpeningCost: 0,
    c2OpeningCost: 0,
    additionsC1: 0,
    additionsC2: 0,
    dateOfAddition: null,
    accDepC1Opening: 0,
    accDepC2Opening: 0
  };
}

const LABEL_CLASS = "text-[11px] font-bold uppercase tracking-wide text-gray-500";
const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

function Field({
  label,
  htmlFor,
  children
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function CapitalizationPage() {
  const { settings } = useSettings();
  const [centers, setCenters] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<string[]>([]);
  const [form, setForm] = useState<AssetCreateInput>(() => blankForm(settings?.asAt ?? ""));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    // excludeSystemManaged: a brand-new asset must never be capitalized as already
    // Disposed — that status is only ever set through the Disposal flow.
    fetchStatuses(true).then(setStatuses).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
  }, []);

  const update = (patch: Partial<AssetCreateInput>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setSuccess(null);
  };

  function validate(): string | null {
    if (!form.farId.trim()) return "FAR ID is required.";
    if (!form.subClassification.trim()) return "Sub Classification is required.";
    if (!form.assetDescription.trim()) return "Asset Description is required.";
    if (!form.status.trim()) return "Status is required.";
    if (!form.dateAcquired) return "Date Acquired is required.";
    if (!form.location.trim()) return "Location is required.";
    if (form.usefulLifeC1Years < 0 || form.usefulLifeC2Years < 0) return "Useful life cannot be negative.";
    return null;
  }

  async function handleSubmit() {
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createAsset(form);
      setSuccess(`Asset "${form.farId}" was capitalized.`);
      setForm(blankForm(settings?.asAt ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not capitalize the asset.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <AddCircleIcon fontSize={20} />
        Capitalization
      </h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">Register a brand-new asset into the Fixed Asset Register.</p>

      <div className="mt-6 max-w-3xl rounded-xl bg-white p-6 shadow-sm">
        <div className="grid grid-cols-2 gap-4">
          <Field label="FAR ID" htmlFor="cap-far-id">
            <input
              id="cap-far-id"
              type="text"
              className={INPUT_CLASS}
              value={form.farId}
              onChange={(e) => update({ farId: e.target.value })}
            />
          </Field>
          <Field label="Sub Classification" htmlFor="cap-sub-class">
            <select
              id="cap-sub-class"
              className={INPUT_CLASS}
              value={form.subClassification}
              onChange={(e) => update({ subClassification: e.target.value })}
            >
              <option value="">Select…</option>
              {subClassifications.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Asset Description" htmlFor="cap-description">
            <input
              id="cap-description"
              type="text"
              className={INPUT_CLASS}
              value={form.assetDescription}
              onChange={(e) => update({ assetDescription: e.target.value })}
            />
          </Field>
          <Field label="Serial No" htmlFor="cap-serial">
            <input
              id="cap-serial"
              type="text"
              className={INPUT_CLASS}
              value={form.serialNo}
              onChange={(e) => update({ serialNo: e.target.value })}
            />
          </Field>

          <Field label="Qty" htmlFor="cap-qty">
            <input
              id="cap-qty"
              type="number"
              min={0}
              className={INPUT_CLASS}
              value={form.qty}
              onChange={(e) => update({ qty: Number(e.target.value) })}
            />
          </Field>
          <Field label="Status" htmlFor="cap-status">
            <select id="cap-status" className={INPUT_CLASS} value={form.status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">Select…</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Date Acquired" htmlFor="cap-date-acquired">
            <input
              id="cap-date-acquired"
              type="date"
              className={INPUT_CLASS}
              value={form.dateAcquired}
              onChange={(e) => update({ dateAcquired: e.target.value })}
            />
          </Field>
          <Field label="Location" htmlFor="cap-location">
            <select
              id="cap-location"
              className={INPUT_CLASS}
              value={form.location}
              onChange={(e) => update({ location: e.target.value })}
            >
              <option value="">Select…</option>
              {centers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h2 className="text-sm font-semibold text-ink">Cost &amp; Useful Life</h2>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <Field label="Component 1 Useful Life (Years)" htmlFor="cap-life-c1">
              <input
                id="cap-life-c1"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.usefulLifeC1Years}
                onChange={(e) => update({ usefulLifeC1Years: Number(e.target.value) })}
              />
            </Field>
            <Field label="Component 2 Useful Life (Years)" htmlFor="cap-life-c2">
              <input
                id="cap-life-c2"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.usefulLifeC2Years}
                onChange={(e) => update({ usefulLifeC2Years: Number(e.target.value) })}
              />
            </Field>
            <Field label="Component 1 Opening Cost" htmlFor="cap-cost-c1">
              <input
                id="cap-cost-c1"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.c1OpeningCost}
                onChange={(e) => update({ c1OpeningCost: Number(e.target.value) })}
              />
            </Field>
            <Field label="Component 2 Opening Cost" htmlFor="cap-cost-c2">
              <input
                id="cap-cost-c2"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.c2OpeningCost}
                onChange={(e) => update({ c2OpeningCost: Number(e.target.value) })}
              />
            </Field>
          </div>
        </div>

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h2 className="text-sm font-semibold text-ink">Mid-Year Additions (optional)</h2>
          <div className="mt-3 grid grid-cols-3 gap-4">
            <Field label="Additions C1" htmlFor="cap-add-c1">
              <input
                id="cap-add-c1"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.additionsC1}
                onChange={(e) => update({ additionsC1: Number(e.target.value) })}
              />
            </Field>
            <Field label="Additions C2" htmlFor="cap-add-c2">
              <input
                id="cap-add-c2"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.additionsC2}
                onChange={(e) => update({ additionsC2: Number(e.target.value) })}
              />
            </Field>
            <Field label="Date of Addition" htmlFor="cap-add-date">
              <input
                id="cap-add-date"
                type="date"
                className={INPUT_CLASS}
                value={form.dateOfAddition ?? ""}
                onChange={(e) => update({ dateOfAddition: e.target.value || null })}
              />
            </Field>
          </div>
        </div>

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h2 className="text-sm font-semibold text-ink">Opening Accumulated Depreciation (optional)</h2>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <Field label="Component 1" htmlFor="cap-accdep-c1">
              <input
                id="cap-accdep-c1"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.accDepC1Opening}
                onChange={(e) => update({ accDepC1Opening: Number(e.target.value) })}
              />
            </Field>
            <Field label="Component 2" htmlFor="cap-accdep-c2">
              <input
                id="cap-accdep-c2"
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={form.accDepC2Opening}
                onChange={(e) => update({ accDepC2Opening: Number(e.target.value) })}
              />
            </Field>
          </div>
        </div>

        {error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}
        {success && !error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-green-700">
            <PassIcon fontSize={15} />
            {success}
          </p>
        )}

        <button
          type="button"
          className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Capitalizing…" : "Capitalize Asset"}
        </button>
      </div>
    </div>
  );
}
