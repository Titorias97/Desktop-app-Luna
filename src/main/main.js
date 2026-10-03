'use strict';
/**
 * Luna — interactive pixel-art wallpaper.
 *
 * Creates one frameless window per display, parks it behind the desktop icons
 * on Windows (see wallpaper.js), feeds cursor samples to the renderer and keeps
 * a tray icon for settings. On macOS/Linux the window is created at desktop
 * level; `--window` forces a normal window anywhere (handy for development).
 */
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, powerMonitor, nativeImage, shell } = require('electron');
const path = require('path');
const log = require('./log');
const { Settings } = require('./settings');
const wallpaper = require('./wallpaper');

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const ICONS = path.join(__dirname, 'icons');
const FORCE_WINDOW = process.argv.includes('--window');

let settings = null;
let tray = null;
let windows = []; // { win, display, physical, host, paused, lastMsg }
let cursorTimer = null;
let watchTimer = null;
let rebuildTimer = null;
let quitting = false;
let locked = false;
let suspended = false;
let lastDown = false;

const wallpaperMode = () => !FORCE_WINDOW && process.platform === 'win32' && wallpaper.available();

// Wallpaper windows live behind the desktop icons; Chromium would otherwise
// consider them occluded and stop animating.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (tray) tray.popUpContextMenu(); });
  app.whenReady().then(start).catch((err) => { log.error('startup failed', err); app.quit(); });
}

function start() {
  const userData = app.getPath('userData');
  log.init(userData);
  settings = new Settings(userData);
  log.info(`Luna starting (electron ${process.versions.electron}, ${process.platform}, wallpaper mode: ${wallpaperMode()})`);
  if (process.platform === 'win32') app.setAppUserModelId('com.titorias97.luna');
  wallpaper.rememberWallpaper();

  ipcMain.on('ready', (e) => {
    e.sender.send('settings', settings.forRenderer());
    const entry = windows.find((w) => w.win.webContents === e.sender);
    if (entry) e.sender.send('pause', entry.paused);
  });

  buildTray();
  createWindows();
  startCursorPolling();
  watchTimer = setInterval(watchState, 1000);

  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { suspended = true; });
  powerMonitor.on('resume', () => { suspended = false; scheduleRebuild(); });
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, scheduleRebuild);

  app.on('before-quit', () => {
    quitting = true;
    clearInterval(cursorTimer);
    clearInterval(watchTimer);
    for (const w of windows) { try { wallpaper.detach(w.win); } catch (e) { /* ignore */ } }
    wallpaper.restoreWallpaper();
  });
  // The tray keeps us alive; windows only disappear when Explorer restarts.
  app.on('window-all-closed', () => { if (!quitting) scheduleRebuild(); });
}

// ---------------------------------------------------------------------------
function displaysToUse() {
  const all = screen.getAllDisplays();
  return settings.get('displays') === 'all' && all.length ? all : [screen.getPrimaryDisplay()];
}

function physicalBounds(display) {
  if (process.platform === 'win32' && typeof screen.dipToScreenRect === 'function') {
    try { return screen.dipToScreenRect(null, display.bounds); } catch (e) { /* fall through */ }
  }
  const s = display.scaleFactor || 1;
  const b = display.bounds;
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), width: Math.round(b.width * s), height: Math.round(b.height * s) };
}

function toDip(point) {
  if (process.platform === 'win32' && typeof screen.screenToDipPoint === 'function') {
    try { return screen.screenToDipPoint(point); } catch (e) { /* fall through */ }
  }
  const d = screen.getDisplayNearestPoint(point);
  const s = d.scaleFactor || 1;
  return { x: point.x / s, y: point.y / s };
}

function createWindows() {
  destroyWindows();
  const mode = wallpaperMode();
  for (const display of displaysToUse()) {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      title: 'Luna',
      frame: false,
      show: false,
      resizable: FORCE_WINDOW,
      movable: FORCE_WINDOW,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: !FORCE_WINDOW,
      focusable: FORCE_WINDOW,
      hasShadow: false,
      backgroundColor: '#06040d',
      type: !FORCE_WINDOW && process.platform !== 'win32' ? 'desktop' : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const entry = { win, display, physical: physicalBounds(display), host: null, paused: Boolean(settings.get('paused')), lastMsg: { present: false, x: -1, y: -1 } };
    windows.push(entry);
    win.setMenuBarVisibility(false);
    win.webContents.on('render-process-gone', (_e, details) => { log.error(`renderer gone: ${details.reason}`); scheduleRebuild(); });
    win.on('closed', () => { windows = windows.filter((w) => w.win !== win); if (!quitting && windows.length === 0) scheduleRebuild(); });
    win.once('ready-to-show', () => {
      try {
        win.showInactive();
        if (mode) {
          entry.host = wallpaper.attach(win, entry.physical);
          if (!entry.host) log.error('could not attach to the desktop; Luna is running as a normal window');
        }
      } catch (err) { log.error('show/attach failed', err); }
    });
    win.loadFile(RENDERER).catch((err) => log.error('loadFile failed', err));
  }
}

function destroyWindows() {
  for (const w of windows) { try { wallpaper.detach(w.win); w.win.destroy(); } catch (e) { /* ignore */ } }
  windows = [];
}

