"use client";

// Sidebar copper-glow source-of-truth. Returns `true` when either the
// software updater (SC-4) OR the firmware updater (SC-10) is in a
// state the user can act on — `available`, `downloading`, `ready`,
// or (for firmware) `flashing`. AppShell uses this to tint the
// Updates icon copper per SC-5's "copper is reserved" rule.
//
// Both source hooks own their own polling, so this hook is a pure
// derivation — no extra network traffic. SC-8 (Experimental Support)
// can add a sibling hook (e.g. `useExperimentalActive`) and the same
// AppShell wiring will tint that icon copper too.
//
// Firmware-specific gate: the firmware portion ONLY counts when the
// daemon has parsed an `installed_version` from a heartbeat. Without
// a device present, any firmware `available` state is moot — the
// check ran against an unknown installed baseline and we'd be
// nagging the user about an update they can't apply. Software
// updates have no such gate (they apply to the desktop app, not the
// device) and are always counted.

import { useUpdater } from "./useUpdater";
import { useFirmwareStatus } from "./useFirmwareStatus";
import type { FirmwareStateKind } from "../api/firmware";
import type { UpdaterStateKind } from "../api/updater";

const SW_PENDING_KINDS: ReadonlySet<UpdaterStateKind> = new Set([
  "available",
  "downloading",
  "ready",
]);
// Firmware adds `flashing` to the pending set — a flash in flight is
// the strongest "something is happening, look here" signal we have.
const FW_PENDING_KINDS: ReadonlySet<FirmwareStateKind> = new Set([
  "available",
  "downloading",
  "ready",
  "flashing",
]);

export function useAnyUpdatePending(): boolean {
  const { state: softwareState } = useUpdater();
  const { status: firmwareStatus } = useFirmwareStatus();

  const softwareKind = softwareState?.kind;
  const firmwareKind = firmwareStatus?.state.kind;
  // Heartbeat-derived installed version is null until the daemon has
  // seen the device at least once. Mirror the gating used by
  // /updates and /updates/firmware so the sidebar glow agrees with
  // those pages.
  const deviceSeen = firmwareStatus?.installed_version != null;

  const swPending =
    softwareKind != null && SW_PENDING_KINDS.has(softwareKind);
  const fwPending =
    deviceSeen && firmwareKind != null && FW_PENDING_KINDS.has(firmwareKind);

  return swPending || fwPending;
}
