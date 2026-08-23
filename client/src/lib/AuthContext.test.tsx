import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext.js";
import { RequireAuth } from "../components/RequireAuth.js";
import { fetchAdminUsers, login } from "../api/client.js";

const mockUser = { id: 1, username: "admin", email: "admin@example.com", role: "admin", mustChangePassword: false };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// Covers the fix in api/client.ts + AuthContext.tsx: a session can die mid-use (12-hour
// expiry while a tab stays open, or an admin disabling the account — auth/middleware.ts
// on the server reads status fresh on every request, so that takes effect immediately).
// Before that fix, only the one component whose fetch happened to fail showed a "Not
// signed in" error while the rest of the app (sidebar, protected routes) kept rendering
// as if still authenticated. This is an integration test, not a mock of the event
// itself — it drives the real request() → dispatch → AuthContext listener → RequireAuth
// redirect chain via a real (mocked-at-the-fetch-boundary) 401 response.
describe("AuthContext: session dies mid-use (no page reload)", () => {
  it("clears the signed-in user and redirects a RequireAuth-protected route to /login when a later request comes back 401 UNAUTHENTICATED", async () => {
    const fetchMock = vi
      .fn()
      // 1) AuthProvider's initial mount check: GET /api/auth/me — session is valid.
      .mockResolvedValueOnce(jsonResponse({ user: mockUser }))
      // 2) Some later, unrelated request after the session has since died server-side.
      .mockResolvedValueOnce(jsonResponse({ error: "Not signed in.", code: "UNAUTHENTICATED" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/protected"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>Login Page</div>} />
            <Route
              path="/protected"
              element={
                <RequireAuth>
                  <div>Protected Content</div>
                </RequireAuth>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Initial session check resolves; the protected route renders normally.
    await screen.findByText("Protected Content");

    // A real API call, through the real request() helper — not a synthetic event —
    // comes back 401. It should reject (the caller still sees the failure)...
    await expect(fetchAdminUsers()).rejects.toThrow();

    // ...and *also* have flipped the app to signed-out: RequireAuth re-renders and
    // redirects, without any page reload.
    await screen.findByText("Login Page");
    expect(screen.queryByText("Protected Content")).toBeNull();
  });

  it("does NOT treat a 401 from the login endpoint itself as a dead session, even if it carried the same UNAUTHENTICATED code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: null }, 401)) // initial /me: not signed in yet
      // Deliberately tagged with the same code the real dead-session case uses, to prove
      // it's api/client.ts's explicit path!=="/api/auth/login" check doing the
      // excluding here — not just this response happening to lack a `code` field.
      .mockResolvedValueOnce(jsonResponse({ error: "Invalid username or password.", code: "UNAUTHENTICATED" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    let dispatched = false;
    window.addEventListener("auth:unauthenticated", () => {
      dispatched = true;
    });

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>Login Page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByText("Login Page");

    // Calling the raw API function directly (not AuthContext's wrapped login, which
    // catches this) — the point here is only whether request() dispatched the event.
    await expect(login("someone", "wrong-password")).rejects.toThrow();
    expect(dispatched).toBe(false);
  });
});

// Covers the fix in persistedUiState.ts + AuthContext.tsx: client-only UI state (Register
// filters, column layout, sidebar collapsed, and anything added later that follows the
// same "nephroassets."-prefixed naming convention) must not survive a logout on a shared/
// kiosk browser — otherwise the next person to sign in sees the previous user's filters.
// Seeds both storages with a mix of prefixed and unrelated keys so these tests also prove
// the sweep doesn't overreach.
describe("AuthContext: clears persisted client UI state on logout", () => {
  function seedStorage() {
    localStorage.setItem("nephroassets.register.myView", "{}");
    localStorage.setItem("nephroassets.sidebarCollapsed", "true");
    sessionStorage.setItem("nephroassets.filters", '{"search":"FAR-1"}');
    // Unrelated keys some other library/browser feature might set — must survive.
    localStorage.setItem("some-other-lib.setting", "keep-me");
    sessionStorage.setItem("unrelated", "keep-me-too");
  }

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  function SignOutButton() {
    const { logout } = useAuth();
    return (
      <button type="button" onClick={() => logout()}>
        Sign Out
      </button>
    );
  }

  it("sweeps nephroassets.*-prefixed keys from both storages on an explicit Sign Out, leaving unrelated keys alone", async () => {
    seedStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: mockUser })) // initial /me
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // POST /api/auth/logout
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider>
        <SignOutButton />
      </AuthProvider>
    );

    fireEvent.click(await screen.findByText("Sign Out"));
    // fetchMock's call count ticks up the instant fetch() is invoked, not once its
    // promise resolves — waiting on it would race ahead of logout()'s `finally` block
    // (which awaits apiLogout() first). Wait on the actual end-state instead.
    await vi.waitFor(() => expect(localStorage.getItem("nephroassets.register.myView")).toBeNull());

    expect(localStorage.getItem("nephroassets.register.myView")).toBeNull();
    expect(localStorage.getItem("nephroassets.sidebarCollapsed")).toBeNull();
    expect(sessionStorage.getItem("nephroassets.filters")).toBeNull();
    expect(localStorage.getItem("some-other-lib.setting")).toBe("keep-me");
    expect(sessionStorage.getItem("unrelated")).toBe("keep-me-too");
  });

  it("also sweeps on a forced logout (session dies mid-use)", async () => {
    seedStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ user: mockUser })) // initial /me
      .mockResolvedValueOnce(jsonResponse({ error: "Not signed in.", code: "UNAUTHENTICATED" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/protected"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>Login Page</div>} />
            <Route
              path="/protected"
              element={
                <RequireAuth>
                  <div>Protected Content</div>
                </RequireAuth>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByText("Protected Content");
    await expect(fetchAdminUsers()).rejects.toThrow();
    await screen.findByText("Login Page");

    expect(localStorage.getItem("nephroassets.register.myView")).toBeNull();
    expect(localStorage.getItem("nephroassets.sidebarCollapsed")).toBeNull();
    expect(sessionStorage.getItem("nephroassets.filters")).toBeNull();
    expect(localStorage.getItem("some-other-lib.setting")).toBe("keep-me");
    expect(sessionStorage.getItem("unrelated")).toBe("keep-me-too");
  });
});
