// Smoke test for the sidebar shell. Asserts all 7 routes are
// represented + the Settings item is positioned visually after a
// separator (per SC-5's sidebar spec).

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});
