// Smoke + phase-transition tests for FlashStepperModal (Updates restructure).
//
// We mount the modal in different `status.state.kind` / `phase`
// configurations and assert the rendered step copy matches. Schema
// drift is covered separately by the contract tests; here we're only
// checking the renderer's state-machine routing.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FlashStepperModal, { type FlashIntent } from "./FlashStepperModal";
import type { FirmwareStatusResponse } from "../../lib/api/firmware";
import {
  firmwareStatusFailed,
  firmwareStatusFlashing,
  firmwareStatusReady,
  firmwareStatusUpToDate,
} from "../../test/msw/fixtures";

// Helper: render the modal with `firmwareStatusFlashing` first so the
// component latches `sawFlashing = true`, then re-render with a
// terminal status. Mirrors the real flow: parent's status hook polls
// through Flashing → UpToDate (or Flashing → Failed).
function renderThroughFlashing(terminal: FirmwareStatusResponse) {
  const { rerender, ...rest } = render(
    <FlashStepperModal {...baseProps} status={firmwareStatusFlashing} />
  );
  rerender(<FlashStepperModal {...baseProps} status={terminal} />);
  return { rerender, ...rest };
}

const releaseIntent: FlashIntent = {
  kind: "release",
  version: "rel-5.17",
  installed: "rel-5.16",
  downgrade: false,
};

const baseProps = {
  intent: releaseIntent,
  open: true,
  onClose: vi.fn(),
  onRetry: vi.fn(),
  onConfirm: vi.fn().mockResolvedValue({ ok: true }),
  onCancel: vi.fn().mockResolvedValue(undefined),
};

function withPhase(
  base: FirmwareStatusResponse,
  phase: "starting" | "waiting_for_device" | "programming" | "booting"
): FirmwareStatusResponse {
  if (base.state.kind !== "flashing") return base;
  return {
    ...base,
    state: { ...base.state, phase },
  };
}

