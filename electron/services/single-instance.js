// Single-instance lock + focus-on-second-instance behaviour. Returns
// `true` if we hold the lock and should keep running; `false` if
// another instance is already running and the caller should app.quit().
'use strict';

const { app } = require('electron');

function acquire({ getMainWindow }) {
  const got = app.requestSingleInstanceLock();
  if (!got) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
  return true;
}

module.exports = { acquire };
