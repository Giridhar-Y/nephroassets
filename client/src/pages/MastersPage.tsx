import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createMasterCenter,
  createMasterRole,
  createMasterStatus,
  createMasterSubClassification,
  fetchMasterCenters,
  fetchMasterRoles,
  fetchMasterStatuses,
  fetchMasterSubClassifications,
  saveRolePermissions,
  updateMasterCenter,
  updateMasterRole,
  updateMasterStatus,
  updateMasterSubClassification,
  type MasterCenter,
  type MasterRole,
  type MasterStatus,
  type MasterSubClassification,
  type PermissionGrant
} from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { PermissionMatrix } from "../components/PermissionMatrix.js";
import { BookDatabaseIcon, LockIcon, UploadIcon } from "../lib/icons.js";
import { useToast } from "../components/Toast.js";

type Tab = "centers" | "subClassifications" | "statuses" | "roles";

// Roles is deliberately absent from bulk upload — a handful of roles doesn't need one,
// unlike Centers/Sub Classifications/Statuses which can run into the hundreds.
const TABS: Array<{ id: Tab; label: string; bulkLabel: string | null }> = [
  { id: "centers", label: "Centers (Locations)", bulkLabel: "Centers" },
  { id: "subClassifications", label: "Sub Classifications", bulkLabel: "Sub Classifications" },
  { id: "statuses", label: "Statuses", bulkLabel: "Statuses" },
  { id: "roles", label: "Roles", bulkLabel: null }
];

