"use client";

// Sidebar copper-glow source-of-truth. Returns `true` when either the
// software updater (SC-4) OR the firmware updater (SC-10) is in a
// state the user can act on — `available`, `downloading`, or `ready`.
// AppShell uses this to tint the Updates icon copper per SC-5's
// "copper is reserved" rule.
//
// Both source hooks own their own polling, so this hook is a pure
// derivation — no extra network traffic. SC-8 (Experimental Support)
// can add a sibling hook (e.g. `useExperimentalActive`) and the same
// AppShell wiring will tint that icon copper too.

import { useUpdater } from "./useUpdater";
import { useFirmwareStatus } from "./useFirmwareStatus";
import type { FirmwareStateKind } from "../api/firmware";
import type { UpdaterStateKind } from "../api/updater";

const PENDING_KINDS: ReadonlySet<UpdaterStateKind | FirmwareStateKind> =
  new Set(["available", "downloading", "ready"]);

export function useAnyUpdatePending(): boolean {
  const { state: softwareState } = useUpdater();
  const { status: firmwareStatus } = useFirmwareStatus();

  const softwareKind = softwareState?.kind;
  const firmwareKind = firmwareStatus?.state.kind;

  return (
    (softwareKind != null && PENDING_KINDS.has(softwareKind)) ||
    (firmwareKind != null && PENDING_KINDS.has(firmwareKind))
  );
}
