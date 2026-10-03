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
const calls = [];
const handlers = {};
const on = (bucket) => (ev, cb) => { (handlers[`${bucket}:${ev}`] = handlers[`${bucket}:${ev}`] || []).push(cb); };

class WebContents {
  constructor() { this.sent = []; this.handlers = {}; }
  on(ev, cb) { this.handlers[ev] = cb; }
  send(ch, payload) { this.sent.push([ch, payload]); }
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
    assert(BrowserWindow.instances.length === 1, 'one window for the primary display');
    assert(calls.some((c) => c[0] === 'showInactive'), 'window shown');
    const win = BrowserWindow.instances[0];
    // renderer says hello → gets settings + pause state
    handlers['ipc:ready'][0]({ sender: win.webContents });
    assert(win.webContents.sent.some(([ch, p]) => ch === 'settings' && p.fps === 30), 'settings sent to renderer');
    // cursor polling delivers pointer samples relative to the display
    setTimeout(() => {
      const ptr = win.webContents.sent.filter(([ch]) => ch === 'pointer');
      assert(ptr.length > 0, 'pointer samples sent');
      assert(ptr[0][1].x === 300 && ptr[0][1].y === 700 && ptr[0][1].present === true, 'pointer coordinates');
      // exercise every tray menu action
      const walk = (items) => { for (const it of items) { if (it.submenu) walk(it.submenu); else if (it.click) it.click({ checked: !it.checked }); } };
      walk(Tray.instance.menu.template);
      assert(calls.some((c) => c[0] === 'loginItem'), 'login item toggled');
      assert(calls.some((c) => c[0] === 'showItemInFolder'), 'log folder opened');
      const settingsFile = path.join(tmp, 'settings.json');
      assert(fs.existsSync(settingsFile), 'settings persisted');
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert(saved.displays === 'all', 'displays setting changed by the menu');
      // "All displays" rebuilt the windows: now two
      const live = BrowserWindow.instances.filter((w) => !w.destroyed);
      assert(live.length === 2, `two windows after choosing all displays (got ${live.length})`);
      // power events + quit path
      handlers['power:lock-screen'][0]();
      electron.app.quit();
      assert(calls.some((c) => c[0] === 'quit'), 'quit handled');
      console.log('main-process smoke test ok');
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(0);
    }, 120);
  } catch (err) { console.error(err); process.exit(1); }
}, 150);
