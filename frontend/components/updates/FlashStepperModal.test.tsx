// Smoke + phase-transition tests for FlashStepperModal (Updates restructure).
//
// We mount the modal in different `status.state.kind` / `phase`
// configurations and assert the rendered step copy matches. Schema
// drift is covered separately by the contract tests; here we're only
// checking the renderer's state-machine routing.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FlashStepperModal, { type FlashIntent } from "./FlashStepperModal";
import type { FirmwareStatusResponse } from "../../lib/api/firmware";
import {
  firmwareStatusFailed,
  firmwareStatusFlashing,
  firmwareStatusReady,
  firmwareStatusUpToDate,
} from "../../test/msw/fixtures";

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
  onEnsureLoader: vi
    .fn()
    .mockResolvedValue({ ready: true, path: "x", sha256_verified: true }),
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

  it("renders Download flash tool when loader_ready is false (SC-14)", () => {
    const status: FirmwareStatusResponse = {
      ...firmwareStatusReady,
      loader_ready: false,
    };
    render(<FlashStepperModal {...baseProps} status={status} />);
    expect(
      screen.getByRole("button", { name: /Download flash tool/i })
    ).toBeInTheDocument();
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

  it("renders the Done step on kind=up_to_date (post-flash terminal)", () => {
    render(
      <FlashStepperModal {...baseProps} status={firmwareStatusUpToDate} />
    );
    expect(screen.getByText(/Flash complete\./i)).toBeInTheDocument();
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
