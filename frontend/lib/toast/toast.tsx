"use client";

// Minimal toast provider — no external deps. Stacks toasts top-right,
// auto-dismisses after 5 s, supports three severity levels (success
// green, warning amber, error red).

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ToastSeverity = "success" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  severity: ToastSeverity;
}

interface ToastContextValue {
  show: (message: string, severity: ToastSeverity) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, severity: ToastSeverity) => {
    const t = { id: nextId++, message, severity };
    setToasts((prev) => [...prev, t]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() must be used inside <ToastProvider>");
  }
  return ctx;
}

function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const palette: Record<ToastSeverity, { border: string; fg: string }> = {
    success: {
      border: "var(--kx-border-glow)",
      fg: "var(--kx-accent)",
    },
    warning: {
      border: "rgba(255, 209, 102, 0.4)",
      fg: "var(--kx-warning)",
    },
    error: {
      border: "rgba(255, 107, 122, 0.4)",
      fg: "var(--kx-danger)",
    },
  };
  const c = palette[toast.severity];

  return (
    <div
      role="status"
      style={{
        background: "var(--kx-surface)",
        color: "var(--kx-fg)",
        border: `1px solid ${c.border}`,
        borderLeft: `3px solid ${c.fg}`,
        borderRadius: "var(--kx-r-md)",
        padding: "10px 14px",
        minWidth: 240,
        maxWidth: 480,
        fontFamily: "var(--kx-font-sans)",
        fontSize: "var(--kx-fs-13)",
        lineHeight: 1.45,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        pointerEvents: "auto",
        cursor: "pointer",
        backdropFilter: "blur(4px)",
      }}
      onClick={onDismiss}
    >
      {toast.message}
    </div>
  );
}
