// Fetch the bug-report zip from the Rust daemon's HTTP endpoint and
// save it to the user's Desktop. Returns a structured result the
// renderer can render into a toast.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { app } = require('electron');
const httpPort = require('./http-port');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Issue a POST to `http://127.0.0.1:<port>/bug-report` and resolve with
 * { ok: true, status, headers, body: Buffer } or
 * { ok: false, error: 'network' | 'timeout', message }.
 */
function requestZip(port) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: '/bug-report',
      method: 'POST',
      headers: { 'content-length': '0' },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          ok: true,
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks),
        })
      );
      res.on('error', (err) =>
        resolve({ ok: false, error: 'network', message: err.message })
      );
    });
    req.on('error', (err) =>
      resolve({ ok: false, error: 'network', message: err.message })
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', message: 'request timed out' });
    });
    req.end();
  });
}

/**
 * Pull the suggested filename out of `content-disposition:
 * attachment; filename="..."`. Falls back to a sensible default if
 * absent or malformed.
 */
function filenameFromDisposition(headers) {
  const v = headers['content-disposition'];
  if (!v) return defaultFilename();
  const m = /filename="([^"]+)"/.exec(v);
  if (!m) return defaultFilename();
  return m[1];
}

function defaultFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `streamcheats_bug_report_${stamp}.zip`;
}

/**
 * Resolve the save location. Prefers Desktop; falls back to Downloads
 * if Desktop doesn't exist. Returns { dir, fellBack: bool }.
 */
function resolveSaveDir() {
  try {
    const desktop = app.getPath('desktop');
    if (desktop && fs.existsSync(desktop)) {
      return { dir: desktop, fellBack: false };
    }
  } catch (_) {
    /* ignore — fall through */
  }
  const downloads = app.getPath('downloads');
  return { dir: downloads, fellBack: true };
}

/**
 * Public entry — called from the IPC handler.
 *
 * Returns one of:
 *   { ok: true, savedTo: '<absolute path>', fellBack: bool }
 *   { ok: false, error: 'http_port_unavailable' }
 *   { ok: false, error: 'file_logging_disabled' }
 *   { ok: false, error: 'network', detail: string }
 *   { ok: false, error: 'unknown', detail: string }
 */
async function runBugReport() {
  const port = await httpPort.readWithRetry(3000);
  if (port === null) {
    return { ok: false, error: 'http_port_unavailable' };
  }

  const res = await requestZip(port);
  if (!res.ok) {
    return { ok: false, error: res.error, detail: res.message };
  }

  if (res.status === 400) {
    // The Rust handler emits {"error":"file_logging_disabled"} here.
    try {
      const parsed = JSON.parse(res.body.toString('utf8'));
      if (parsed && parsed.error === 'file_logging_disabled') {
        return { ok: false, error: 'file_logging_disabled' };
      }
    } catch (_) {
      /* fall through to generic */
    }
    return {
      ok: false,
      error: 'unknown',
      detail: `HTTP 400 from /bug-report`,
    };
  }

  if (res.status !== 200) {
    return {
      ok: false,
      error: 'unknown',
      detail: `unexpected HTTP ${res.status}`,
    };
  }

  const filename = filenameFromDisposition(res.headers);
  const { dir, fellBack } = resolveSaveDir();
  const target = path.join(dir, filename);
  try {
    fs.writeFileSync(target, res.body);
  } catch (err) {
    return {
      ok: false,
      error: 'unknown',
      detail: `could not write ${target}: ${err.message}`,
    };
  }
  return { ok: true, savedTo: target, fellBack };
}

module.exports = { runBugReport };
