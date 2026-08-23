import { useEffect, useState } from "react";
import {
  ApiError,
  createAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
  updateAdminUser,
  type AdminUser
} from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { AdminIcon, KeyIcon } from "../lib/icons.js";
import { useToast } from "../components/Toast.js";

const INPUT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const TH_CLASS = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600";
const TD_CLASS = "px-3 py-2 text-sm text-ink";

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

export function AdminPage() {
  const { user: me } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editIsAdmin, setEditIsAdmin] = useState(false);

  const [reveal, setReveal] = useState<{ username: string; password: string } | null>(null);

  function load() {
    fetchAdminUsers()
      .then(setRows)
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not load users.", "error"));
  }

  useEffect(load, []);

  async function handleCreate() {
    if (!username.trim() || !email.trim() || password.length < 8) return;
    setBusy(true);
    try {
      await createAdminUser({ username: username.trim(), email: email.trim(), password, isAdmin });
      setReveal({ username: username.trim(), password });
      setUsername("");
      setEmail("");
      setPassword("");
      setIsAdmin(false);
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
    setEditIsAdmin(row.isAdmin);
  }

  async function saveEdit(row: AdminUser) {
    setBusy(true);
    try {
      await updateAdminUser(row.id, { email: editEmail.trim(), isAdmin: editIsAdmin });
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
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-gray-600">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            Admin
          </label>
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
              <th className={TH_CLASS}>Admin</th>
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
                        <input
                          type="checkbox"
                          checked={editIsAdmin}
                          disabled={isSelf}
                          title={isSelf ? "You can't remove your own admin access." : undefined}
                          onChange={(e) => setEditIsAdmin(e.target.checked)}
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
                      <td className={TD_CLASS}>{row.isAdmin ? "Yes" : "—"}</td>
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
    </div>
  );
}
