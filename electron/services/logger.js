// Lightweight file logger for the Electron main process. Writes to
// `%LOCALAPPDATA%\StreamCheats Core\logs\electron.log` (cross-platform
// equivalent under `app.getPath('userData')\logs\electron.log`).
//
// Purpose: when the packaged app misbehaves (daemon won't spawn, IPC
// flakes, etc.) the user has no console output to share. This file is
// the post-mortem source of truth — every important branch in the
// orchestration logs here.
//
// Lazy-initialised because `app.getPath` is only valid after
// `app.whenReady`-ish. Callers should treat this module as fire-and-
// forget: failures to write the log file are themselves swallowed so a
// broken logger never breaks the app.
'use strict';

const fs = require('fs');
const path = require('path');

let logStream = null;
let logPath = null;
let initialised = false;
let pendingLines = [];

function init(userDataDir) {
  if (initialised) return;
  initialised = true;
  try {
    const logsDir = path.join(userDataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    logPath = path.join(logsDir, 'electron.log');
    // Append mode — keep history across launches. Truncation happens
    // implicitly when the user clears the dir manually; we don't rotate
    // because the volume is tiny (a few lines per launch).
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    // Drain anything that was logged before init() ran.
    const banner = `\n===== Electron started ${new Date().toISOString()} pid=${process.pid} =====\n`;
    logStream.write(banner);
    for (const line of pendingLines) logStream.write(line);
    pendingLines = [];
  } catch (err) {
    // Last-ditch — stderr so it at least shows up if launched from a
    // terminal. In packaged mode there's nowhere to surface this.
    process.stderr.write(`[logger] init failed: ${err.message}\n`);
  }
}

function ts() {
  return new Date().toISOString();
}

function write(level, msg) {
  const line = `${ts()} [${level}] ${msg}\n`;
  // Mirror to console so `electron .` dev runs still see it.
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
  if (logStream) {
    try {
      logStream.write(line);
    } catch (_) {
      /* ignore */
    }
  } else {
    // Buffer until init() — bounded to avoid runaway memory if init
    // never happens.
    if (pendingLines.length < 200) pendingLines.push(line);
  }
}

function info(msg) {
  write('INFO', msg);
}
function warn(msg) {
  write('WARN', msg);
}
function error(msg) {
  write('ERROR', msg);
}

function getLogPath() {
  return logPath;
}

module.exports = { init, info, warn, error, getLogPath };