function scheduleRebuild() {
  if (quitting) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { log.info('rebuilding windows'); createWindows(); }, 1500);
}

// ---------------------------------------------------------------------------
function startCursorPolling() {
  cursorTimer = setInterval(() => {
    if (quitting || !windows.length) return;
    let dip;
    let overDesktop = true;
    let down = false;
    const sample = wallpaperMode() ? wallpaper.pollCursor() : null;
    if (sample) {
      dip = toDip({ x: sample.x, y: sample.y });
      overDesktop = sample.overDesktop;
      down = sample.down;
    } else {
      try { dip = screen.getCursorScreenPoint(); } catch (e) { return; }
    }
    const click = down && !lastDown;
    lastDown = down;
    const interactive = Boolean(settings.get('interactive'));
    for (const w of windows) {
      const b = w.display.bounds;
      const inside = dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height;
      const present = inside && overDesktop && interactive && !w.paused;
      const msg = { x: Math.round(dip.x - b.x), y: Math.round(dip.y - b.y), present, click: present && click };
      const last = w.lastMsg;
      if (msg.click || msg.present !== last.present || (present && (msg.x !== last.x || msg.y !== last.y))) {
        try { w.win.webContents.send('pointer', msg); } catch (e) { /* window going away */ }
        w.lastMsg = msg;
      }
    }
  }, 16);
}

/** Once a second: pause behind fullscreen/maximized apps, on the lock screen and while sleeping. */
function watchState() {
  if (quitting) return;
  const own = windows.map((w) => { try { return wallpaper.hwndOf(w.win); } catch (e) { return 0; } });
  for (const w of windows) {
    const coverage = wallpaperMode() ? wallpaper.foregroundCoverage(w.physical, own) : null;
    const covered = coverage === 'fullscreen' || (coverage === 'maximized' && Boolean(settings.get('pauseWhenCovered')));
    const shouldPause = Boolean(settings.get('paused')) || covered || locked || suspended;
    if (shouldPause !== w.paused) {
      w.paused = shouldPause;
      try { w.win.webContents.send('pause', shouldPause); } catch (e) { /* ignore */ }
    }
  }
}

function broadcastSettings() {
  for (const w of windows) { try { w.win.webContents.send('settings', settings.forRenderer()); } catch (e) { /* ignore */ } }
  refreshMenu();
}

// ---------------------------------------------------------------------------
function buildTray() {
  try {
    const file = path.join(ICONS, process.platform === 'win32' ? 'tray.ico' : 'tray.png');
    tray = new Tray(nativeImage.createFromPath(file));
    tray.setToolTip('Luna — haunted garden wallpaper');
    tray.on('click', () => tray.popUpContextMenu());
    refreshMenu();
  } catch (err) {
    log.error('tray failed', err);
  }
}

function refreshMenu() {
  if (!tray) return;
  const s = settings.data;
  const radio = (values, key, label, after) => values.map(([value, text]) => ({
    label: text, type: 'radio', checked: s[key] === value,
    click: () => { settings.set({ [key]: value }); (after || broadcastSettings)(); },
  }));
  const template = [
    { label: 'Luna 🌙', enabled: false },
    { type: 'separator' },
    { label: 'Pause', type: 'checkbox', checked: Boolean(s.paused), click: (item) => { settings.set({ paused: item.checked }); watchState(); } },
    { label: 'React to the cursor', type: 'checkbox', checked: Boolean(s.interactive), click: (item) => { settings.set({ interactive: item.checked }); broadcastSettings(); } },
    { label: 'Pause behind maximized windows', type: 'checkbox', checked: Boolean(s.pauseWhenCovered), click: (item) => { settings.set({ pauseWhenCovered: item.checked }); watchState(); } },
    { label: 'Luna', submenu: radio([['hd', 'HD sprite (Higgsfield)'], ['classic', 'Classic hand-drawn sprite']], 'luna') },
    { label: 'Background', submenu: radio([['hd', 'HD picture (Higgsfield)'], ['classic', 'Classic procedural graveyard']], 'bg') },
    { label: 'Picture detail', submenu: radio([['hd', 'Full resolution'], ['pixel', 'Snapped to the pixel grid']], 'detail') },
    { label: 'Pixel size', submenu: radio([[0, 'Automatic'], [2, '2×'], [3, '3×'], [4, '4×']], 'scale') },
    { label: 'Frame rate', submenu: radio([[24, '24 fps'], [30, '30 fps'], [60, '60 fps']], 'fps') },
    { label: 'Space for the taskbar', submenu: radio([[0, 'None'], [48, '48 px'], [72, '72 px'], [96, '96 px']], 'bottomInset') },
    { label: 'Displays', submenu: radio([['primary', 'Primary display'], ['all', 'All displays']], 'displays', null, () => { createWindows(); refreshMenu(); }) },
    { label: 'Launch at login', type: 'checkbox', checked: Boolean(s.launchAtLogin), click: (item) => { settings.set({ launchAtLogin: item.checked }); try { app.setLoginItemSettings({ openAtLogin: item.checked }); } catch (e) { log.error('login item failed', e); } } },
    { type: 'separator' },
    { label: 'Open log file', click: () => { const p = log.path(); if (p) shell.showItemInFolder(p); } },
    { label: 'Quit (restores your wallpaper)', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}
