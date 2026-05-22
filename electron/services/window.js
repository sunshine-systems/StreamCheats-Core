// BrowserWindow creation + load logic. Owns the start-target resolution
// (Next dev server vs daemon-served HTTP vs fallback HTML) but delegates
// nothing UI-stateful — close-to-tray etc. is wired in from main.js so
// the tray and window can refer to each other.
//
// As of v0.5.x the renderer is loaded over `http://127.0.0.1:<port>/`
// served by the Rust daemon's axum + tower-http ServeDir, NOT over
// `file://`. This makes the frontend same-origin with `/health`,
// `/bug-report`, and the `/logs/stream` WebSocket (no CORS preflight,
// no `Origin: null`), and lets absolute `/_next/...` asset paths
// resolve correctly across nested routes.
'use strict';

const http = require('http');

const { BrowserWindow } = require('electron');

const httpPort = require('./http-port');
const windowPrefs = require('./window-prefs');

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
    // Fall back to stderr so it still shows up.
    process.stderr.write(`[window] ${level} ${msg}\n`);
  }
}

function probeUrl(url, timeoutMs = 250) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      // Any HTTP response (even 503) means the server is up.
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Resolve the URL the BrowserWindow should load.
 *
 *  - In unpackaged dev mode, FIRST probe a Next dev server on
 *    `devUrl`. If it answers, prefer that — it gives HMR.
 *  - Otherwise, wait for the Rust daemon's `/health` endpoint to
 *    answer (it publishes its randomly-bound HTTP port to a
 *    temp file on startup). Once healthy, load
 *    `http://127.0.0.1:<port>/`.
 *  - If the daemon never responds in `readinessTimeoutMs`, fall
 *    back to a tiny inline error page so the window isn't blank.
 *
 * The readiness loop is intentionally polling-based rather than
 * fs.watch-based on the port file: the file is written via
 * atomic-rename and the daemon may briefly publish the file before
 * its TCP listener is fully drained. A 250ms HTTP probe cadence is
 * the same shape `health-check.js` already uses.
 */
async function resolveStartTarget({
  isPackaged,
  isDev,
  devUrl,
  readinessTimeoutMs = 10000,
}) {
  // Only probe the Next dev server when running unpackaged.
  if (!isPackaged && isDev) {
    const up = await probeUrl(devUrl, 750);
    if (up) return { kind: 'url', value: devUrl };
  }

  // Wait for the daemon to publish its http_port file AND respond
  // to /health on it.
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const port = httpPort.readOnce();
    if (port !== null) {
      const healthy = await probeUrl(`http://127.0.0.1:${port}/health`, 250);
      if (healthy) {
        return { kind: 'url', value: `http://127.0.0.1:${port}/` };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    kind: 'data',
    value:
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<!doctype html><html><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px"><div><h1>StreamCheats Core</h1><p>Backend daemon not responding.</p><p style="opacity:.7;font-size:13px">Check logs at <code>%APPDATA%\\streamcheats-core-electron\\logs\\electron.log</code></p></div></body></html>'
      ),
  };
}

/**
 * Create the main window. Caller passes:
 *   - opts.icon            (absolute path)
 *   - opts.preload         (absolute path)
 *   - opts.target          (output of resolveStartTarget)
 *   - opts.isDev           (boolean — opens devtools when true)
 *   - opts.isQuitting()    (fn returning current isQuitting state)
 *   - opts.refreshTray()   (fn called on show/hide/close)
 */
