import { createContext, useContext, useState, type ReactNode } from "react";

// A lightweight demo gate for sharing client previews — not real security (credentials
// are visible in the client bundle and this check is client-side only). Good enough to
// keep casual visitors out of a shared preview link; not a substitute for real auth if
// this app ever handles real data in production.
export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "nephro2026";

const STORAGE_KEY = "nephroassets.authed";

interface AuthContextValue {
  isAuthenticated: boolean;
  login: (username: string, password: string) => boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");

  const login = (username: string, password: string): boolean => {
    const ok = username === DEMO_USERNAME && password === DEMO_PASSWORD;
    if (ok) {
      localStorage.setItem(STORAGE_KEY, "true");
      setIsAuthenticated(true);
    }
    return ok;
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setIsAuthenticated(false);
  };

  return <AuthContext.Provider value={{ isAuthenticated, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
