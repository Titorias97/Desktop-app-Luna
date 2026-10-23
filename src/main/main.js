'use strict';
/**
 * Luna — interactive pixel-art wallpaper.
 *
 * Creates frameless windows behind the desktop icons on Windows (see
 * wallpaper.js), one per display. In "span" mode a single renderer simulates
 * one scene across every display: it opens a window per extra display with
 * window.open and draws that display's slice into it, so characters walk from
 * one monitor onto the next. Main feeds cursor samples to the renderer and
 * keeps a tray icon for settings. On macOS/Linux the window is created at desktop
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
let windows = []; // { win, display, physical, host, paused, lastMsg, span?, master?, dead? }
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
  wallpaper.rememberWallpaper(userData);
  // A dark system wallpaper while we run: the taskbar blur samples it, not our window.
  if (wallpaperMode()) wallpaper.applyDarkWallpaper(userData);

  ipcMain.on('ready', (e) => {
    const entry = windows.find((w) => w.win.webContents === e.sender && !w.master);
    e.sender.send('settings', settingsFor(entry));
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
  return settings.get('displays') !== 'primary' && all.length ? all : [screen.getPrimaryDisplay()];
}

/**
 * One scene across all displays: the union of their bounds (DIP) becomes the
 * world and each display is a view into it. Null when there is nothing to span.
 */
function spanLayout(displays) {
  if (settings.get('displays') !== 'span' || displays.length < 2) return null;
  const x0 = Math.min(...displays.map((d) => d.bounds.x));
  const y0 = Math.min(...displays.map((d) => d.bounds.y));
  const x1 = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const y1 = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const primary = screen.getPrimaryDisplay().id;
  const main = displays.find((d) => d.id === primary) || displays[0];
  return {
    origin: { x: x0, y: y0 },
    width: x1 - x0,
    height: y1 - y0,
    views: displays.map((d) => ({
      key: String(d.id),
      x: d.bounds.x - x0,
      y: d.bounds.y - y0,
      width: d.bounds.width,
      height: d.bounds.height,
      dpr: d.scaleFactor || 1,
      main: d === main,
    })),
  };
}

function settingsFor(entry) {
  return { ...settings.forRenderer(), span: (entry && entry.span) || null };
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

function windowOptions(display) {
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    title: 'Luna',
    frame: false,
    show: false,
    // Wallpaper mode needs the client area to cover the whole display:
    // thickFrame adds invisible resize borders (an uncovered strip on the
    // left) and a non-resizable window is pinned to the work-area height
    // Chromium clamps it to at creation (a gap under the taskbar). The
    // window lives behind the icons, so the user cannot resize it anyway.
    resizable: true,
    thickFrame: FORCE_WINDOW,
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
  };
}

function track(win, display, extra) {
  const entry = { win, display, physical: physicalBounds(display), host: null, paused: Boolean(settings.get('paused')), lastMsg: { present: false, x: -1, y: -1 }, ...extra };
  windows.push(entry);
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    windows = windows.filter((w) => w !== entry);
    // A window closing on its own (Explorer restart, a lost span view) leaves a hole: rebuild.
    if (!quitting && !entry.dead) scheduleRebuild();
  });
  return entry;
}

function showAndAttach(entry) {
  try {
    entry.win.showInactive();
    if (wallpaperMode()) {
      entry.host = wallpaper.attach(entry.win, entry.physical);
      if (!entry.host) log.error('could not attach to the desktop; Luna is running as a normal window');
    }
  } catch (err) { log.error('show/attach failed', err); }
}

