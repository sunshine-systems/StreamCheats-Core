// Splash window service. Owns a frameless, transparent BrowserWindow
// that shows the project logo + a tiny live status line ("starting
// daemon…", "connecting…") while main.js spins up the Rust daemon
// and waits for the renderer to be reachable. Closes with a short
// CSS fadeout once the main window is ready-to-show.
//
// The splash is short-lived and intentionally has NO IPC of its own
// — main.js drives status updates via webContents.executeJavaScript()
// against a tiny inline `window.streamcheatsSplash` API in splash.html.
//
// Asset model: splash.html is a static file; the project logo lives
// next door as streamcheats_app_icon.svg. We read the SVG at runtime
// and inject its inner content into the placeholder `<svg id="logo">`
// using executeJavaScript after did-finish-load. This keeps the HTML
// template literal-free and the logo a single source of truth on
// disk.
'use strict';

const fs = require('fs');
const path = require('path');

const { BrowserWindow } = require('electron');

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
    process.stderr.write(`[splash] ${level} ${msg}\n`);
  }
}

let splashWin = null;
let destroyed = false;

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SPLASH_HTML = path.join(ASSETS_DIR, 'splash.html');
const LOGO_SVG = path.join(ASSETS_DIR, 'streamcheats_app_icon.svg');

/**
 * Extract the inner SVG markup (content between the outermost `<svg ...>`
 * and `</svg>`). Returned as a string suitable for setting on the
 * placeholder element's innerHTML. Also returns the viewBox attribute
 * from the source so the placeholder can be retargeted at runtime.
 */
function readLogoInner() {
  try {
    const raw = fs.readFileSync(LOGO_SVG, 'utf8');
    const openMatch = raw.match(/<svg\b([^>]*)>/i);
    const closeIdx = raw.lastIndexOf('</svg>');
    if (!openMatch || closeIdx === -1) {
      return { inner: '', viewBox: '0 0 64 64' };
    }
    const attrs = openMatch[1];
    const vbMatch = attrs.match(/viewBox\s*=\s*"([^"]+)"/i);
    const viewBox = vbMatch ? vbMatch[1] : '0 0 64 64';
    const inner = raw.slice(openMatch.index + openMatch[0].length, closeIdx).trim();
    return { inner, viewBox };
  } catch (err) {
    logLine('warn', `readLogoInner failed: ${err && err.message}`);
    return { inner: '', viewBox: '0 0 64 64' };
  }
}

/**
 * Create and show the splash window. Call this as early as possible
 * inside app.whenReady — before spawning the daemon and before creating
 * the main window — so the user sees something within ~100ms.
 *
 * opts:
 *   - icon: absolute path to the app .ico (Win32 taskbar grouping)
 */
function createSplash(opts) {
  if (splashWin && !splashWin.isDestroyed()) {
    return splashWin;
  }
  destroyed = false;

  splashWin = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false, // show on ready-to-show to avoid a white flash
    icon: opts && opts.icon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  splashWin.once('ready-to-show', () => {
    if (splashWin && !splashWin.isDestroyed()) {
      splashWin.show();
      logLine('info', '[splash] shown');
    }
  });

  splashWin.webContents.once('did-finish-load', () => {
    // Inject the real logo SVG content into the placeholder element.
    // We set innerHTML + retarget the viewBox so the source asset's
    // coordinate system maps onto the 180x180 box defined in CSS.
    const { inner, viewBox } = readLogoInner();
    const js =
      'try {' +
      '  var el = document.getElementById("logo");' +
      '  if (el) {' +
      '    el.setAttribute("viewBox", ' + JSON.stringify(viewBox) + ');' +
      '    el.innerHTML = ' + JSON.stringify(inner) + ';' +
      '  }' +
      '} catch (e) { /* swallow */ }';
    splashWin.webContents.executeJavaScript(js).catch((err) => {
      logLine('warn', `[splash] logo injection failed: ${err && err.message}`);
    });
  });

  splashWin.on('closed', () => {
    splashWin = null;
    destroyed = true;
  });

  splashWin.loadFile(SPLASH_HTML).catch((err) => {
    logLine('error', `[splash] loadFile failed: ${err && err.message}`);
  });

  logLine('info', `[splash] created (html=${SPLASH_HTML})`);
  return splashWin;
}

/**
 * Update the status line. Safe to call even after the splash is gone —
 * we just no-op. main.js does NOT need to await this; failure to
 * update text is non-fatal.
 */
function setStatus(text) {
  if (!splashWin || splashWin.isDestroyed() || destroyed) return;
  const js = 'window.streamcheatsSplash && window.streamcheatsSplash.setStatus(' + JSON.stringify(String(text)) + ')';
  splashWin.webContents
    .executeJavaScript(js)
    .then(() => {
      logLine('info', `[splash] status=${String(text)}`);
    })
    .catch((err) => {
      logLine('warn', `[splash] setStatus failed: ${err && err.message}`);
    });
}

/**
 * Trigger the CSS fadeout animation. Caller is responsible for
 * scheduling destroy() ~320ms later (matches the keyframes duration
 * in splash.html).
 */
function beginClose() {
  if (!splashWin || splashWin.isDestroyed() || destroyed) return;
  const js = 'window.streamcheatsSplash && window.streamcheatsSplash.beginClose()';
  splashWin.webContents.executeJavaScript(js).catch(() => {
    /* fade is best-effort; destroy() still cleans up */
  });
  logLine('info', '[splash] beginClose');
}

/**
 * Destroy the splash window. Idempotent.
 */
function destroy() {
  if (!splashWin) return;
  try {
    if (!splashWin.isDestroyed()) {
      splashWin.destroy();
    }
  } catch (err) {
    logLine('warn', `[splash] destroy failed: ${err && err.message}`);
  }
  splashWin = null;
  destroyed = true;
  logLine('info', '[splash] destroyed');
}

module.exports = { createSplash, setStatus, beginClose, destroy };
