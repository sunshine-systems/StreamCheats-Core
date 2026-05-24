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
let logsWindow = null;
let trayHandle = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Logs window factory
// ---------------------------------------------------------------------------
//
// The Logs sidebar item pops a dedicated, wider BrowserWindow that
// targets the static `/logs/window/` route — a full-viewport renderer
// of the same <LogStream /> the in-shell page used, minus the AppShell
// chrome. Sized 1200x800 by default and freely resizable so an
// investigator can spread the firehose across a second monitor without
// fighting the narrow main window.
//
// Only one logs window may exist at a time: a second invocation while
// the first is alive just focuses the existing window. The reference
// is nulled in the 'closed' handler so the next click recreates it.

async function createLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    if (logsWindow.isMinimized()) logsWindow.restore();
    logsWindow.show();
    logsWindow.focus();
    return logsWindow;
  }

  // Resolve the daemon URL. Reuse the same target the main window
  // already resolved against — if for some reason the port has
  // shifted (daemon restart between window opens) we re-probe to
  // pick it up.
  const target = await windowService.resolveStartTarget({
    isPackaged: IS_PACKAGED,
    isDev: IS_DEV,
    devUrl: FRONTEND_DEV_URL,
  });

  // Compose the URL for the /logs/window route. The Next static
  // export emits `<base>/logs/window/index.html`. For the data:
  // fallback (daemon never came up) we just load the same error
  // page the main window would show — the dedicated window is
  // useless without a daemon to stream from.
  let loadUrl;
  if (target.kind === 'url') {
    const base = target.value.endsWith('/') ? target.value : `${target.value}/`;
    loadUrl = `${base}logs/window/`;
  } else {
    loadUrl = target.value;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'StreamCheats Logs',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#0d0f10',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.on('closed', () => {
    logsWindow = null;
  });

  try {
    await win.loadURL(loadUrl);
    logger.info(`[logs-window] loaded ${loadUrl}`);
  } catch (err) {
    logger.error(`[logs-window] loadURL failed: ${err && err.message}`);
  }

  logsWindow = win;
  return win;
}

ipcMain.handle('logs-window:open', async () => {
  try {
    await createLogsWindow();
    return { ok: true };
  } catch (err) {
    logger.error(`[logs-window] open failed: ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
});

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

  // PERSISTENCE: In packaged mode the daemon's cwd determines where it
  // reads/writes `config.json`. We deliberately point it at
  // `app.getPath('userData')` (= `%APPDATA%\StreamCheats Core\` on
  // Windows) rather than `process.resourcesPath` because the install
  // dir gets cleaned/overwritten on every NSIS upgrade — anything
  // stored there (including the user's `experimental_builds` toggle)
  // would be wiped on each `Setup.exe` reinstall. userData lives
  // outside the install dir and is preserved across upgrades and even
  // across uninstalls (electron/package.json sets
  // `nsis.deleteAppDataOnUninstall: false`).
  //
  // On first run there is no config.json in userData yet, so we seed
  // one from the bundled `extraResources` copy under
  // `process.resourcesPath`. On subsequent runs (and after upgrades)
  // we leave the existing userData file untouched so the user's
  // settings persist.
  //
  // In dev, leaving cwd as `backend/` lets the daemon find the
  // checked-in `backend/config.json`.
  let backendCwd;
  if (IS_PACKAGED) {
    backendCwd = app.getPath('userData');
    try {
      fs.mkdirSync(backendCwd, { recursive: true });
      const userConfig = path.join(backendCwd, 'config.json');
      if (!fs.existsSync(userConfig)) {
        const seedConfig = path.join(process.resourcesPath, 'config.json');
        if (fs.existsSync(seedConfig)) {
          fs.copyFileSync(seedConfig, userConfig);
          logger.info(
            `[main] seeded config.json into userData from ${seedConfig}`
          );
        } else {
          logger.warn(
            `[main] no bundled config.json at ${seedConfig} to seed; ` +
              'daemon will write its own default into userData on first run.'
          );
        }
      } else {
        logger.info(`[main] reusing existing userData config: ${userConfig}`);
      }
    } catch (err) {
      logger.warn(`[main] could not seed userData config: ${err.message}`);
    }
  } else {
    backendCwd = path.join(PROJECT_ROOT, 'backend');
  }

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
