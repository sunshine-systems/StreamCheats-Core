"use client";

// Bottom status bar — minimal, monospace, reads like a terminal
// status line. Shows the build channel + a tiny attribution. Intentionally
// quiet so the eye doesn't compete with the CTA above.

export default function AppFooter() {
  return (
    <footer
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--kx-sp-4)",
        padding: "var(--kx-sp-3) var(--kx-sp-7)",
        borderTop: "1px solid var(--kx-border)",
        background: "rgba(10, 12, 16, 0.6)",
        fontFamily: "var(--kx-font-mono)",
        fontSize: 11,
        letterSpacing: "0.06em",
        color: "var(--kx-fg-muted)",
        textTransform: "uppercase",
      }}
    >
      <span>
        <span style={{ color: "var(--kx-fg-3)" }}>kmbox-net</span>
        {" · "}
        <span>local daemon</span>
      </span>
      <span>Sunshine Systems</span>
    </footer>
  );
}