const INPUT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const TH_CLASS = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600";
const TD_CLASS = "px-3 py-2 text-sm text-ink";

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"
      }`}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function CentersTab() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<MasterCenter[] | null>(null);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    fetchMasterCenters()
      .then(setRows)
      .catch((err) => showToast(err instanceof Error ? err.message : "Could not load centers.", "error"));
  }

  useEffect(load, []);

  async function handleAdd() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      await createMasterCenter({ code: code.trim(), description: description.trim() });
      showToast(`${code.trim()} added successfully.`);
      setCode("");
      setDescription("");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add center.", "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: MasterCenter) {
    setEditingId(row.id);
    setEditCode(row.code);
    setEditDescription(row.description);
  }

  async function saveEdit(row: MasterCenter) {
    setBusy(true);
    try {
      const res = await updateMasterCenter(row.id, { code: editCode.trim(), description: editDescription.trim() });
      setEditingId(null);
      const parts: string[] = [];
      if (res.assetsUpdated) parts.push(`${res.assetsUpdated} asset${res.assetsUpdated === 1 ? "" : "s"}`);
      if (res.transfersUpdated) parts.push(`${res.transfersUpdated} transfer record${res.transfersUpdated === 1 ? "" : "s"}`);
      showToast(parts.length > 0 ? `${res.code} updated — ${parts.join(" and ")} updated.` : `${res.code} updated successfully.`);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save changes.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: MasterCenter) {
    setBusy(true);
    try {
      await updateMasterCenter(row.id, { active: !row.active });
      showToast(
        row.active
          ? `${row.code} deactivated. It's hidden from new selections but existing assets are unaffected.`
          : `${row.code} reactivated.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update center.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Code</label>
          <input className={INPUT_CLASS} placeholder="e.g. Center-026" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Description</label>
          <input
            className={INPUT_CLASS}
            placeholder="Optional"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleAdd}
          disabled={busy || !code.trim()}
        >
          Add Center
        </button>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead className="border-b-2 border-gray-300 bg-gray-50">
          <tr>
            <th className={TH_CLASS}>Code</th>
            <th className={TH_CLASS}>Description</th>
            <th className={TH_CLASS}>Used By</th>
            <th className={TH_CLASS}>Status</th>
            <th className={TH_CLASS}></th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row) => (
            <tr key={row.id} className="border-b border-gray-100">
              {editingId === row.id ? (
                <>
                  <td className={TD_CLASS}>
                    <input className={INPUT_CLASS} value={editCode} onChange={(e) => setEditCode(e.target.value)} />
                  </td>
                  <td className={TD_CLASS}>
                    <input className={INPUT_CLASS} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:opacity-50"
                      onClick={() => saveEdit(row)}
                      disabled={busy || !editCode.trim()}
                    >
                      Save
                    </button>
                    <button type="button" className="font-medium text-gray-500 hover:underline" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className={`${TD_CLASS} font-medium`}>{row.code}</td>
                  <td className={TD_CLASS}>{row.description || "—"}</td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => startEdit(row)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="font-medium text-gray-500 hover:underline disabled:opacity-50"
                      onClick={() => toggleActive(row)}
                      disabled={busy}
                    >
                      {row.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows?.length === 0 && <p className="mt-6 text-center text-sm text-gray-400">No centers yet.</p>}
    </div>
  );
}

function SubClassificationsTab() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<MasterSubClassification[] | null>(null);
  const [name, setName] = useState("");
  const [lifeC1, setLifeC1] = useState("");
  const [lifeC2, setLifeC2] = useState("");
  const [hasC2, setHasC2] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editLifeC1, setEditLifeC1] = useState("");
  const [editLifeC2, setEditLifeC2] = useState("");
  const [editHasC2, setEditHasC2] = useState(true);
  const [busy, setBusy] = useState(false);

  function load() {
    fetchMasterSubClassifications()
      .then(setRows)
      .catch((err) => showToast(err instanceof Error ? err.message : "Could not load sub classifications.", "error"));
  }

  useEffect(load, []);

  async function handleAdd() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createMasterSubClassification({
        name: name.trim(),
        defaultUsefulLifeC1Years: lifeC1 ? Number(lifeC1) : null,
        defaultUsefulLifeC2Years: hasC2 && lifeC2 ? Number(lifeC2) : null,
        hasComponent2: hasC2
      });
      showToast(`${name.trim()} added successfully.`);
      setName("");
      setLifeC1("");
      setLifeC2("");
      setHasC2(true);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add sub classification.", "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: MasterSubClassification) {
    setEditingId(row.id);
    setEditName(row.name);
    setEditLifeC1(row.defaultUsefulLifeC1Years?.toString() ?? "");
    setEditLifeC2(row.defaultUsefulLifeC2Years?.toString() ?? "");
    setEditHasC2(row.hasComponent2);
  }

  async function saveEdit(row: MasterSubClassification) {
    setBusy(true);
    try {
      const res = await updateMasterSubClassification(row.id, {
        name: editName.trim(),
        defaultUsefulLifeC1Years: editLifeC1 ? Number(editLifeC1) : null,
        defaultUsefulLifeC2Years: editHasC2 && editLifeC2 ? Number(editLifeC2) : null,
        hasComponent2: editHasC2
      });
      setEditingId(null);
      showToast(
        res.assetsUpdated
          ? `${res.name} updated — ${res.assetsUpdated} asset${res.assetsUpdated === 1 ? "" : "s"} updated.`
          : `${res.name} updated successfully.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save changes.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: MasterSubClassification) {
    setBusy(true);
    try {
      await updateMasterSubClassification(row.id, { active: !row.active });
      showToast(
        row.active
          ? `${row.name} deactivated. It's hidden from new selections but existing assets are unaffected.`
          : `${row.name} reactivated.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update sub classification.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Name</label>
          <input className={INPUT_CLASS} placeholder="e.g. X-Ray Machines" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Default C1 Life (yrs)</label>
          <input
            type="number"
            min={0}
            className={`${INPUT_CLASS} w-32`}
            placeholder="Optional"
            value={lifeC1}
            onChange={(e) => setLifeC1(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
            <input type="checkbox" checked={hasC2} onChange={(e) => setHasC2(e.target.checked)} />
            Has Component 2
          </label>
        </div>
        {hasC2 && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Default C2 Life (yrs)</label>
            <input
              type="number"
              min={0}
              className={`${INPUT_CLASS} w-32`}
              placeholder="Optional"
              value={lifeC2}
              onChange={(e) => setLifeC2(e.target.value)}
            />
          </div>
        )}
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleAdd}
          disabled={busy || !name.trim()}
        >
          Add Sub Classification
        </button>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead className="border-b-2 border-gray-300 bg-gray-50">
          <tr>
            <th className={TH_CLASS}>Name</th>
            <th className={TH_CLASS}>Default C1 Life</th>
            <th className={TH_CLASS}>Has C2</th>
            <th className={TH_CLASS}>Default C2 Life</th>
            <th className={TH_CLASS}>Used By</th>
            <th className={TH_CLASS}>Status</th>
            <th className={TH_CLASS}></th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row) => (
            <tr key={row.id} className="border-b border-gray-100">
              {editingId === row.id ? (
                <>
                  <td className={TD_CLASS}>
                    <input className={INPUT_CLASS} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </td>
                  <td className={TD_CLASS}>
                    <input
                      type="number"
                      min={0}
                      className={`${INPUT_CLASS} w-24`}
                      value={editLifeC1}
                      onChange={(e) => setEditLifeC1(e.target.value)}
                    />
                  </td>
                  <td className={TD_CLASS}>
                    <input type="checkbox" checked={editHasC2} onChange={(e) => setEditHasC2(e.target.checked)} />
                  </td>
                  <td className={TD_CLASS}>
                    {editHasC2 && (
                      <input
                        type="number"
                        min={0}
                        className={`${INPUT_CLASS} w-24`}
                        value={editLifeC2}
                        onChange={(e) => setEditLifeC2(e.target.value)}
                      />
                    )}
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:opacity-50"
                      onClick={() => saveEdit(row)}
                      disabled={busy || !editName.trim()}
                    >
                      Save
                    </button>
                    <button type="button" className="font-medium text-gray-500 hover:underline" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className={`${TD_CLASS} font-medium`}>{row.name}</td>
                  <td className={TD_CLASS}>{row.defaultUsefulLifeC1Years ?? "—"}</td>
                  <td className={TD_CLASS}>{row.hasComponent2 ? "Yes" : "No"}</td>
                  <td className={TD_CLASS}>{row.hasComponent2 ? (row.defaultUsefulLifeC2Years ?? "—") : "—"}</td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => startEdit(row)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="font-medium text-gray-500 hover:underline disabled:opacity-50"
                      onClick={() => toggleActive(row)}
                      disabled={busy}
                    >
                      {row.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows?.length === 0 && <p className="mt-6 text-center text-sm text-gray-400">No sub classifications yet.</p>}
    </div>
  );
}

function StatusesTab() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<MasterStatus[] | null>(null);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    fetchMasterStatuses()
      .then(setRows)
      .catch((err) => showToast(err instanceof Error ? err.message : "Could not load statuses.", "error"));
  }

  useEffect(load, []);

  async function handleAdd() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createMasterStatus({ name: name.trim() });
      showToast(`${name.trim()} added successfully.`);
      setName("");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add status.", "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: MasterStatus) {
    setEditingId(row.id);
    setEditName(row.name);
  }

  async function saveEdit(row: MasterStatus) {
    setBusy(true);
    try {
      const res = await updateMasterStatus(row.id, { name: editName.trim() });
      setEditingId(null);
      showToast(
        res.assetsUpdated
          ? `${res.name} updated — ${res.assetsUpdated} asset${res.assetsUpdated === 1 ? "" : "s"} updated.`
          : `${res.name} updated successfully.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save changes.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: MasterStatus) {
    setBusy(true);
    try {
      await updateMasterStatus(row.id, { active: !row.active });
      showToast(
        row.active
          ? `${row.name} deactivated. It's hidden from new selections but existing assets are unaffected.`
          : `${row.name} reactivated.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update status.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Name</label>
          <input className={INPUT_CLASS} placeholder="e.g. Loaned Out" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleAdd}
          disabled={busy || !name.trim()}
        >
          Add Status
        </button>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead className="border-b-2 border-gray-300 bg-gray-50">
          <tr>
            <th className={TH_CLASS}>Name</th>
            <th className={TH_CLASS}>Used By</th>
            <th className={TH_CLASS}>Status</th>
            <th className={TH_CLASS}></th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row) => (
            <tr key={row.id} className="border-b border-gray-100">
              {editingId === row.id ? (
                <>
                  <td className={TD_CLASS}>
                    <input className={INPUT_CLASS} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:opacity-50"
                      onClick={() => saveEdit(row)}
                      disabled={busy || !editName.trim()}
                    >
                      Save
                    </button>
                    <button type="button" className="font-medium text-gray-500 hover:underline" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className={`${TD_CLASS} font-medium`}>
                    <span className="flex items-center gap-2">
                      {row.name}
                      {row.systemManaged && (
                        <span
                          className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold text-white"
                          title="Set only by the Disposal flow — never manually pickable, and locked from rename or deactivation here."
                        >
                          System-managed
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-gray-300"
                      onClick={() => startEdit(row)}
                      disabled={row.systemManaged}
                      title={row.systemManaged ? "System-managed — cannot be edited." : undefined}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="font-medium text-gray-500 hover:underline disabled:cursor-not-allowed disabled:text-gray-300"
                      onClick={() => toggleActive(row)}
                      disabled={busy || row.systemManaged}
                      title={row.systemManaged ? "System-managed — cannot be deactivated." : undefined}
                    >
                      {row.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows?.length === 0 && <p className="mt-6 text-center text-sm text-gray-400">No statuses yet.</p>}
    </div>
  );
}

/** A role's permission-template editor — same PermissionMatrix as AdminPage.tsx's
 *  per-user Permissions panel, but seeded directly from the already-fetched role (no
 *  separate GET — RolesTab's list already carries every role's `grants`) and saved via
 *  a dedicated endpoint that only ever touches this role's template, never any user's
 *  actual access (see auth/permissions.ts's replaceRolePermissions). Works for a
 *  built-in role too — system_managed only locks name/active, not the template. */
function RolePermissionsPanel({ role, onClose, onSaved }: { role: MasterRole; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast();
  const [granted, setGranted] = useState<Set<string>>(new Set(role.grants.map((g) => `${g.module}:${g.action}`)));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const grants: PermissionGrant[] = Array.from(granted).map((key) => {
        const [module, action] = key.split(":");
        return { module: module!, action: action! };
      });
      await saveRolePermissions(role.id, grants);
      showToast(`${role.name}'s permission template updated.`);
      onSaved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save the template.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <LockIcon fontSize={18} />
            Permission Template — {role.name}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            What a user gets when created with this role, or reset to it — never changes an already-created user's own
            access.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <PermissionMatrix granted={granted} onChange={setGranted} />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button type="button" className="text-sm font-medium text-gray-500 hover:underline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RolesTab() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<MasterRole[] | null>(null);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [permissionsTarget, setPermissionsTarget] = useState<MasterRole | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    fetchMasterRoles()
      .then(setRows)
      .catch((err) => showToast(err instanceof Error ? err.message : "Could not load roles.", "error"));
  }

  useEffect(load, []);

  async function handleAdd() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createMasterRole({ name: name.trim(), grants: [] });
      showToast(`${name.trim()} added — define its permission template with "Permissions" below.`);
      setName("");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add role.", "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: MasterRole) {
    setEditingId(row.id);
    setEditName(row.name);
  }

  async function saveEdit(row: MasterRole) {
    setBusy(true);
    try {
      await updateMasterRole(row.id, { name: editName.trim() });
      setEditingId(null);
      showToast(`Renamed to ${editName.trim()}.`);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save changes.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: MasterRole) {
    setBusy(true);
    try {
      await updateMasterRole(row.id, { active: !row.active });
      showToast(
        row.active
          ? `${row.name} deactivated. It's hidden from the Create User dropdown but existing users are unaffected.`
          : `${row.name} reactivated.`
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update role.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Name</label>
          <input className={INPUT_CLASS} placeholder="e.g. Field Auditor" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={handleAdd}
          disabled={busy || !name.trim()}
        >
          Add Role
        </button>
        <p className="text-xs text-gray-400">Starts with an empty permission template — define it with "Permissions" below.</p>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead className="border-b-2 border-gray-300 bg-gray-50">
          <tr>
            <th className={TH_CLASS}>Name</th>
            <th className={TH_CLASS}>Permissions</th>
            <th className={TH_CLASS}>Used By</th>
            <th className={TH_CLASS}>Status</th>
            <th className={TH_CLASS}></th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row) => (
            <tr key={row.id} className="border-b border-gray-100">
              {editingId === row.id ? (
                <>
                  <td className={TD_CLASS}>
                    <input className={INPUT_CLASS} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </td>
                  <td className={TD_CLASS}>
                    {row.grants.length} grant{row.grants.length === 1 ? "" : "s"}
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:opacity-50"
                      onClick={() => saveEdit(row)}
                      disabled={busy || !editName.trim()}
                    >
                      Save
                    </button>
                    <button type="button" className="font-medium text-gray-500 hover:underline" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className={`${TD_CLASS} font-medium`}>
                    <span className="flex items-center gap-2">
                      {row.name}
                      {row.systemManaged && (
                        <span
                          className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold text-white"
                          title="A built-in role — name and active status are locked, but its permission template can still be edited."
                        >
                          Built-in
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    {row.grants.length} grant{row.grants.length === 1 ? "" : "s"}
                  </td>
                  <td className={TD_CLASS}>{row.usageCount}</td>
                  <td className={TD_CLASS}>
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className={`${TD_CLASS} space-x-2 text-right`}>
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => setPermissionsTarget(row)}>
                      Permissions
                    </button>
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-gray-300"
                      onClick={() => startEdit(row)}
                      disabled={row.systemManaged}
                      title={row.systemManaged ? "Built-in — cannot be renamed." : undefined}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="font-medium text-gray-500 hover:underline disabled:cursor-not-allowed disabled:text-gray-300"
                      onClick={() => toggleActive(row)}
                      disabled={busy || row.systemManaged}
                      title={row.systemManaged ? "Built-in — cannot be deactivated." : undefined}
                    >
                      {row.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows?.length === 0 && <p className="mt-6 text-center text-sm text-gray-400">No roles yet.</p>}

      {permissionsTarget && (
        <RolePermissionsPanel
          role={permissionsTarget}
          onClose={() => setPermissionsTarget(null)}
          onSaved={() => {
            setPermissionsTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}

export function MastersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("centers");

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <BookDatabaseIcon fontSize={20} />
          Masters
        </h1>
        {hasPermission(user, "masters", "edit") && TABS.find((t) => t.id === tab)?.bulkLabel && (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            onClick={() => navigate(`/bulk-upload?type=masters&list=${tab}`)}
          >
            <UploadIcon fontSize={14} />
            Bulk Import {TABS.find((t) => t.id === tab)?.bulkLabel}
          </button>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Manage the lists that Centers, Sub Classifications, Statuses, and Roles are picked from everywhere else in the
        app — Capitalization, Bulk Upload, Transfers, the Register's filters, and the Admin page's Create User form.
        Deactivating a value hides it from future picks without touching assets or users that already use it.
      </p>

      <div className="mt-4 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === t.id ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6 max-w-4xl rounded-xl bg-white p-6 shadow-sm">
        {tab === "centers" && <CentersTab />}
        {tab === "subClassifications" && <SubClassificationsTab />}
        {tab === "statuses" && <StatusesTab />}
        {tab === "roles" && <RolesTab />}
      </div>
    </div>
  );
}
