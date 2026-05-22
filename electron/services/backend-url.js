// Resolve the daemon's loopback HTTP / WebSocket base URLs.
//
// The renderer needs the HTTP port for /logs/stream and any other
// future fetches it might make directly. We can't read the http_port
// temp file from the renderer (it's sandboxed), so this service runs
// in the main process and the preload exposes a `getBackendUrl()`
// invoke that returns the resolved pair.
//
// Returns:
//   { ok: true, http: 'http://127.0.0.1:<port>', ws: 'ws://127.0.0.1:<port>', port }
//   { ok: false, reason: 'no_port_file' }
//
// The renderer is expected to poll on connection errors (the WS hook
// already does its own backoff/reconnect dance) so a one-shot failure
// here is recoverable without a separate readiness ping.
'use strict';

const httpPort = require('./http-port');

async function getBackendUrl() {
  const port = httpPort.readOnce();
  if (port === null) {
    return { ok: false, reason: 'no_port_file' };
  }
  return {
    ok: true,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    port,
  };
}

module.exports = { getBackendUrl };
