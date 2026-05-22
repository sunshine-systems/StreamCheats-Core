// Tiny readiness probe used by the renderer's connection-status pill.
//
// The renderer polls every ~2s, so this needs to be cheap and never
// hang. We read the daemon's http_port file (written on startup) and
// issue a short-timeout GET /health. Any error or non-200 means the
// daemon is unreachable from the renderer's point of view.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const httpPort = require('./http-port');

const REQUEST_TIMEOUT_MS = 1000;
const PID_FILE = path.join(os.tmpdir(), 'streamcheats_core.pid');

function probe(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
      },
      (res) => {
        // Drain so the socket can be reused / closed cleanly.
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode === 200));
        res.on('error', () => resolve(false));
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function probeDetail(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(body);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Returns one of:
 *   { ok: true }
 *   { ok: false, reason: 'no_port_file' }
 *     — daemon never wrote its http_port file (almost certainly never
 *       started, OR crashed before binding the HTTP server)
 *   { ok: false, reason: 'probe_failed', port }
 *     — port file exists but either the TCP connect or HTTP response
 *       failed (daemon crashed after publishing the file, or its HTTP
 *       server is stuck)
 *
 * The renderer uses `reason` to render a tooltip on the red pill so
 * the user can distinguish "didn't start" from "started but
 * unresponsive" without reading the log file. Never throws.
 */
async function runHealthCheck() {
  const port = httpPort.readOnce();
  if (port === null) return { ok: false, reason: 'no_port_file' };
  const ok = await probe(port);
  if (ok) return { ok: true };
  return { ok: false, reason: 'probe_failed', port };
}

/**
 * Returns the full daemon health snapshot for the status rail:
 *   { ok: true, pid, port, version, uptimeSeconds }
 *   { ok: false }
 * Never throws.
 */
async function runHealthDetail() {
  const port = httpPort.readOnce();
  if (port === null) return { ok: false };
  const body = await probeDetail(port);
  if (!body) return { ok: false };
  return {
    ok: true,
    pid: readPid(),
    port,
    version: body.version ?? null,
    uptimeSeconds: typeof body.uptime_seconds === 'number' ? body.uptime_seconds : null,
  };
}

module.exports = { runHealthCheck, runHealthDetail };
