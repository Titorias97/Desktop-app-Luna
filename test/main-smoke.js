/**
 * Runs src/main/main.js against a mocked Electron API so the main-process logic
 * (startup, settings, cursor polling, tray menu actions, shutdown) is exercised
 * without an Electron binary. `npm test` runs this before the screenshots.
 */
'use strict';
const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-smoke-'));
// A version-1 settings file stored its 'primary' default; it must move to spanning.
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ displays: 'primary', fps: 30 }));
const calls = [];
const handlers = {};
const on = (bucket) => (ev, cb) => { (handlers[`${bucket}:${ev}`] = handlers[`${bucket}:${ev}`] || []).push(cb); };

class WebContents {
  constructor() { this.sent = []; this.handlers = {}; }
  on(ev, cb) { this.handlers[ev] = cb; }
  send(ch, payload) { this.sent.push([ch, payload]); }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
}
class BrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.webContents = new WebContents();
    this.events = {};
    BrowserWindow.instances.push(this);
    calls.push(['BrowserWindow', opts.width, opts.height, opts.type]);
  }
  on(ev, cb) { this.events[ev] = cb; }
  once(ev, cb) { this.events[ev] = cb; if (ev === 'ready-to-show') setImmediate(cb); }
  loadFile(file) { calls.push(['loadFile', path.basename(file)]); return fs.existsSync(file) ? Promise.resolve() : Promise.reject(new Error(`missing ${file}`)); }
  setMenuBarVisibility() {}
  showInactive() { calls.push(['showInactive']); }
  destroy() { this.destroyed = true; if (this.events.closed) this.events.closed(); }
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(0x1234n); return b; }
}
BrowserWindow.instances = [];
class Tray {
  constructor(img) { this.img = img; Tray.instance = this; }
  setToolTip(t) { this.tip = t; }
  on(ev, cb) { this[`on_${ev}`] = cb; }
  setContextMenu(menu) { this.menu = menu; }
  popUpContextMenu() { calls.push(['popUpContextMenu']); }
}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const display2 = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1 };
let cursor = { x: 300, y: 700 };
const electron = {
  app: {
    requestSingleInstanceLock: () => true,
    on: on('app'),
    whenReady: () => Promise.resolve(),
    getPath: () => tmp,
    setAppUserModelId: (id) => calls.push(['appUserModelId', id]),
    quit: () => { calls.push(['quit']); (handlers['app:before-quit'] || []).forEach((cb) => cb()); },
    commandLine: { appendSwitch: (s) => calls.push(['switch', s]) },
    setLoginItemSettings: (o) => calls.push(['loginItem', o.openAtLogin]),
  },
  BrowserWindow,
  Tray,
  Menu: { buildFromTemplate: (t) => { validateMenu(t); return { template: t }; } },
  screen: {
    getAllDisplays: () => [display, display2],
    getPrimaryDisplay: () => display,
    on: on('screen'),
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: () => display,
  },
  ipcMain: { on: on('ipc') },
  powerMonitor: { on: on('power') },
  nativeImage: { createFromPath: (p) => { if (!fs.existsSync(p)) throw new Error(`icon missing ${p}`); return { path: p }; } },
  shell: { showItemInFolder: (p) => calls.push(['showItemInFolder', p]) },
};
function validateMenu(items) {
  for (const it of items) {
    if (it.type === 'separator') continue;
    if (typeof it.label !== 'string') throw new Error('menu item without label');
    if (it.submenu) validateMenu(it.submenu);
    else if (!it.click && it.enabled !== false) throw new Error(`menu item ${it.label} has no click`);
  }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : origLoad.call(this, request, ...rest); };

process.argv.push('--window');
require('../src/main/main.js');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

