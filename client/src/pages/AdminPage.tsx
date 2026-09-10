import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { AdminIcon, DisableUserIcon, EditIcon, KeyIcon, LockIcon, MoreVerticalIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Card } from "../components/ui/Card.js";
import { Button } from "../components/ui/Button.js";
import { Field, fieldControlClass, Input } from "../components/ui/FormField.js";
import { RoleBadge, roleDisplayName } from "../components/ui/RoleBadge.js";
import { useToast } from "../components/Toast.js";

const TH_CLASS = "px-4 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-600";
const TD_CLASS = "px-4 py-3 text-sm text-ink align-middle";

function StatusBadge({ status }: { status: AdminUser["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex w-fit items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
      Disabled
    </span>
  );
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
    <select
      className={`${fieldControlClass} w-full`}
      value={value}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.value)}
    >
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

// The ⋮ menu for a row's less-common actions — same click-outside pattern as
// UserMenu.tsx, but rendered through a portal: the table sits inside an
// overflow-hidden bordered container (for clean rounded corners), which would clip an
// absolutely-positioned dropdown opened on a row near the bottom edge. Edit stays a
// standalone button since it's the action taken most often.
function ActionMenu({
  row,
  isSelf,
  busy,
  canManagePermissions,
  onReset,
  onToggleStatus,
  onPermissions
}: {
  row: AdminUser;
  isSelf: boolean;
  busy: boolean;
  canManagePermissions: boolean;
  onReset: () => void;
  onToggleStatus: () => void;
  onPermissions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Estimated menu height (3 items) — flips the menu to open upward when the button
  // sits too close to the bottom of the viewport for it to fit below, same as any
  // fixed-position dropdown opened near the fold.
  const MENU_HEIGHT_ESTIMATE = 150;

  function toggle() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const right = window.innerWidth - rect.right;
      if (window.innerHeight - rect.bottom < MENU_HEIGHT_ESTIMATE) {
        setCoords({ bottom: window.innerHeight - rect.top + 4, right });
      } else {
        setCoords({ top: rect.bottom + 4, right });
      }
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label="More actions"
        className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
        onClick={toggle}
      >
        <MoreVerticalIcon fontSize={18} />
      </button>
      {open &&
        coords &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              style={{ top: coords.top, bottom: coords.bottom, right: coords.right }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setOpen(false);
                  onReset();
                }}
                disabled={busy}
              >
                <KeyIcon fontSize={16} />
                Reset Password
              </button>
              {canManagePermissions && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-slate-50"
                  onClick={() => {
                    setOpen(false);
                    onPermissions();
                  }}
                >
                  <LockIcon fontSize={16} />
                  View Permissions
                </button>
              )}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-700"
                onClick={() => {
                  setOpen(false);
                  onToggleStatus();
                }}
                disabled={busy || isSelf}
                title={isSelf ? "You can't disable your own account." : undefined}
              >
                <DisableUserIcon fontSize={16} />
                {row.status === "active" ? "Disable Account" : "Re-enable Account"}
              </button>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

export function AdminPage() {
  const { user: me } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<MasterRole[]>([]);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
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
      await createAdminUser({
        username: username.trim(),
        email: email.trim(),
        password,
        role,
        // Omitted (not an empty string) when left blank, so the server's own
        // email-prefix fallback applies rather than persisting a blank string.
        ...(displayName.trim() ? { displayName: displayName.trim() } : {})
      });
      setReveal({ username: username.trim(), password });
      setUsername("");
      setEmail("");
      setDisplayName("");
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
    setEditDisplayName(row.displayName);
    setEditRole(row.role);
  }

  async function saveEdit(row: AdminUser) {
    setBusy(true);
    try {
      await updateAdminUser(row.id, {
        email: editEmail.trim(),
        role: editRole,
        // Only sent when actually changed from the pre-filled value — that pre-fill is
        // row.displayName, which for a user who's never set one IS the email-prefix
        // fallback, not a real stored value. Sending it back untouched would lock in
        // that fallback as an explicit display_name, so it'd stop tracking a later
        // email change — an unintended side effect of an edit that never touched the name.
        ...(editDisplayName.trim() !== row.displayName ? { displayName: editDisplayName.trim() } : {})
      });
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
      <PageHeader
        icon={AdminIcon}
        title="Admin"
        bordered={false}
        subtitle="Manage who can sign in to NephroAssets. Every create, disable, re-enable, role change, and password reset is
        logged."
      />

      <Card className="mt-6 max-w-5xl p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-ink">+ Add New User</h2>
          <p className="mt-0.5 text-sm text-gray-500">Create a login for a new team member and assign their starting role.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Username" htmlFor="new-username">
            <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="new-email">
            <Input id="new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Display Name" htmlFor="new-display-name">
            <Input
              id="new-display-name"
              placeholder="Optional — defaults to email"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field label="Role" htmlFor="new-role">
            <RoleSelect value={role} onChange={setRole} roles={roles} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <Field label="Temporary Password" htmlFor="new-password" className="min-w-[240px] flex-1">
            <Input
              id="new-password"
              type="text"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button onClick={handleCreate} disabled={busy || !username.trim() || !email.trim() || password.length < 8}>
            Create User
          </Button>
        </div>
      </Card>

      <div className="mt-6 max-w-5xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className={TH_CLASS}>Username</th>
                <th className={TH_CLASS}>Display Name</th>
                <th className={TH_CLASS}>Email</th>
                <th className={TH_CLASS}>Status</th>
                <th className={TH_CLASS}>Role</th>
                <th className={TH_CLASS}>Last Login</th>
                <th className={`${TH_CLASS} min-w-[160px]`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows?.map((row) => {
                const isSelf = row.id === me?.id;
                return (
                  <tr key={row.id} className="transition-colors hover:bg-slate-50/60">
                    {editingId === row.id ? (
                      <>
                        <td className={`${TD_CLASS} font-medium`}>{row.username}</td>
                        <td className={TD_CLASS}>
                          <Input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} />
                        </td>
                        <td className={TD_CLASS}>
                          <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
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
                        <td className={`${TD_CLASS} min-w-[160px]`}>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <Button
                              size="sm"
                              onClick={() => saveEdit(row)}
                              disabled={busy || !editEmail.trim() || !editDisplayName.trim()}
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={`${TD_CLASS} font-medium`}>
                          <div className="flex items-center gap-1.5">
                            {row.username}
                            {isSelf && (
                              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                                (you)
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={TD_CLASS}>{row.displayName}</td>
                        <td className={TD_CLASS}>{row.email}</td>
                        <td className={TD_CLASS}>
                          <StatusBadge status={row.status} />
                        </td>
                        <td className={TD_CLASS}>
                          <RoleBadge role={row.role} />
                        </td>
                        <td className={TD_CLASS}>{formatDateTime(row.lastLoginAt)}</td>
                        <td className={`${TD_CLASS} min-w-[160px]`}>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <Button size="sm" variant="secondary" onClick={() => startEdit(row)}>
                              <EditIcon fontSize={14} />
                              Edit
                            </Button>
                            <ActionMenu
                              row={row}
                              isSelf={isSelf}
                              busy={busy}
                              canManagePermissions={canManagePermissions}
                              onReset={() => handleReset(row)}
                              onToggleStatus={() => toggleStatus(row)}
                              onPermissions={() => setPermissionsTarget(row)}
                            />
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        {rows?.length === 0 && <p className="px-4 py-10 text-center text-sm text-gray-400">No users yet.</p>}
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