async function createWindow(opts) {
  // Lazy-require `screen` because it is only available after the app
  // `ready` event. createWindow() is called from the ready flow, so
  // this is safe — but keeping it lazy avoids accidentally pulling
  // `screen` at module-load time if this file is ever required earlier.
  const { screen } = require('electron');

  // Pick the display to spawn on: prefer the last one the user
  // dragged the window to (persisted in window-prefs.json by id).
  // If that display is gone (monitor unplugged, id reshuffled), fall
  // back to the primary. This is the only place we read the pref.
  let targetDisplay = screen.getPrimaryDisplay();
  const savedPrefs = windowPrefs.load();
  if (savedPrefs && typeof savedPrefs.displayId === 'number') {
    const match = screen.getAllDisplays().find((d) => d.id === savedPrefs.displayId);
    if (match) {
      targetDisplay = match;
    } else {
      logLine('info', `prefs: saved displayId ${savedPrefs.displayId} not present, using primary`);
    }
  }
  const workArea = targetDisplay.workArea;
  // 24px breathing room top and bottom (total 48). workArea already
  // excludes the Windows taskbar, so the bottom 24 is between the
  // window and the taskbar, not the screen edge.
  const winWidth = Math.floor(workArea.width * 0.38);
  const winHeight = workArea.height - 48;
  const winX = workArea.x + workArea.width - winWidth;
  const winY = workArea.y + 24;

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: winX,
    y: winY,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    icon: opts.icon,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);

  // The legacy file:// directory → index.html rewrite shim was
  // removed when we moved the renderer onto the daemon's HTTP
  // server: tower-http's ServeDir
  // (.append_index_html_on_directories(true)) handles directory
  // index resolution natively, so /logs/ → /logs/index.html works
  // server-side without any will-navigate gymnastics in the
  // renderer. The diagnostic nav listeners below are still useful
  // for surfacing daemon-down / asset-404 / WS-upgrade failures
  // into the persistent electron.log.
  win.webContents.on('will-navigate', (_event, url) => {
    logLine('info', `nav: will-navigate -> ${url}`);
  });
  win.webContents.on('did-navigate', (_e, url) => {
    logLine('info', `nav: did-navigate -> ${url}`);
  });
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    logLine('info', `nav: did-navigate-in-page -> ${url}`);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    logLine(
      'error',
      `nav: did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`
    );
  });
  win.webContents.on('did-fail-provisional-load', (_e, errorCode, errorDescription, validatedURL) => {
    logLine(
      'error',
      `nav: did-fail-provisional-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`
    );
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine('error', `renderer: render-process-gone reason=${details && details.reason}`);
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level 0=verbose 1=info 2=warning 3=error. Only mirror warnings and
    // errors into our log to avoid drowning normal usage in renderer chatter.
    if (level < 2) return;
    const tag = ['VERBOSE', 'INFO', 'WARN', 'ERROR'][level] || `L${level}`;
    logLine(level >= 3 ? 'error' : 'warn', `renderer-console[${tag}] ${sourceId}:${line} ${message}`);
  });

  // Register ready-to-show BEFORE loadURL. If we register it after
  // `await win.loadURL(...)` resolves, the event may have already
  // fired (loadURL resolves on did-finish-load, which is typically
  // after ready-to-show) and our handler will never run — leaving
  // the window invisible on cold start. The tray "Show" still
  // worked because toggleWindow() calls win.show()/win.focus()
  // directly.
  let shown = false;
  const showAndFocus = (reason) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    // Give the splash (if any) a chance to start its fadeout BEFORE
    // the main window grabs focus, so the visual handoff looks
    // intentional rather than a hard pop. The callback is optional;
    // when absent (e.g. tray "Show") we behave exactly as before.
    if (typeof opts.onReadyToShow === 'function') {
      try {
        opts.onReadyToShow(reason);
      } catch (err) {
        logLine('warn', `onReadyToShow threw: ${err && err.message}`);
      }
    }
    win.show();
    win.focus();
    // Windows occasionally drops a freshly-launched portable .exe
    // into the background. Nudge it to the foreground without
    // pinning always-on-top.
    win.moveTop();
    opts.refreshTray();
    logLine('info', `show: ${reason}`);
  };
  win.once('ready-to-show', () => showAndFocus('ready-to-show'));

  const target = opts.target;
  // target is always { kind: 'url' | 'data', value: string } now —
  // the legacy file:// `kind: 'file'` branch is gone because the
  // daemon serves all renderer assets over http.
  await win.loadURL(target.value);
  logLine('info', `loaded ${target.kind}: ${target.value.slice(0, 80)}`);

  // Belt-and-braces: if ready-to-show hasn't fired yet (rare race),
  // showAndFocus will fire on the listener above; if it already
  // fired and we somehow missed it, this guarantees the window
  // appears.
  showAndFocus('post-loadURL');

  // Only auto-open DevTools in an explicit dev environment AND when not
  // packaged. Packaged builds never auto-open — users can still hit
  // Ctrl+Shift+I (Electron's built-in shortcut) to open them on demand.
  if (opts.isDev && !opts.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Close-to-tray: intercept the X button.
  win.on('close', (event) => {
    if (!opts.isQuitting()) {
      event.preventDefault();
      win.hide();
      opts.refreshTray();
    }
  });

  win.on('show', opts.refreshTray);
  win.on('hide', opts.refreshTray);

  // Persist the display the window currently lives on. We use the
  // window's center point (not its top-left) so a window straddling
  // two monitors is attributed to whichever one holds the majority.
  // `moved` fires once after a drag ends on Windows — not during —
  // which is exactly the cadence we want; no debounce needed.
  function persistCurrentDisplay(reason) {
    try {
      const bounds = win.getBounds();
      const center = {
        x: bounds.x + Math.floor(bounds.width / 2),
        y: bounds.y + Math.floor(bounds.height / 2),
      };
      const display = screen.getDisplayNearestPoint(center);
      if (display && typeof display.id === 'number') {
        windowPrefs.save({ displayId: display.id });
        logLine('info', `prefs: saved displayId=${display.id} (${reason})`);
      }
    } catch (err) {
      logLine('warn', `prefs: persist failed (${reason}): ${err && err.message}`);
    }
  }
  win.on('moved', () => persistCurrentDisplay('moved'));
  // Belt-and-braces: also save right before close-to-tray hides the
  // window. This is a SEPARATE listener from the close-to-tray
  // handler above; both run, neither prevents the other.
  win.on('close', () => persistCurrentDisplay('close'));

  return win;
}

function toggleWindow(win, refreshTray) {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
  refreshTray();
}

module.exports = { resolveStartTarget, createWindow, toggleWindow };
