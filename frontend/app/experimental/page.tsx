"use client";

// Experimental Support page (SC-8). Lets the user pick an alternate
// input-API listener (today: kmbox-net) and start/stop it. The
// StreamCheats device already controls mouse + keyboard natively over
// USB — these listeners exist purely so third-party tools written
// against e.g. the kmbox-net UDP protocol can drive the device through
// the daemon. Default off; this is opt-in.

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

import PageHeader from "../../components/ui/PageHeader";
import Card from "../../components/ui/Card";
import Eyebrow from "../../components/ui/Eyebrow";
import ActionButton from "../../components/updates/ActionButton";
import StateChip from "../../components/updates/StateChip";
import { useExperimentalStatus } from "../../lib/hooks/useExperimentalStatus";

export default function ExperimentalPage() {
  const { status, registry, busy, loaded, selectApi, enable, disable } =
    useExperimentalStatus();

  const apis = useMemo(() => registry ?? [], [registry]);
  const activeId = status?.active ?? "";
  const activeDescriptor = useMemo(
    () => apis.find((a) => a.id === activeId) ?? null,
    [apis, activeId]
  );

  // Disable the select while running — the daemon refuses to switch
  // active API mid-listener (SC-8 endpoint contract) so we mirror
  // that constraint here. Also disable while a request is in flight.
  const selectDisabled = busy || status?.running === true;

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader
        eyebrow="system · experimental"
        title="Experimental Support"
        sub="The StreamCheats device controls mouse and keyboard natively over USB. Enable an experimental API here only if you need to drive the device from a third-party tool that speaks one of these protocols."
      />

      <Card aria-label="Experimental API listener" static>
        <div className="flex flex-col gap-5">
          <header className="flex items-center justify-between gap-3">
            <Eyebrow tone={status?.running ? "copper" : "muted"}>
              listener status
            </Eyebrow>
            <StatusBadge
              loaded={loaded}
              running={status?.running === true}
              hasError={Boolean(status?.last_error)}
            />
          </header>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="experimental-api-select"
              className="sc-chrome text-[10px] text-ink-dim"
            >
              active api
            </label>
            <select
              id="experimental-api-select"
              value={activeId}
              disabled={selectDisabled || apis.length === 0}
              onChange={(e) => {
                void selectApi(e.target.value);
              }}
              className="
                w-full
                bg-substrate-2 text-ink
                border border-hairline rounded-[4px]
                px-3 py-2
                font-mono text-[13px]
                focus:outline-none focus:border-[color:var(--sc-foliage)]
                disabled:opacity-60 disabled:cursor-not-allowed
                transition-colors
              "
              style={{
                transitionDuration: "var(--sc-dur-quick)",
                transitionTimingFunction: "var(--sc-ease-out)",
              }}
            >
              {apis.length === 0 ? (
                <option value="">loading...</option>
              ) : (
                apis.map((api) => (
                  <option key={api.id} value={api.id}>
                    {api.name}
                  </option>
                ))
              )}
            </select>
            {activeDescriptor ? (
              <p className="text-ink-muted text-[13px] leading-relaxed">
                {activeDescriptor.description}
              </p>
            ) : null}
            {status?.running ? (
              <p className="text-ink-dim text-[11px] font-mono">
                disable the listener to switch APIs
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="sc-chrome text-[10px] text-ink-dim">
                control
              </span>
              {status?.bound ? (
                <span className="font-mono text-[11px] text-ink-muted truncate">
                  bound {status.bound}
                </span>
              ) : (
                <span className="font-mono text-[11px] text-ink-dim">
                  listener stopped
                </span>
              )}
            </div>
            <ToggleButton
              running={status?.running === true}
              busy={busy}
              disabled={!loaded || apis.length === 0}
              activeName={activeDescriptor?.name ?? activeId}
              onEnable={enable}
              onDisable={disable}
            />
          </div>

          {status?.last_error ? (
            <div className="flex flex-col gap-1">
              <Eyebrow tone="muted">last error</Eyebrow>
              <p className="font-mono text-[12px] text-danger leading-relaxed break-words">
                {status.last_error}
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      {status?.enabled === true && status?.running === true ? (
        <ConnectionInfoPanel
          listenIp={status.listen_ip}
          udpPort={status.udp_port}
          deviceMac={status.device_mac}
          bound={status.bound}
        />
      ) : null}
    </div>
  );
}

/**
 * Insert a colon every 2 hex characters so `01FBC068` reads as
 * `01:FB:C0:68` — matches how the kmbox-net protocol docs print the
 * device identifier and makes it easier to type-check at a glance. The
 * underlying source-of-truth value (un-colonised) is what gets copied
 * to the clipboard so users can paste straight into their tool's
 * config.
 */
function formatMac(raw: string): string {
  const cleaned = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (cleaned.length === 0) return raw;
  return cleaned.match(/.{1,2}/g)?.join(":") ?? raw;
}

function ConnectionInfoPanel({
  listenIp,
  udpPort,
  deviceMac,
  bound,
}: {
  listenIp: string;
  udpPort: number;
  deviceMac: string;
  bound: string | null;
}) {
  // Rows are built up so we can include the bound socket address only
  // when the daemon reports one — kernel-assigned port differences
  // (config says 0, kernel binds 14598) are surfaced as a separate
  // "Bound" row rather than overwriting the configured UDP Port value.
  const rows: Array<{ label: string; value: string; copyValue?: string }> = [
    { label: "Listening IP", value: listenIp },
    { label: "UDP Port", value: String(udpPort) },
    {
      label: "Device MAC",
      value: formatMac(deviceMac),
      // External tools usually expect the raw 8-hex-char form (no
      // separators), so copy that — not the prettified colon form.
      copyValue: deviceMac,
    },
  ];
  if (bound && bound !== `${listenIp}:${udpPort}`) {
    rows.push({ label: "Bound", value: bound });
  }

  return (
    <Card aria-label="Active KMBOX Net connection info" static>
      <div className="flex flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <Eyebrow tone="copper">active connection info</Eyebrow>
        </header>
        <p className="text-ink-muted text-[13px] leading-relaxed">
          Point your external kmbox-net client at the values below. Click
          any value to copy.
        </p>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <InfoRow
              key={row.label}
              label={row.label}
              value={row.value}
              copyValue={row.copyValue ?? row.value}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function InfoRow({
  label,
  value,
  copyValue,
}: {
  label: string;
  value: string;
  copyValue: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      // `navigator.clipboard.writeText` is the only modern path; the
      // app runs inside an Electron BrowserWindow with the clipboard
      // permission granted by default, so we don't need an execCommand
      // fallback here.
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Swallow — copy is a nice-to-have, not load-bearing. Users can
      // still read the value off the page.
    }
  };

  return (
    <li className="flex items-center justify-between gap-3 border-b border-hairline last:border-b-0 py-2">
      <span className="sc-chrome text-[10px] text-ink-dim uppercase tracking-wider">
        {label}
      </span>
      <button
        type="button"
        onClick={() => {
          void onCopy();
        }}
        title={`Copy ${label}`}
        aria-label={`Copy ${label}: ${copyValue}`}
        className="
          group inline-flex items-center gap-2
          font-mono text-[13px] text-ink
          hover:text-[color:var(--sc-foliage)]
          focus:outline-none focus:text-[color:var(--sc-foliage)]
          transition-colors cursor-pointer
        "
        style={{
          transitionDuration: "var(--sc-dur-quick)",
          transitionTimingFunction: "var(--sc-ease-out)",
        }}
      >
        <span className="sc-chrome">{value}</span>
        {copied ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--sc-foliage)]">
            <Check size={12} aria-hidden="true" />
            copied
          </span>
        ) : (
          <Copy
            size={12}
            aria-hidden="true"
            className="text-ink-dim group-hover:text-[color:var(--sc-foliage)] group-focus:text-[color:var(--sc-foliage)]"
          />
        )}
      </button>
    </li>
  );
}

function StatusBadge({
  loaded,
  running,
  hasError,
}: {
  loaded: boolean;
  running: boolean;
  hasError: boolean;
}) {
  if (!loaded) {
    return <StateChip tone="muted">loading</StateChip>;
  }
  if (running) {
    return <StateChip tone="copper">running</StateChip>;
  }
  if (hasError) {
    return <StateChip tone="danger">error</StateChip>;
  }
  return <StateChip tone="muted">stopped</StateChip>;
}

function ToggleButton({
  running,
  busy,
  disabled,
  activeName,
  onEnable,
  onDisable,
}: {
  running: boolean;
  busy: boolean;
  disabled: boolean;
  activeName: string;
  onEnable: () => Promise<{ ok: boolean; error?: string }>;
  onDisable: () => Promise<{ ok: boolean; error?: string }>;
}) {
  // Copper when enabling (the "act on me" colour). Foliage when
  // already running — the action then is the calm-down "Disable" and
  // we don't want it screaming for attention.
  const tone = running ? "foliage" : "copper";
  const label = running ? `Disable ${activeName}` : `Enable ${activeName}`;
  return (
    <ActionButton
      tone={tone}
      disabled={busy || disabled}
      onClick={() => {
        if (running) void onDisable();
        else void onEnable();
      }}
    >
      {busy ? "..." : label}
    </ActionButton>
  );
}
