import { useEffect, useState } from "react";
import {
  ApiError,
  createAdminUser,
  fetchAdminUsers,
  fetchCenters,
  fetchMasterRoles,
  fetchUserPermissions,
  resetAdminUserPassword,
  saveUserPermissions,
  updateAdminUser,
  type AdminUser,
  type MasterRole,
  type PermissionGrant,
  type Role
} from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { PermissionMatrix } from "../components/PermissionMatrix.js";
import { AdminIcon, KeyIcon, LockIcon } from "../lib/icons.js";
import { useToast } from "../components/Toast.js";

const INPUT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const TH_CLASS = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600";
const TD_CLASS = "px-3 py-2 text-sm text-ink";

// The three built-in roles keep their existing distinct colors; any custom role (Roles
// master, MastersPage.tsx) gets one consistent neutral badge — simpler than inventing a
// color per custom role, and still visually distinguishes "one of the original three"
// from "something someone defined".
const BUILT_IN_ROLE_BADGE_CLASS: Record<string, string> = {
  viewer: "bg-gray-100 text-gray-600",
  editor: "bg-blue-100 text-blue-800",
  admin: "bg-ink text-white"
};
const CUSTOM_ROLE_BADGE_CLASS = "bg-purple-100 text-purple-800";

// Built-in role names are stored lowercase (matching every pre-existing user's `role`
// column, from before Roles became a Master) — capitalized only for display. A custom
// role keeps whatever casing its creator typed.
function roleDisplayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function StatusBadge({ status }: { status: AdminUser["status"] }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"
      }`}
    >
      {status === "active" ? "Active" : "Disabled"}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const cls = BUILT_IN_ROLE_BADGE_CLASS[role.toLowerCase()] ?? CUSTOM_ROLE_BADGE_CLASS;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{roleDisplayName(role)}</span>;
}

function RoleSelect({
  value,
  onChange,
  roles,
  disabled,
  title
}: {
  value: Role;
  onChange: (role: Role) => void;
  roles: MasterRole[];
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select className={INPUT_CLASS} value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)}>
      {roles
        // A deactivated role stays selectable if it's this field's current value (same
        // "already-in-use values stay visible" convention every other Masters-backed
        // dropdown in this app follows) — otherwise <select>'s value wouldn't match any
        // <option>.
        .filter((r) => r.active || r.name === value)
        .map((r) => (
          <option key={r.id} value={r.name}>
            {roleDisplayName(r.name)}
          </option>
        ))}
    </select>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

/** Shown once, right after a create or a reset — the only moment the plaintext temp
 *  password exists anywhere outside the admin's own head. Not persisted, not
 *  retrievable again; the admin has to relay it to the user out of band. */
function TempPasswordBanner({
  username,
  password,
  onDismiss
}: {
  username: string;
  password: string;
  onDismiss: () => void;
}) {
  const { showToast } = useToast();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onDismiss}>
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <KeyIcon fontSize={18} />
          Temporary password for {username}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Copy this now and share it with the user — it won't be shown again. They'll be required to set their own
          password the first time they sign in with it.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2">
          <code className="flex-1 select-all break-all text-sm font-semibold text-ink">{password}</code>
          <button
            type="button"
            className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100"
            onClick={() => {
              navigator.clipboard.writeText(password);
              showToast("Copied to clipboard.");
            }}
          >
            Copy
          </button>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
            onClick={onDismiss}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function permissionKey(p: PermissionGrant): string {
  return `${p.module}:${p.action}`;
}

/** Per-user slide-over — the shared PermissionMatrix, a "Reset to [role] template"
 *  bulk-apply per active role (grants come straight off the already-fetched roles
 *  list, no extra round trip), and one Save that replaces the user's entire grant set
 *  in a single request (matches the server's own replace-all contract, not incremental
 *  grant/revoke calls). Only reachable via the "Permissions" button, itself gated on
 *  admin:managePermissions — not every Admin necessarily holds it. */
function PermissionsPanel({
  target,
  isSelf,
  roles,
  onClose,
  onSaved
}: {
  target: AdminUser;
  isSelf: boolean;
  roles: MasterRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [centers, setCenters] = useState<string[]>([]);
  const [centerAccess, setCenterAccess] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([fetchUserPermissions(target.id), fetchCenters()])
      .then(([permRes, centerList]) => {
        setGranted(new Set(permRes.grants.map(permissionKey)));
        setCenterAccess(new Set(permRes.centerAccess));
        setCenters(centerList);
      })
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not load permissions.", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  function applyTemplate(role: MasterRole) {
    setGranted(new Set(role.grants.map(permissionKey)));
  }

  function toggleCenter(center: string) {
    setCenterAccess((prev) => {
      const next = new Set(prev);
      if (next.has(center)) next.delete(center);
      else next.add(center);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const grants: PermissionGrant[] = Array.from(granted).map((key) => {
        const [module, action] = key.split(":");
        return { module: module!, action: action! };
      });
      await saveUserPermissions(target.id, grants, Array.from(centerAccess));
      showToast(`${target.username}'s permissions updated.`);
      onSaved();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not save permissions.", "error");
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
            Permissions — {target.username}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Role label: <RoleBadge role={target.role} /> — a starting template only; toggles below are this user's
            actual access.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {roles
              .filter((r) => r.active)
              .map((role) => (
                <button
                  key={role.id}
                  type="button"
                  className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                  onClick={() => applyTemplate(role)}
                >
                  Reset to {roleDisplayName(role.name)} template
                </button>
              ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <h3 className="text-sm font-semibold text-ink">Center Access</h3>
            <p className="mt-1 text-xs text-gray-600">
              A second, independent narrowing on top of the permissions below — which centers' assets this user can
              see and act on. No centers selected means every center (unscoped), the default for everyone.
            </p>
            {loading ? (
              <div className="mt-3 h-16 animate-pulse rounded bg-amber-100" />
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {centers.map((center) => (
                    <label
                      key={center}
                      className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-gray-700"
                    >
                      <input type="checkbox" checked={centerAccess.has(center)} onChange={() => toggleCenter(center)} />
                      {center}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs font-medium text-amber-800">
                  {centerAccess.size === 0
                    ? "Unscoped — sees every center."
                    : `Scoped to ${centerAccess.size} center${centerAccess.size === 1 ? "" : "s"}.`}
                </p>
              </>
            )}
          </div>

          <div className="mt-4">
            <PermissionMatrix granted={granted} onChange={setGranted} loading={loading} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          {isSelf && (
            <p className="mr-auto text-xs text-gray-400">You can't remove your own Manage Permissions or Admin View.</p>
          )}
          <button type="button" className="text-sm font-medium text-gray-500 hover:underline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Prefers the built-in "viewer" role (the historical default) if it's active; falls
// back to whatever active role sorts first, or "" if every role has been deactivated
// (an edge case the create form's own validation already guards against submitting).
function defaultRoleName(roles: MasterRole[]): string {
  const active = roles.filter((r) => r.active);
  return active.find((r) => r.name.toLowerCase() === "viewer")?.name ?? active[0]?.name ?? "";
}

export function AdminPage() {
  const { user: me } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<MasterRole[]>([]);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState<Role>("");

  const [reveal, setReveal] = useState<{ username: string; password: string } | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<AdminUser | null>(null);
  const canManagePermissions = hasPermission(me, "admin", "managePermissions");

  function load() {
    fetchAdminUsers()
      .then(setRows)
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not load users.", "error"));
  }

  function loadRoles() {
    fetchMasterRoles()
      .then((list) => {
        setRoles(list);
        setRole((current) => current || defaultRoleName(list));
      })
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not load roles.", "error"));
  }

  useEffect(() => {
    load();
    loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    if (!username.trim() || !email.trim() || password.length < 8) return;
    setBusy(true);
    try {
      await createAdminUser({ username: username.trim(), email: email.trim(), password, role });
      setReveal({ username: username.trim(), password });
      setUsername("");
      setEmail("");
      setPassword("");
      setRole(defaultRoleName(roles));
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not create user.", "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: AdminUser) {
    setEditingId(row.id);
    setEditEmail(row.email);
    setEditRole(row.role);
  }

  async function saveEdit(row: AdminUser) {
    setBusy(true);
    try {
      await updateAdminUser(row.id, { email: editEmail.trim(), role: editRole });
      showToast(`${row.username} updated.`);
      setEditingId(null);
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not save changes.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(row: AdminUser) {
    setBusy(true);
    try {
      await updateAdminUser(row.id, { status: row.status === "active" ? "disabled" : "active" });
      showToast(row.status === "active" ? `${row.username} disabled.` : `${row.username} re-enabled.`);
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not update status.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(row: AdminUser) {
    setBusy(true);
    try {
      const { tempPassword } = await resetAdminUserPassword(row.id);
      setReveal({ username: row.username, password: tempPassword });
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not reset password.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <AdminIcon fontSize={20} />
        Admin
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Manage who can sign in to NephroAssets. Every create, disable, re-enable, role change, and password reset is
        logged.
      </p>

      <div className="mt-6 max-w-5xl rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Username</label>
            <input className={INPUT_CLASS} value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Email</label>
            <input
              className={INPUT_CLASS}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Temporary Password</label>
            <input
              className={INPUT_CLASS}
              type="text"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Role</label>
            <RoleSelect value={role} onChange={setRole} roles={roles} />
          </div>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleCreate}
            disabled={busy || !username.trim() || !email.trim() || password.length < 8}
          >
            Create User
          </button>
        </div>

        <table className="mt-4 w-full text-sm">
          <thead className="border-b-2 border-gray-300 bg-gray-50">
            <tr>
              <th className={TH_CLASS}>Username</th>
              <th className={TH_CLASS}>Email</th>
              <th className={TH_CLASS}>Status</th>
              <th className={TH_CLASS}>Role</th>
              <th className={TH_CLASS}>Last Login</th>
              <th className={TH_CLASS}></th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => {
              const isSelf = row.id === me?.id;
              return (
                <tr key={row.id} className="border-b border-gray-100">
                  {editingId === row.id ? (
                    <>
                      <td className={`${TD_CLASS} font-medium`}>{row.username}</td>
                      <td className={TD_CLASS}>
                        <input className={INPUT_CLASS} value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
                      </td>
                      <td className={TD_CLASS}>
                        <StatusBadge status={row.status} />
                      </td>
                      <td className={TD_CLASS}>
                        <RoleSelect
                          value={editRole}
                          onChange={setEditRole}
                          roles={roles}
                          disabled={isSelf}
                          title={isSelf ? "You can't change your own role." : undefined}
                        />
                      </td>
                      <td className={TD_CLASS}>{formatDateTime(row.lastLoginAt)}</td>
                      <td className={`${TD_CLASS} space-x-2 text-right`}>
                        <button
                          type="button"
                          className="font-medium text-accent hover:underline disabled:opacity-50"
                          onClick={() => saveEdit(row)}
                          disabled={busy || !editEmail.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="font-medium text-gray-500 hover:underline"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={`${TD_CLASS} font-medium`}>
                        {row.username}
                        {isSelf && <span className="ml-1.5 text-xs font-normal text-gray-400">(you)</span>}
                      </td>
                      <td className={TD_CLASS}>{row.email}</td>
                      <td className={TD_CLASS}>
                        <StatusBadge status={row.status} />
                      </td>
                      <td className={TD_CLASS}>
                        <RoleBadge role={row.role} />
                      </td>
                      <td className={TD_CLASS}>{formatDateTime(row.lastLoginAt)}</td>
                      <td className={`${TD_CLASS} space-x-2 text-right`}>
                        <button type="button" className="font-medium text-accent hover:underline" onClick={() => startEdit(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="font-medium text-gray-500 hover:underline disabled:opacity-50"
                          onClick={() => handleReset(row)}
                          disabled={busy}
                        >
                          Reset Password
                        </button>
                        <button
                          type="button"
                          className="font-medium text-gray-500 hover:underline disabled:opacity-50"
                          onClick={() => toggleStatus(row)}
                          disabled={busy || isSelf}
                          title={isSelf ? "You can't disable your own account." : undefined}
                        >
                          {row.status === "active" ? "Disable" : "Re-enable"}
                        </button>
                        {canManagePermissions && (
                          <button
                            type="button"
                            className="font-medium text-gray-500 hover:underline"
                            onClick={() => setPermissionsTarget(row)}
                          >
                            Permissions
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows?.length === 0 && <p className="mt-6 text-center text-sm text-gray-400">No users yet.</p>}
      </div>

      {reveal && (
        <TempPasswordBanner username={reveal.username} password={reveal.password} onDismiss={() => setReveal(null)} />
      )}

      {permissionsTarget && (
        <PermissionsPanel
          target={permissionsTarget}
          isSelf={permissionsTarget.id === me?.id}
          roles={roles}
          onClose={() => setPermissionsTarget(null)}
          onSaved={() => setPermissionsTarget(null)}
        />
      )}
    </div>
  );
}
