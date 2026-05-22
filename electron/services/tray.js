// Tray + context menu. Caller owns the actual show/hide/exit behaviour
// — this module just renders the menu and forwards click events.
'use strict';

const fs = require('fs');
const { Menu, Tray, nativeImage } = require('electron');

function buildMenu({ isWindowVisible, onToggle, onExit }) {
  return Menu.buildFromTemplate([
    {
      label: isWindowVisible() ? 'Hide' : 'Show',
      click: () => onToggle(),
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => onExit(),
    },
  ]);
}

function create({ iconPath, tooltip, isWindowVisible, onToggle, onExit }) {
  let image = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) {
    try {
      image = nativeImage.createFromPath(iconPath);
    } catch (err) {
      console.warn(`[tray] failed to load icon: ${err.message}`);
    }
  } else {
    console.warn(`[tray] icon not found at ${iconPath}`);
  }
  const tray = new Tray(image);
  tray.setToolTip(tooltip || '');
  const refresh = () => {
    tray.setContextMenu(
      buildMenu({ isWindowVisible, onToggle, onExit })
    );
  };
  refresh();
  tray.on('click', () => onToggle());
  return { tray, refresh };
}

module.exports = { create };