function createWindows() {
  destroyWindows();
  const displays = displaysToUse();
  const span = spanLayout(displays);
  // Spanning: one renderer on the main display; it opens the other views itself.
  const owners = span ? [displays.find((d) => String(d.id) === span.views.find((v) => v.main).key)] : displays;
  for (const display of owners) {
    const win = new BrowserWindow(windowOptions(display));
    const entry = track(win, display, { span });
    win.webContents.on('render-process-gone', (_e, details) => { log.error(`renderer gone: ${details.reason}`); scheduleRebuild(); });
    if (span) {
      const viewDisplay = (frameName) => {
        const m = /^luna-view-(.+)$/.exec(frameName || '');
        return m ? displays.find((d) => String(d.id) === m[1]) : null;
      };
      win.webContents.setWindowOpenHandler(({ frameName }) => {
        const d = viewDisplay(frameName);
        return d ? { action: 'allow', overrideBrowserWindowOptions: windowOptions(d) } : { action: 'deny' };
      });
      win.webContents.on('did-create-window', (child, { frameName }) => {
        const d = viewDisplay(frameName);
        if (!d) { child.destroy(); return; }
        showAndAttach(track(child, d, { master: entry }));
      });
    }
    win.once('ready-to-show', () => showAndAttach(entry));
    win.loadFile(RENDERER).catch((err) => log.error('loadFile failed', err));
  }
  log.info(span ? `spanning ${span.views.length} displays (${span.width}x${span.height} DIP)` : `${owners.length} window(s)`);
}

function destroyWindows() {
  const old = windows;
  windows = [];
  for (const w of old) w.dead = true;
  for (const w of old) { try { wallpaper.detach(w.win); w.win.destroy(); } catch (e) { /* ignore */ } }
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
    const contains = (b) => dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height;
    for (const w of windows) {
      if (w.master) continue; // span views are drawn by their master's renderer
      // A spanning renderer gets coordinates relative to the whole span.
      const inside = w.span ? windows.some((v) => (v === w || v.master === w) && contains(v.display.bounds)) : contains(w.display.bounds);
      const o = w.span ? w.span.origin : w.display.bounds;
      const present = inside && overDesktop && interactive && !w.paused;
      const msg = { x: Math.round(dip.x - o.x), y: Math.round(dip.y - o.y), present, click: present && click };
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
  const isCovered = (w) => {
    const coverage = wallpaperMode() ? wallpaper.foregroundCoverage(w.physical, own) : null;
    return coverage === 'fullscreen' || (coverage === 'maximized' && Boolean(settings.get('pauseWhenCovered')));
  };
  for (const w of windows) {
    if (w.master) continue;
    // A spanned scene keeps running while any of its displays is visible.
    const covered = windows.filter((v) => v === w || v.master === w).every(isCovered);
    const shouldPause = Boolean(settings.get('paused')) || covered || locked || suspended;
    if (shouldPause !== w.paused) {
      w.paused = shouldPause;
      try { w.win.webContents.send('pause', shouldPause); } catch (e) { /* ignore */ }
    }
  }
}

function broadcastSettings() {
  for (const w of windows) { if (!w.master) { try { w.win.webContents.send('settings', settingsFor(w)); } catch (e) { /* ignore */ } } }
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
    { label: 'Weather', submenu: radio([['auto', 'Random rain and snow'], ['clear', 'Always clear'], ['rain', 'Rain now'], ['snow', 'Snow now']], 'weather') },
    { label: 'Picture detail', submenu: radio([['hd', 'Full resolution'], ['pixel', 'Snapped to the pixel grid']], 'detail') },
    // Pixel scale: one preset per common monitor height (360 logical rows), plus fine steps.
    { label: 'Resolution', submenu: [...radio([[0, 'Automatic'], [3, '1080p (3×)'], [4, '1440p (4×)'], [6, '4K (6×)']], 'scale'), { type: 'separator' }, ...radio([[2, '2×'], [5, '5×'], [8, '8×']], 'scale')] },
    { label: 'Frame rate', submenu: radio([[24, '24 fps'], [30, '30 fps'], [60, '60 fps']], 'fps') },
    { label: 'Space for the taskbar', submenu: radio([[0, 'None'], [48, '48 px'], [72, '72 px'], [96, '96 px']], 'bottomInset') },
    { label: 'Displays', submenu: radio([['span', 'Span across all displays (one scene)'], ['all', 'Same scene on each display'], ['primary', 'Primary display only']], 'displays', null, () => { createWindows(); refreshMenu(); }) },
    { label: 'Launch at login', type: 'checkbox', checked: Boolean(s.launchAtLogin), click: (item) => { settings.set({ launchAtLogin: item.checked }); try { app.setLoginItemSettings({ openAtLogin: item.checked }); } catch (e) { log.error('login item failed', e); } } },
    { type: 'separator' },
    { label: 'Open log file', click: () => { const p = log.path(); if (p) shell.showItemInFolder(p); } },
    { label: 'Quit (restores your wallpaper)', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}
