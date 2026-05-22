// Preload script for StreamCheats Core.
// contextIsolation is enabled in main.js, so this file runs in an
// isolated world. Exposes a minimal `window.streamcheats` API the renderer
// can use to talk to the main process via IPC.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('streamcheats', {
  /**
   * Request the backend daemon to assemble a diagnostic bug-report
   * bundle and save it to the user's Desktop. Returns:
   *   { ok: true, savedTo: '<absolute path>', fellBack: boolean }
   *   { ok: false, error: 'file_logging_disabled' }
   *   { ok: false, error: 'http_port_unavailable' | 'network' | 'timeout' | 'unknown', detail?: string }
   */
  bugReport: () => ipcRenderer.invoke('bug-report:run'),

  /**
   * Cheap readiness probe — does GET /health against the daemon.
   * Returns `{ ok: true }` when the daemon answered 200 within ~1s;
   * `{ ok: false }` otherwise. Called on a 2-second poll by the
   * renderer's connection-status pill.
   */
  healthCheck: () => ipcRenderer.invoke('health-check:run'),

  /**
   * Richer variant of healthCheck — returns the full daemon snapshot
   * for the status rail. Resolves to:
   *   { ok: true, pid: number|null, port: number, version: string|null, uptimeSeconds: number|null }
   *   { ok: false }
   * Never throws.
   */
  healthDetail: () => ipcRenderer.invoke('health-detail:run'),

  /**
   * Return the resolved loopback URLs for the daemon's HTTP / WebSocket
   * surfaces. The renderer can't read the http_port temp file directly
   * (sandbox), so the main process resolves it on its behalf.
   *
   * Resolves to:
   *   { ok: true, http: 'http://127.0.0.1:<port>', ws: 'ws://127.0.0.1:<port>', port }
   *   { ok: false, reason: 'no_port_file' }
   * Never throws.
   */
  getBackendUrl: () => ipcRenderer.invoke('backend-url:get'),
});
