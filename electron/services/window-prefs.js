// Tiny JSON-backed persistence for window placement preferences.
//
// Currently stores only the last display the user dragged the window
// to (by Electron `Display.id`). We deliberately do NOT persist x/y/
// width/height: the window is non-resizable and always recomputed as
// right-edge-snapped + vertically centered on whichever display it
// belongs to, so all we need to "remember" is which display.
//
// File lives at `<userData>/window-prefs.json`. On Windows that's
// `%APPDATA%\streamcheats-core-electron\window-prefs.json`. We
// only touch it from main (never from the renderer), so no IPC.
//
// Failure policy: this is best-effort UX state, never required for
// correctness. Missing file, malformed JSON, EACCES on write — all
// degrade silently (load() returns null, save() logs and returns).
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let logger = null;
try {
  logger = require('./logger');
} catch (_) {
  /* logger optional */
}
function logLine(level, msg) {
  if (logger && typeof logger[level] === 'function') {
    logger[level](msg);
  } else {
    process.stderr.write(`[window-prefs] ${level} ${msg}\n`);
  }
}

function prefsPath() {
  return path.join(app.getPath('userData'), 'window-prefs.json');
}

function load() {
  const p = prefsPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      logLine('warn', `load: read failed: ${err.message}`);
    }
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logLine('warn', `load: malformed JSON, ignoring: ${err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.displayId !== 'number' || !Number.isFinite(parsed.displayId)) {
    return null;
  }
  return { displayId: parsed.displayId };
}

function save(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  const p = prefsPath();
  const dir = path.dirname(p);
  const tmp = p + '.tmp';
  const payload = JSON.stringify({ displayId: prefs.displayId });
  try {
    // userData dir is created by Electron on first use, but be defensive
    // in case something wiped it.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    logLine('warn', `save: write failed: ${err && err.message}`);
    // Best-effort cleanup of the tmp file; ignore if it isn't there.
    try { fs.unlinkSync(tmp); } catch (_) { /* nop */ }
  }
}

module.exports = { load, save, prefsPath };
