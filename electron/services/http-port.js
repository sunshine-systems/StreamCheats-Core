// Read the daemon's HTTP port from %TEMP%\streamcheats_core.http_port.
// Retries briefly at startup because the Electron window may try to read
// the port before the Rust HTTP server has finished binding.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HTTP_PORT_FILE = path.join(os.tmpdir(), 'streamcheats_core.http_port');

function readOnce() {
  try {
    if (!fs.existsSync(HTTP_PORT_FILE)) return null;
    const raw = fs.readFileSync(HTTP_PORT_FILE, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch (err) {
    return null;
  }
}

/**
 * Wait up to `timeoutMs` for the http_port file to appear and be
 * parseable. Returns the port or `null` on timeout.
 *
 * Polled rather than fs.watched because the file is written via
 * atomic-rename (tmp+rename), and fs.watch on the parent directory is
 * fiddly across platforms; a 100ms poll is plenty for a one-shot
 * startup readiness check.
 */
async function readWithRetry(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readOnce();
    if (port !== null) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

module.exports = { readOnce, readWithRetry, HTTP_PORT_FILE };
