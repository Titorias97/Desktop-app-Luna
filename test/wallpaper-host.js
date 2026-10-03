/**
 * Checks src/main/wallpaper.js against a fake user32 that behaves like
 * Explorer on Windows 11 24H2: the 0x052C message with lParam=1 spawns the
 * WorkerW behind the desktop icons, lParam=0 tears it down again a moment
 * later. attach() must end up with the window parented to a live WorkerW.
 * `npm test` runs this.
 */
'use strict';
const Module = require('module');

const PROGMAN = 100, DEFVIEW = 101, DESKTOP = 1;
let nextHwnd = 500;
const windows = new Map(); // hwnd -> { cls, parent, alive }
windows.set(PROGMAN, { cls: 'Progman', parent: DESKTOP, alive: true });
windows.set(DEFVIEW, { cls: 'SHELLDLL_DefView', parent: PROGMAN, alive: true });
let workerRefs = 0, worker = 0, pendingDestroy = 0, lastError = 0;
const calls = [];
let systemWallpaper = 'C:\Pictures\original.jpg';
const live = (h) => windows.has(h) && windows.get(h).alive;
// Explorer destroys the WorkerW on its own thread shortly after the message returns.
const tick = () => { if (pendingDestroy && live(pendingDestroy)) { windows.get(pendingDestroy).alive = false; } pendingDestroy = 0; };

const fakeUser32 = {
  FindWindowW: (cls) => (cls === 'Progman' ? PROGMAN : 0),
  FindWindowExW: (parent, after, cls) => {
    tick();
    let seen = !after;
    for (const [h, w] of windows) {
      if (!w.alive || w.parent !== parent) continue;
      if (!seen) { if (h === after) seen = true; continue; }
      if (!cls || w.cls === cls) return h;
    }
    return 0;
  },
  SendMessageTimeoutW: (hwnd, msg, wParam, lParam) => {
    calls.push(['msg', hwnd, msg, wParam, lParam]);
    if (hwnd === PROGMAN && msg === 0x052c) {
      if (lParam === 1) { workerRefs++; if (!worker || !live(worker)) { worker = nextHwnd++; windows.set(worker, { cls: 'WorkerW', parent: PROGMAN, alive: true }); } }
      else if (lParam === 0) { workerRefs = Math.max(0, workerRefs - 1); if (workerRefs === 0 && live(worker)) pendingDestroy = worker; }
    }
    return 1;
  },
  EnumWindows: () => true,
  SetParent: (child, parent) => {
    tick();
    calls.push(['SetParent', child, parent]);
    if (!live(parent)) { lastError = 1400; return 0; }
    if (!windows.has(child)) windows.set(child, { cls: 'Chrome_WidgetWin_1', parent: DESKTOP, alive: true });
    const old = windows.get(child).parent;
    windows.get(child).parent = parent;
    return old;
  },
  SetWindowPos: () => true,
  GetSystemMetrics: () => 0,
  GetCursorPos: () => false,
  GetAsyncKeyState: () => 0,
  WindowFromPoint: () => 0,
  GetAncestor: (h) => (windows.has(h) ? windows.get(h).parent : 0),
  GetClassNameW: (h, buf) => { const c = windows.has(h) ? windows.get(h).cls : ''; buf.write(c, 0, 'utf16le'); return c.length; },
  GetForegroundWindow: () => 0,
  GetWindowRect: () => false,
  SystemParametersInfoW: (action, param, buf) => {
    calls.push(['spi', action]);
    if (action === 0x73) { buf.write(`${systemWallpaper}\0`, 0, 'utf16le'); return true; }
    if (action === 0x14) { systemWallpaper = buf.toString('utf16le').split('\0')[0]; return true; }
    return false;
  },
  IsWindow: (h) => { tick(); return live(h); },
  IsZoomed: () => false,
  GetLastError: () => lastError,
};
const fakeKoffi = {
  load: () => ({ func: (sig) => { const name = sig.match(/__stdcall\s+(\w+)\s*\(/)[1]; if (!fakeUser32[name]) throw new Error(`fake user32 lacks ${name}`); return fakeUser32[name]; } }),
  struct: () => ({}),
  proto: () => ({}),
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'koffi' ? fakeKoffi : origLoad.call(this, request, ...rest); };
Object.defineProperty(process, 'platform', { value: 'win32' });

const wallpaper = require('../src/main/wallpaper.js');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); console.error(JSON.stringify(calls)); process.exit(1); } };

const WIN = 9000;
const win = { getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(WIN)); return b; } };
const found = wallpaper.attach(win, { x: 0, y: 0, width: 1920, height: 1080 });
assert(found && found.host, 'attach returns a host');
tick();
assert(live(found.host), `host ${found.host} must still be alive after attach`);
assert(windows.get(found.host).cls === 'WorkerW', `host must be the WorkerW, got ${windows.get(found.host).cls}`);
assert(windows.get(WIN) && windows.get(WIN).parent === found.host, 'window parented to the WorkerW');
const sp = calls.filter((c) => c[0] === 'SetParent');
assert(sp.length === 1 && sp[0][2] === found.host, 'SetParent called once with the live host');

// A dead host must not be reported as success.
windows.get(found.host).alive = false;
calls.length = 0;
const again = wallpaper.attach(win, { x: 0, y: 0, width: 1920, height: 1080 });
assert(!again || live(again.host), 'attach never returns a dead host');
// --- dark system wallpaper while Luna runs ---------------------------------
const fs = require('fs'), os = require('os'), path = require('path');
const { PNG } = require('pngjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-wp-'));
wallpaper.rememberWallpaper(dir);
const dark = wallpaper.applyDarkWallpaper(dir);
assert(dark && fs.existsSync(dark), 'dark wallpaper file written');
assert(systemWallpaper === dark, `system wallpaper switched to the dark file (got ${systemWallpaper})`);
const png = PNG.sync.read(fs.readFileSync(dark));
assert(png.width >= 16 && png.height >= 16, 'dark png has a size');
assert(png.data[0] === 0x06 && png.data[1] === 0x04 && png.data[2] === 0x0d && png.data[3] === 255, `dark png colour is #06040d (got ${png.data.slice(0, 4).join(',')})`);
wallpaper.restoreWallpaper();
assert(systemWallpaper === 'C:\Pictures\original.jpg', `restore puts the original back (got ${systemWallpaper})`);
// Crash scenario: a run applied the dark wallpaper and died before restoring.
wallpaper.rememberWallpaper(dir);
wallpaper.applyDarkWallpaper(dir);
assert(systemWallpaper === dark, "dark applied again");
// ...next launch:
wallpaper.rememberWallpaper(dir);
wallpaper.restoreWallpaper();
assert(systemWallpaper === 'C:\Pictures\original.jpg', `after a crash the persisted original is restored, not the dark file (got ${systemWallpaper})`);
fs.rmSync(dir, { recursive: true, force: true });
console.log('wallpaper host test ok');