describe("FlashStepperModal", () => {
  it("renders the Confirm step when no flash is in flight", () => {
    render(<FlashStepperModal {...baseProps} status={firmwareStatusReady} />);
    expect(screen.getByText("Flash rel-5.17?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Flash$/ })
    ).toBeInTheDocument();
  });

  it("renders the reinstall message and disables Flash when loader_ready is false", () => {
    const status: FirmwareStatusResponse = {
      ...firmwareStatusReady,
      loader_ready: false,
    };
    render(<FlashStepperModal {...baseProps} status={status} />);
    expect(
      screen.getByText(/Flash tool is missing — please reinstall/i)
    ).toBeInTheDocument();
    const flashBtn = screen.getByRole("button", { name: /^Flash$/ });
    expect(flashBtn).toBeDisabled();
  });

  it("renders the WaitingForDevice step on phase=waiting_for_device", () => {
    render(
      <FlashStepperModal
        {...baseProps}
        status={withPhase(firmwareStatusFlashing, "waiting_for_device")}
      />
    );
    expect(
      screen.getByText(/Press the white button on your Teensy/i)
    ).toBeInTheDocument();
    // 60s daemon timeout should round to ~60s remaining on first render.
    expect(screen.getByText(/Waiting…/)).toBeInTheDocument();
    // Cancel button is present in this phase only.
    expect(
      screen.getByRole("button", { name: /^Cancel$/ })
    ).toBeInTheDocument();
  });

  it("renders the Programming step on phase=programming", () => {
    render(
      <FlashStepperModal
        {...baseProps}
        status={withPhase(firmwareStatusFlashing, "programming")}
      />
    );
    expect(screen.getByText(/Flashing…/i)).toBeInTheDocument();
    // No cancel during programming — interrupting mid-write bricks the device.
    expect(
      screen.queryByRole("button", { name: /^Cancel$/ })
    ).not.toBeInTheDocument();
  });

  it("renders the Booting step on phase=booting", () => {
    render(
      <FlashStepperModal
        {...baseProps}
        status={withPhase(firmwareStatusFlashing, "booting")}
      />
    );
    expect(screen.getByText(/Almost done…/i)).toBeInTheDocument();
  });

  it("renders the Done step on kind=up_to_date after observing flashing", async () => {
    // Real flow: status hook polls Flashing → UpToDate. The modal
    // latches `sawFlashing` on the first observation of `flashing`
    // and treats the subsequent `up_to_date` as terminal success.
    // The latch lives in component state and is set during the
    // post-transition render, so `waitFor` handles the React commit
    // sequence cleanly.
    renderThroughFlashing(firmwareStatusUpToDate);
    await waitFor(() =>
      expect(screen.getByText(/Flash complete\./i)).toBeInTheDocument()
    );
  });

  it("Bug 2 — renders the Confirm step on kind=up_to_date when no flash was observed", () => {
    // Regression: after a previous flash succeeded the daemon's
    // resting state is `up_to_date`. The pre-fix modal routed
    // purely off `kind === "up_to_date"` and rendered DoneStep,
    // which left the modal pinned to "Flash complete." on every
    // subsequent re-open — users couldn't flash a second device.
    // With the `sawFlashing` latch, a fresh mount on a resting
    // `up_to_date` status lands on Confirm.
    render(
      <FlashStepperModal {...baseProps} status={firmwareStatusUpToDate} />
    );
    expect(screen.getByText("Flash rel-5.17?")).toBeInTheDocument();
    expect(screen.queryByText(/Flash complete\./i)).not.toBeInTheDocument();
  });

  it("Bug 2 — a freshly-mounted modal on up_to_date renders Confirm for a new flash attempt", async () => {
    // Simulate: user flashes rel-5.17 (Flashing → UpToDate, modal
    // shows Done), closes it. The parent (/updates/firmware) bumps
    // the modal's `key` for the next Flash click — React unmounts
    // the previous modal and mounts a fresh instance with
    // sawFlashing=false. The new attempt lands on Confirm even
    // though the daemon is sitting in `up_to_date` from the
    // previous flash.
    const { unmount } = render(
      <FlashStepperModal {...baseProps} status={firmwareStatusFlashing} />
    );
    // Drive through the Flashing → UpToDate transition to set the
    // first mount into the Done state, then unmount it (mirrors the
    // user closing the modal after success).
    unmount();
    // Fresh mount on a daemon that's still resting in up_to_date —
    // this is the second Flash click. Without the fix this would
    // render DoneStep; with the fix (sawFlashing initial=false on
    // fresh mount) it correctly renders Confirm.
    const nextIntent: FlashIntent = {
      kind: "release",
      version: "rel-5.16",
      installed: "rel-5.17",
      downgrade: true,
    };
    render(
      <FlashStepperModal
        {...baseProps}
        intent={nextIntent}
        status={firmwareStatusUpToDate}
      />
    );
    expect(screen.getByText("Flash rel-5.16?")).toBeInTheDocument();
    expect(screen.queryByText(/Flash complete\./i)).not.toBeInTheDocument();
  });

  it("renders the Failed step with friendly copy for wait_for_device_timeout", () => {
    const status: FirmwareStatusResponse = {
      ...firmwareStatusFailed,
      state: {
        kind: "failed",
        error: "wait_for_device_timeout",
        when: "2026-05-22T18:01:00Z",
      },
    };
    render(<FlashStepperModal {...baseProps} status={status} />);
    expect(
      screen.getByText(/Didn't see a button press\./i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Try again/i })
    ).toBeInTheDocument();
  });

  it("renders the Failed step with friendly copy for user_cancelled", () => {
    const status: FirmwareStatusResponse = {
      ...firmwareStatusFailed,
      state: {
        kind: "failed",
        error: "user_cancelled",
        when: "2026-05-22T18:01:00Z",
      },
    };
    render(<FlashStepperModal {...baseProps} status={status} />);
    expect(screen.getByText(/Flash cancelled\./i)).toBeInTheDocument();
  });

  it("is invisible when open=false", () => {
    const { container } = render(
      <FlashStepperModal
        {...baseProps}
        open={false}
        status={firmwareStatusReady}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
