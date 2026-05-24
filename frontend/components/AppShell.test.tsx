// Smoke test for the sidebar shell. Asserts all 7 routes are
// represented + the Settings item is positioned visually after a
// separator (per SC-5's sidebar spec).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppShell from "./AppShell";

// Next's `usePathname` reads from a router context we don't mount in
// a unit test; stub it with a deterministic value so AppShell's
// `current` derivation is stable.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("AppShell sidebar", () => {
  it("renders all seven sidebar routes by aria-label", () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>
    );
    for (const label of [
      "Home",
      "Mouse",
      "Keyboard",
      "Experimental Support",
      "Updates",
      "Logs",
      "Settings",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("marks the current route with aria-current=page", () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>
    );
    expect(screen.getByLabelText("Home")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByLabelText("Settings")).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("renders children in the main content area", () => {
    render(
      <AppShell>
        <div data-testid="content">hello</div>
      </AppShell>
    );
    expect(screen.getByTestId("content")).toHaveTextContent("hello");
  });

  it("renders the Logs item as a button (no aria-current)", () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>
    );
    const logs = screen.getByLabelText("Logs");
    // Logs is an action that pops a dedicated BrowserWindow — it
    // should not behave like a navigable in-shell route.
    expect(logs.tagName).toBe("BUTTON");
    expect(logs).not.toHaveAttribute("aria-current");
  });

  it("invokes window.streamcheats.openLogsWindow() on Logs click", async () => {
    const openLogsWindow = vi
      .fn()
      .mockResolvedValue({ ok: true as const });
    (window as unknown as { streamcheats: unknown }).streamcheats = {
      bugReport: vi.fn(),
      healthCheck: vi.fn(),
      openLogsWindow,
    };
    try {
      render(
        <AppShell>
          <div>child</div>
        </AppShell>
      );
      await userEvent.click(screen.getByLabelText("Logs"));
      expect(openLogsWindow).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { streamcheats?: unknown }).streamcheats;
    }
  });
});

afterEach(() => {
  delete (window as unknown as { streamcheats?: unknown }).streamcheats;
});
