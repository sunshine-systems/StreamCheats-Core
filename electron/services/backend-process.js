// Spawn / kill the Rust daemon. Owns PID-file detection so we don't
// double-spawn when a stale instance is still running.
//
// PID gate: an alive PID is necessary but NOT sufficient — Windows
// recycles PIDs aggressively after a reboot, so we ALSO verify the
// running process's image name matches our daemon. Without this check
// a stale pid file from a previous session could match any unrelated
// process that happens to be wearing the same PID, and we'd skip
// spawning forever — the symptom the user originally hit.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');

const logger = require('./logger');

const PID_FILE = path.join(os.tmpdir(), 'streamcheats_core.pid');
const HTTP_PORT_FILE = path.join(os.tmpdir(), 'streamcheats_core.http_port');
const PORT_FILE = path.join(os.tmpdir(), 'streamcheats_core.port');
const DAEMON_IMAGE_NEEDLE = 'streamcheats_core';

let backendChild = null;
let backendSpawnedByUs = false;

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    // Signal 0 doesn't kill — just checks existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still "alive".
    return err && err.code === 'EPERM';
  }
}

/**
 * Windows-only: ask `tasklist` for the image name of `pid`. Returns
 * the lowercased image name or `null` on any failure (missing tasklist,
 * pid not found, weird locale formatting, etc.). We use `/FO CSV /NH`
 * for a stable, locale-agnostic format.
 */
function windowsImageNameFor(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    }).toString();
    // CSV row: "image.exe","12345","Console","1","X K"
    const firstQuote = out.indexOf('"');
    if (firstQuote === -1) return null;
    const secondQuote = out.indexOf('"', firstQuote + 1);
    if (secondQuote === -1) return null;
    return out.slice(firstQuote + 1, secondQuote).toLowerCase();
  } catch (_) {
    return null;
  }
}

function isOurDaemon(pid) {
  const name = windowsImageNameFor(pid);
  if (name === null) {
    // Couldn't determine — be conservative and assume NOT ours so we
    // spawn a fresh one. Double-spawning is harmless because the Rust
    // daemon's own takeover_if_running will kill the prior instance.
    return false;
  }
  return name.includes(DAEMON_IMAGE_NEEDLE);
}

function removeStaleFiles(reason) {
  for (const f of [PID_FILE, HTTP_PORT_FILE, PORT_FILE]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      /* ignore */
    }
  }
  logger.info(`[backend] cleared stale pid/port files (${reason})`);
}

function readExistingDaemonPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid)) {
      removeStaleFiles('unparseable pid file');
      return null;
    }
    if (!isPidAlive(pid)) {
      removeStaleFiles(`pid ${pid} not alive`);
      return null;
    }
    if (!isOurDaemon(pid)) {
      removeStaleFiles(`pid ${pid} alive but not streamcheats_core`);
      return null;
    }
    return pid;
  } catch (err) {
    logger.warn(`[backend] failed reading PID file: ${err.message}`);
    return null;
  }
}

function resolveBackendBinary({ packagedPath, releasePath, debugPath }) {
  if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
  if (releasePath && fs.existsSync(releasePath)) return releasePath;
  if (debugPath && fs.existsSync(debugPath)) return debugPath;
  return null;
}

function spawnIfNeeded(opts) {
  const existingPid = readExistingDaemonPid();
  if (existingPid) {
    logger.info(
      `[backend] daemon already running (pid ${existingPid}); not spawning.`
    );
    return;
  }

  const bin = resolveBackendBinary(opts);
  if (!bin) {
    logger.warn(
      '[backend] binary not found at packaged/release/debug paths — skipping spawn. ' +
        `Searched: packaged=${opts.packagedPath} release=${opts.releasePath} debug=${opts.debugPath}`
    );
    return;
  }

  // The Rust daemon resolves `config.json` relative to its CWD. In dev
  // we want CWD=backend/ so it finds the checked-in config; in packaged
  // mode we want CWD=resourcesPath so it finds the bundled config.json
  // we ship via extraResources. Callers may pass `cwd` to override.
  const cwd = opts.cwd || path.dirname(bin);

  // Verify the config file the daemon will look for actually exists at
  // the cwd we picked. The daemon currently exits with code 1 if
  // `config.json` is missing/invalid; surfacing this here turns a
  // silent crash into an actionable log line.
  const expectedConfig = path.join(cwd, 'config.json');
  const configExists = fs.existsSync(expectedConfig);
  logger.info(
    `[backend] spawn attempt: bin=${bin} cwd=${cwd} config.json=${
      configExists ? 'present' : 'MISSING'
    }`
  );

  // Merge caller-supplied env on top of the inherited process.env. We
  // use this today only for STREAMCHEATS_FRONTEND_DIR (so the Rust daemon
  // knows where to find the bundled Next.js static export to serve
  // alongside its API routes), but the shape generalises to any
  // future env-var-driven daemon flag without further plumbing.
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;

  try {
    backendChild = spawn(bin, [], {
      cwd,
      env,
      // Pipe stdio so we can mirror to our log file. `ignore` would be
      // simpler but we'd lose the daemon's stderr on crash, which is
      // exactly when we need it most.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    backendSpawnedByUs = true;
    logger.info(
      `[backend] spawned pid=${backendChild.pid} (${bin}) cwd=${cwd}` +
        (opts.env ? ` env=${JSON.stringify(opts.env)}` : '')
    );

    backendChild.stdout.on('data', (buf) => {
      const text = buf.toString();
      // Mirror to log file with a prefix so backend lines are distinct
      // from electron-orchestration lines.
      for (const line of text.split(/\r?\n/)) {
        if (line.length) logger.info(`[backend stdout] ${line}`);
      }
    });
    backendChild.stderr.on('data', (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length) logger.warn(`[backend stderr] ${line}`);
      }
    });
    backendChild.on('exit', (code, signal) => {
      // A non-zero exit immediately after spawn almost always means the
      // daemon couldn't load config.json (missing/invalid). Surface it
      // loudly so it shows up in the user's debug log instead of being
      // swallowed silently.
      if (code !== 0 && code !== null) {
        logger.error(
          `[backend spawn FAILED] daemon exited code=${code} signal=${signal} ` +
            `cwd=${cwd}. Likely cause: config.json missing or invalid at that path.`
        );
      } else {
        logger.info(`[backend] exited code=${code} signal=${signal}`);
      }
      backendChild = null;
    });
    backendChild.on('error', (err) => {
      logger.error(`[backend spawn FAILED] ${err.message}`);
    });
  } catch (err) {
    logger.error(`[backend spawn FAILED] ${err.message}`);
    backendChild = null;
  }
}

function kill() {
  if (!backendChild || !backendSpawnedByUs) return;
  const pid = backendChild.pid;
  try {
    // Hard-kill the whole tree on Windows.
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    logger.info(`[backend] killed pid=${pid}`);
  } catch (err) {
    try {
      backendChild.kill();
    } catch (_) {
      /* ignore */
    }
    logger.warn(`[backend] taskkill failed (${err.message}); used child.kill()`);
  }
  backendChild = null;
}

module.exports = { spawnIfNeeded, kill };
