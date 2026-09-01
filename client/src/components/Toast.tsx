import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ErrorIcon, PassIcon } from "../lib/icons.js";

type ToastVariant = "success" | "error";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Success toasts get out of the way quickly; errors stay up longer since there's more
// to read and the user may need to act on them. Both can also be dismissed manually.
const AUTO_DISMISS_MS: Record<ToastVariant, number> = { success: 4000, error: 6000 };

// Mounted once at the app root (App.tsx) so every page/modal can call useToast() — the
// single shared success/error confirmation surface for the whole app, replacing the
// inline "success" panels and banners each page used to build on its own.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = "success", action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant, action }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`flex items-center gap-2 rounded-md py-2.5 pl-4 pr-3 text-sm font-medium shadow-lg ${
              t.variant === "error" ? "bg-accent text-white" : "bg-ink text-white"
            }`}
          >
            {t.variant === "error" ? <ErrorIcon fontSize={16} /> : <PassIcon fontSize={16} className="text-brand-teal" />}
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="shrink-0 whitespace-nowrap text-xs font-semibold underline decoration-white/50 underline-offset-2 hover:decoration-white"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="ml-2 rounded p-0.5 text-white/60 hover:text-white"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
