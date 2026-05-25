"use client";

// Minimal modal primitive: fixed full-viewport backdrop + centered
// panel. Designed for the narrow Electron host window (730-970px) so
// the panel max-width is clamped well below that.
//
// Behaviours:
//   * Escape closes (unless `dismissible={false}`).
//   * Backdrop click closes (unless `dismissible={false}`).
//   * Body scroll is locked while open.
//   * `aria-modal` + `role="dialog"` for AT.
//
// Open/close state is owned by the caller (a `useState(false)` flag).
// We intentionally do NOT trap focus or render a portal — the app is
// a single Electron BrowserWindow with no other interactive chrome
// behind the backdrop, so a vanilla fixed overlay is sufficient.

import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * When false, neither Esc nor backdrop click will close the modal.
   * Used to block dismissal while a long-running action is in flight.
   * Defaults to true.
   */
  dismissible?: boolean;
  /** Optional aria-label for the dialog. */
  "aria-label"?: string;
  /** Optional id of a heading element inside the modal. */
  "aria-labelledby"?: string;
  children: ReactNode;
}

export default function Modal({
  open,
  onClose,
  dismissible = true,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  children,
}: ModalProps) {
  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);

  // Lock body scroll while open. Restored on close + unmount.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const handleBackdropClick = () => {
    if (dismissible) onClose();
  };

  return (
    <div
      // Backdrop: substrate at 80% + subtle blur. Sits above the
      // sidebar (z-10) so the modal is unambiguously above all chrome.
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-substrate/80 backdrop-blur-sm p-4"
      aria-hidden={false}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        // Stop click bubbling so clicks inside the panel don't trip the
        // backdrop close handler.
        onClick={(e) => e.stopPropagation()}
        className="
          relative w-full max-w-[420px]
          bg-panel border border-hairline rounded-[12px]
          p-5
          shadow-[0_8px_32px_rgba(0,0,0,0.35)]
        "
      >
        {children}
      </div>
    </div>
  );
}
