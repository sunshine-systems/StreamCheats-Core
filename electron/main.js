'use strict';

// Slim orchestrator. Imports services/ for everything stateful — see
// the AGENTS notes on distributed file architecture (one responsibility
// per file). This file only wires the services together.

const { app, Menu, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const backend = require('./services/backend-process');
const backendUrl = require('./services/backend-url');
const bugReport = require('./services/bug-report');
const healthCheck = require('./services/health-check');
const logger = require('./services/logger');
const singleInstance = require('./services/single-instance');
const splash = require('./services/splash');
const trayService = require('./services/tray');
const windowService = require('./services/window');

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const IS_DEV = process.env.NODE_ENV !== 'production';
const IS_PACKAGED = app.isPackaged;
const ELECTRON_DIR = __dirname;
const PROJECT_ROOT = path.resolve(ELECTRON_DIR, '..');
const APP_USER_MODEL_ID = 'com.sunshinesystems.streamcheatscore';

const BACKEND_BIN_PACKAGED = IS_PACKAGED
  ? path.join(process.resourcesPath, 'streamcheats_core.exe')
  : null;
const BACKEND_BIN_RELEASE = path.join(
  PROJECT_ROOT,
  'backend',
  'target',
  'release',
  'streamcheats_core.exe'
);
const BACKEND_BIN_DEBUG = path.join(
  PROJECT_ROOT,
  'backend',
  'target',
  'debug',
  'streamcheats_core.exe'
);

// Directory containing the static Next.js export. The Rust daemon
// reads this from the STREAMCHEATS_FRONTEND_DIR env var and serves it from
// the SAME axum process that hosts /health, /bug-report, and
// /logs/stream — see backend/src/http/routes/mod.rs::resolve_frontend_dir.
// Packaged: lives under resources/frontend (electron-builder
// extraResources rule). Dev: lives in the workspace at frontend/out
// (only populated after `pnpm run build` in frontend/).
const FRONTEND_DIR_PACKAGED = IS_PACKAGED
  ? path.join(process.resourcesPath, 'frontend')
  : null;
const FRONTEND_DIR_DEV = path.join(PROJECT_ROOT, 'frontend', 'out');
const FRONTEND_DEV_URL = 'http://localhost:3000';

const APP_ICON = path.join(ELECTRON_DIR, 'assets', 'streamcheats_app_icon.ico');
const PRELOAD = path.join(ELECTRON_DIR, 'preload.js');

// ---------------------------------------------------------------------------
// Globals (kept minimal — most stateful work delegated to services)
// ---------------------------------------------------------------------------

let mainWindow = null;
let trayHandle = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Single-instance lock (must run BEFORE app.whenReady)
// ---------------------------------------------------------------------------

const haveLock = singleInstance.acquire({ getMainWindow: () => mainWindow });
if (!haveLock) {
  return; /* eslint-disable-line no-unused-expressions */
}

// ---------------------------------------------------------------------------
// IPC: bug-report bridge
// ---------------------------------------------------------------------------

ipcMain.handle('bug-report:run', async () => {
  return bugReport.runBugReport();
});

ipcMain.handle('health-check:run', async () => {
  return healthCheck.runHealthCheck();
});

ipcMain.handle('health-detail:run', async () => {
  return healthCheck.runHealthDetail();
});

ipcMain.handle('backend-url:get', async () => {
  return backendUrl.getBackendUrl();
});

// SC-13: native .hex file picker for the manual-flash card on the
// Updates page. We anchor the dialog to the renderer that asked for
// it (via webContents → BrowserWindow lookup) so it modally blocks
// the right window. Falls back to a window-less dialog if we can't
// resolve the parent — better that than crashing.
ipcMain.handle('pick-hex-file:run', async (event) => {
  try {
    const parent =
      BrowserWindow.fromWebContents(event.sender) ||
      mainWindow ||
      BrowserWindow.getFocusedWindow();
    const opts = {
      title: 'Select firmware .hex file',
      buttonLabel: 'Flash',
      properties: ['openFile'],
      filters: [
        { name: 'Teensy firmware', extensions: ['hex'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, reason: 'cancelled' };
    }
    return { ok: true, path: result.filePaths[0] };
  } catch (err) {
    logger.warn(`[pickHexFile] dialog failed: ${err.message}`);
    return { ok: false, reason: 'unavailable' };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

Menu.setApplicationMenu(null);

// Without this, Windows groups our app under the generic Electron AUMID and
// shows the default Electron icon in the taskbar.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

app.whenReady().then(async () => {
  // Initialise file logging as early as possible after app.whenReady so
  // every subsequent orchestration decision (binary path resolution,
  // spawn outcomes, daemon stdout/stderr) lands in a file the user can
  // grab post-mortem. Path: `%LOCALAPPDATA%\StreamCheats Core\logs\
  // electron.log`. See services/logger.js.
  logger.init(app.getPath('userData'));
  logger.info(
    `[main] startup IS_PACKAGED=${IS_PACKAGED} IS_DEV=${IS_DEV} ` +
      `resourcesPath=${process.resourcesPath} userData=${app.getPath('userData')}`
  );

  // Show the splash IMMEDIATELY — before spawning the daemon, before
  // resolving the start target, before creating the main window. The
  // splash is owned by services/splash.js; main.js only drives the
  // status text and tears it down when the main window is ready.
  splash.createSplash({ icon: APP_ICON });

  // In packaged mode the binary AND the bundled config.json both live
  // under process.resourcesPath, so spawn the daemon there explicitly
  // (its cwd determines where it looks for config.json). In dev, leaving
  // cwd undefined lets backend-process.js default to the binary's dir,
  // which for `cargo build` lives under backend/target/release — that
  // dir has no config.json, but during dev we usually run the daemon
  // out-of-band anyway, and the existing-PID gate keeps us out of the
  // way when it's already running.
  const backendCwd = IS_PACKAGED
    ? process.resourcesPath
    : path.join(PROJECT_ROOT, 'backend');

  // Pick the frontend dir we'll point the daemon at. In packaged
  // mode this is unconditional (electron-builder always ships it in
  // resources/frontend). In dev, only set it if `pnpm run build`
  // has produced the static export — otherwise leave it unset and
  // the daemon will fall back to its plain "/" text response while
  // we (probably) load a Next dev server URL anyway.
  const frontendDir = IS_PACKAGED
    ? FRONTEND_DIR_PACKAGED
    : fs.existsSync(path.join(FRONTEND_DIR_DEV, 'index.html'))
    ? FRONTEND_DIR_DEV
    : null;

  // The daemon resolves `teensy_loader_cli.exe` exclusively off the
  // STREAMCHEATS_TEENSY_LOADER_PATH env var we set here. In packaged
  // builds the binary is bundled by electron-builder's extraResources
  // rule (see electron/package.json) and lives next to the daemon
  // under `process.resourcesPath`. In dev we point the daemon at the
  // checked-in copy under `backend/vendor/`. If the file is missing
  // we still set the env var — the daemon's resolve will then fail
  // loudly with `loader_unavailable` and the UI shows a reinstall
  // prompt rather than silently degrading.
  const teensyLoaderPath = IS_PACKAGED
    ? path.join(process.resourcesPath, 'teensy_loader_cli.exe')
    : path.join(PROJECT_ROOT, 'backend', 'vendor', 'teensy_loader_cli.exe');
  if (!fs.existsSync(teensyLoaderPath)) {
    logger.warn(
      `[main] teensy_loader_cli not found at ${teensyLoaderPath} — ` +
        'firmware flashing will fail until the binary is in place.'
    );
  } else {
    logger.info(`[main] teensy_loader_cli: ${teensyLoaderPath}`);
  }

  const daemonEnv = {
    STREAMCHEATS_TEENSY_LOADER_PATH: teensyLoaderPath,
  };
  if (frontendDir) daemonEnv.STREAMCHEATS_FRONTEND_DIR = frontendDir;

  splash.setStatus('starting daemon…');
  backend.spawnIfNeeded({
    packagedPath: BACKEND_BIN_PACKAGED,
    releasePath: BACKEND_BIN_RELEASE,
    debugPath: BACKEND_BIN_DEBUG,
    cwd: backendCwd,
    env: Object.keys(daemonEnv).length > 0 ? daemonEnv : undefined,
  });

  trayHandle = trayService.create({
    iconPath: APP_ICON,
    tooltip: 'StreamCheats Core',
    isWindowVisible: () => Boolean(mainWindow && mainWindow.isVisible()),
    onToggle: () => windowService.toggleWindow(mainWindow, trayHandle.refresh),
    onExit: () => {
      isQuitting = true;
      backend.kill();
      app.quit();
    },
  });

  splash.setStatus('connecting to daemon…');
  const target = await windowService.resolveStartTarget({
    isPackaged: IS_PACKAGED,
    isDev: IS_DEV,
    devUrl: FRONTEND_DEV_URL,
  });
  logger.info(`[main] resolved start target kind=${target.kind} value=${String(target.value).slice(0, 120)}`);

  splash.setStatus('loading UI…');
  mainWindow = await windowService.createWindow({
    icon: APP_ICON,
    preload: PRELOAD,
    target,
    isDev: IS_DEV,
    isPackaged: IS_PACKAGED,
    isQuitting: () => isQuitting,
    refreshTray: () => trayHandle && trayHandle.refresh(),
    onReadyToShow: () => {
      // Hand the screen over to the main window with a brief CSS
      // fadeout on the splash. The 320ms timeout matches the
      // fadeout keyframe duration in splash.html.
      splash.setStatus('ready');
      splash.beginClose();
      setTimeout(() => splash.destroy(), 320);
    },
  });
});

// On Windows, do NOT quit on all-windows-closed — we live in the tray.
app.on('window-all-closed', (event) => {
  event.preventDefault?.();
});

app.on('before-quit', () => {
  isQuitting = true;
  backend.kill();
});