setTimeout(() => {
  try {
    assert(BrowserWindow.instances.length === 1, 'spanning: one renderer window, on the primary display');
    assert(calls.some((c) => c[0] === 'showInactive'), 'window shown');
    const win = BrowserWindow.instances[0];
    assert(win.opts.x === 0 && win.opts.width === 1920, 'span renderer sits on the primary display');
    // renderer says hello → gets settings (with the span layout) + pause state
    handlers['ipc:ready'][0]({ sender: win.webContents });
    const sent = win.webContents.sent.find(([ch]) => ch === 'settings');
    assert(sent && sent[1].fps === 30, 'settings sent to renderer');
    const span = sent[1].span;
    assert(span && span.width === 3200 && span.height === 1080 && span.views.length === 2, `span layout covers both displays (got ${JSON.stringify(span)})`);
    assert(span.views.find((v) => v.main).key === '1' && span.views.find((v) => !v.main).x === 1920, 'span views placed side by side');
    // the renderer opens the second display's view with window.open
    const open = win.webContents.openHandler;
    assert(open, 'window.open handler installed');
    assert(open({ frameName: 'something-else' }).action === 'deny', 'unknown window.open denied');
    const allowed = open({ frameName: 'luna-view-2' });
    assert(allowed.action === 'allow' && allowed.overrideBrowserWindowOptions.x === 1920 && allowed.overrideBrowserWindowOptions.width === 1280, 'view window placed on display 2');
    const child = new BrowserWindow(allowed.overrideBrowserWindowOptions);
    win.webContents.handlers['did-create-window'](child, { frameName: 'luna-view-2' });
    assert(calls.filter((c) => c[0] === 'showInactive').length >= 2, 'view window shown');
    // cursor polling delivers pointer samples relative to the display
    setTimeout(() => {
      const ptr = win.webContents.sent.filter(([ch]) => ch === 'pointer');
      assert(ptr.length > 0, 'pointer samples sent');
      assert(ptr[0][1].x === 300 && ptr[0][1].y === 700 && ptr[0][1].present === true, 'pointer coordinates');
      assert(child.webContents.sent.length === 0, 'view windows get no messages of their own');
      cursor = { x: 2500, y: 100 };
    }, 60);
    setTimeout(() => {
      const ptr = win.webContents.sent.filter(([ch]) => ch === 'pointer');
      const last = ptr[ptr.length - 1][1];
      assert(last.x === 2500 && last.y === 100 && last.present === true, `pointer on the second display reaches the span renderer (got ${JSON.stringify(last)})`);
      // exercise every tray menu action
      const walk = (items) => { for (const it of items) { if (it.submenu) walk(it.submenu); else if (it.click) it.click({ checked: !it.checked }); } };
      walk(Tray.instance.menu.template);
      const resolution = Tray.instance.menu.template.find((it) => it.label === 'Resolution');
      assert(resolution && resolution.submenu, 'Resolution submenu present');
      const resLabels = resolution.submenu.filter((it) => it.type === 'radio').map((it) => it.label);
      for (const want of ['Automatic', '1080p (3×)', '1440p (4×)', '4K (6×)']) assert(resLabels.includes(want), `Resolution preset "${want}" (got ${resLabels.join(', ')})`);
      assert(calls.some((c) => c[0] === 'loginItem'), 'login item toggled');
      assert(calls.some((c) => c[0] === 'showItemInFolder'), 'log folder opened');
      const settingsFile = path.join(tmp, 'settings.json');
      assert(fs.existsSync(settingsFile), 'settings persisted');
      const weather = Tray.instance.menu.template.find((it) => it.label === 'Weather');
      assert(weather && weather.submenu.map((it) => it.label).join('|') === 'Random rain and snow|Always clear|Rain now|Snow now', 'Weather submenu');
      weather.submenu.find((it) => it.label === 'Snow now').click({});
      assert(win.webContents.sent.some(([ch, p]) => ch === 'settings' && p.weather === 'snow'), 'weather choice sent to the renderer');
      const displays = Tray.instance.menu.template.find((it) => it.label === 'Displays');
      assert(displays.submenu.map((it) => it.label)[0] === 'Span across all displays (one scene)', 'span listed first');
      displays.submenu.find((it) => it.label === 'Same scene on each display').click({});
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert(saved.displays === 'all' && saved.version === 2, 'displays setting changed by the menu');
      // "Same scene on each display" rebuilt the windows: one renderer per display
      const live = BrowserWindow.instances.filter((w) => !w.destroyed);
      assert(live.length === 2 && live.every((w) => w.webContents.openHandler === undefined), `two plain windows after choosing a copy per display (got ${live.length})`);
      // power events + quit path
      handlers['power:lock-screen'][0]();
      electron.app.quit();
      assert(calls.some((c) => c[0] === 'quit'), 'quit handled');
      console.log('main-process smoke test ok');
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(0);
    }, 160);
  } catch (err) { console.error(err); process.exit(1); }
}, 150);
