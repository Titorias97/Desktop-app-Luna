'use strict';
/**
 * Windows desktop integration through koffi (FFI, no native compilation).
 *
 * - attach(): parents a window to the WorkerW that sits behind the desktop
 *   icons (the same trick Wallpaper Engine / Lively use), covering one display.
 * - pollCursor(): reads the cursor position and left button state so the
 *   renderer can react even though Windows never routes real mouse input to a
 *   window living behind the desktop icons.
 * - isFullscreenAppOn(): true when a game/video covers the display, so the
 *   wallpaper can pause and save battery.
 * - restoreWallpaper(): re-applies the original wallpaper when we quit.
 *
 * Every function is defensive: on any failure the app falls back to a normal
 * window instead of crashing.
 */
const log = require('./log');

let api = null;

function load() {
  if (api !== null) return api;
  if (process.platform !== 'win32') { api = false; return api; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');
    const f = (sig) => user32.func(sig);
    api = {
      koffi,
      FindWindowW: f('uintptr_t __stdcall FindWindowW(const char16_t* cls, const char16_t* name)'),
      FindWindowExW: f('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t* cls, const char16_t* name)'),
      SendMessageTimeoutW: f('uintptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t* result)'),
      EnumWindows: f('bool __stdcall EnumWindows(EnumWindowsProc* cb, intptr_t lParam)'),
      SetParent: f('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)'),
      SetWindowPos: f('bool __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
      GetSystemMetrics: f('int __stdcall GetSystemMetrics(int index)'),
      GetCursorPos: f('bool __stdcall GetCursorPos(_Out_ POINT* p)'),
      GetAsyncKeyState: f('int16_t __stdcall GetAsyncKeyState(int key)'),
      WindowFromPoint: f('uintptr_t __stdcall WindowFromPoint(POINT p)'),
      GetAncestor: f('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)'),
      GetClassNameW: f('int __stdcall GetClassNameW(uintptr_t hwnd, void* buf, int max)'),
      GetForegroundWindow: f('uintptr_t __stdcall GetForegroundWindow()'),
      GetWindowRect: f('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ RECT* r)'),
      SystemParametersInfoW: f('bool __stdcall SystemParametersInfoW(uint32_t action, uint32_t param, void* pv, uint32_t winini)'),
      IsWindow: f('bool __stdcall IsWindow(uintptr_t hwnd)'),
      IsZoomed: f('bool __stdcall IsZoomed(uintptr_t hwnd)'),
      GetLastError: koffi.load('kernel32.dll').func('uint32_t __stdcall GetLastError()'),
    };
    void POINT; void RECT; void EnumWindowsProc;
    return api;
  } catch (err) {
    log.error('koffi/user32 unavailable, running as a normal window', err);
    api = false;
    return api;
  }
}

const num = (v) => Number(v);

function className(a, hwnd) {
  const buf = Buffer.alloc(256 * 2);
  const n = a.GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

/** Finds (or spawns) the window that hosts the wallpaper behind the icons. */
function findWallpaperHost() {
  const a = load();
  if (!a) return null;
  const progman = num(a.FindWindowW('Progman', null));
  if (!progman) return null;
  // Windows 11 24H2 and later: the icons' SHELLDLL_DefView lives inside Progman
  // and the wallpaper WorkerW is a child of Progman as well.
  const defViewInProgman = num(a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null));
  const locate = () => {
    if (defViewInProgman) return num(a.FindWindowExW(progman, 0, 'WorkerW', null));
    // Classic layout: a top-level WorkerW holds SHELLDLL_DefView and the
    // *next* WorkerW sibling is the one drawn behind the icons.
    let found = 0;
    a.EnumWindows((hwnd) => {
      const defView = num(a.FindWindowExW(num(hwnd), 0, 'SHELLDLL_DefView', null));
      if (defView) {
        found = num(a.FindWindowExW(0, num(hwnd), 'WorkerW', null));
        if (found) return false;
      }
      return true;
    }, 0);
    return found;
  };

  // Ask Progman to create the WorkerW behind the desktop icons. lParam=1 is the
  // form current builds expect. Explorer reference-counts these requests on
  // Windows 11 24H2: lParam=0 releases the WorkerW again and destroys it a
  // moment later, so the legacy lParam=0 form is only sent when lParam=1
  // produced nothing (older builds).
  const out = [0];
  a.SendMessageTimeoutW(progman, 0x052c, 0xd, 0x1, 0, 1000, out);
  let host = locate();
  if (!host) {
    a.SendMessageTimeoutW(progman, 0x052c, 0xd, 0x0, 0, 1000, out);
    host = locate();
  }
  if (!host) host = progman;
  log.info(`wallpaper host hwnd=${host} (progman=${progman}, 24H2 layout=${Boolean(defViewInProgman)})`);
  return { progman, host };
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

/**
 * Parents `win` to the wallpaper host and sizes it to `physical` (a rect in
 * physical screen pixels). Returns the host hwnd or null on failure.
 */
function attach(win, physical) {
  const a = load();
  if (!a) return null;
  try {
    const found = findWallpaperHost();
    if (!found) return null;
    const hwnd = hwndOf(win);
    if (!num(a.SetParent(hwnd, found.host))) {
      log.error(`SetParent(${hwnd}, ${found.host}) failed (GetLastError=${a.GetLastError()}, host alive=${a.IsWindow(found.host)})`);
      return null;
    }
    position(win, physical);
    return found;
  } catch (err) {
    log.error('attach failed', err);
    return null;
  }
}

/** Places the (already attached) window; coordinates are relative to the virtual screen origin. */
function position(win, physical) {
  const a = load();
  if (!a) return;
  const vx = a.GetSystemMetrics(76); // SM_XVIRTUALSCREEN
  const vy = a.GetSystemMetrics(77); // SM_YVIRTUALSCREEN
  const SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  a.SetWindowPos(hwndOf(win), 0, physical.x - vx, physical.y - vy, physical.width, physical.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

function detach(win) {
  const a = load();
  if (!a) return;
  try { a.SetParent(hwndOf(win), 0); } catch (err) { log.error('detach failed', err); }
}

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DARK_FILE = 'luna-dark-wallpaper.png';
const STATE_FILE = 'wallpaper-state.json';
const DARK_RGB = [0x06, 0x04, 0x0d]; // the scene's night-sky colour

let originalWallpaper = null;
let stateDir = null;

function setSystemWallpaper(a, file) {
  const buf = Buffer.from(`${file}\0`, 'utf16le');
  return Boolean(a.SystemParametersInfoW(0x14 /* SPI_SETDESKWALLPAPER */, 0, buf, 0x01 | 0x02 /* UPDATEINIFILE | SENDCHANGE */));
}

/**
 * Reads the current wallpaper so it can be restored on quit. The path is also
 * persisted to `dir` so that, if a previous run died while the dark wallpaper
 * was applied, the real original is restored rather than our own dark file.
 */
function rememberWallpaper(dir) {
  const a = load();
  if (!a) return;
  stateDir = dir || null;
  try {
    const buf = Buffer.alloc(260 * 2);
    if (a.SystemParametersInfoW(0x73 /* SPI_GETDESKWALLPAPER */, 260, buf, 0)) {
      originalWallpaper = buf.toString('utf16le').split('\0')[0];
    }
    const stateFile = stateDir && path.join(stateDir, STATE_FILE);
    if (stateFile && originalWallpaper && path.basename(originalWallpaper).toLowerCase() === DARK_FILE) {
      // Left over from a run that did not quit cleanly: use what that run saved.
      try { originalWallpaper = JSON.parse(fs.readFileSync(stateFile, 'utf8')).original || null; } catch (e) { originalWallpaper = null; }
    } else if (stateFile && originalWallpaper) {
      try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ original: originalWallpaper })); } catch (e) { /* ignore */ }
    }
    log.info(`original wallpaper: ${originalWallpaper}`);
  } catch (err) { log.error('could not read wallpaper path', err); }
}

/** Minimal PNG encoder for a solid colour (no pngjs at runtime). */
function solidPng(width, height, [r, g, b]) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Switches the system wallpaper to a solid dark picture while Luna runs, so
 * the translucent taskbar (which blurs the static wallpaper, not our window)
 * blends with the scene. Returns the file path, or null when not applied.
 */
function applyDarkWallpaper(dir) {
  const a = load();
  if (!a) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, DARK_FILE);
    if (!fs.existsSync(file)) fs.writeFileSync(file, solidPng(64, 64, DARK_RGB));
    if (!setSystemWallpaper(a, file)) { log.error('could not apply the dark wallpaper'); return null; }
    return file;
  } catch (err) { log.error('applyDarkWallpaper failed', err); return null; }
}

/** Re-applies the wallpaper Windows had before we started (clears the black area left behind). */
function restoreWallpaper() {
  const a = load();
  if (!a || !originalWallpaper) return;
  try {
    setSystemWallpaper(a, originalWallpaper);
    if (stateDir) { try { fs.unlinkSync(path.join(stateDir, STATE_FILE)); } catch (e) { /* ignore */ } }
  } catch (err) { log.error('restoreWallpaper failed', err); }
}

const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);

/** Cursor position (physical px), left-button state and whether it hovers the bare desktop. */
function pollCursor() {
  const a = load();
  if (!a) return null;
  const p = {};
  if (!a.GetCursorPos(p)) return null;
  const down = (a.GetAsyncKeyState(0x01) & 0x8000) !== 0;
  let overDesktop = false;
  try {
    const under = num(a.WindowFromPoint({ x: p.x, y: p.y }));
    if (under) {
      const root = num(a.GetAncestor(under, 2 /* GA_ROOT */)) || under;
      overDesktop = DESKTOP_CLASSES.has(className(a, root));
    }
  } catch (err) { /* ignore transient failures */ }
  return { x: p.x, y: p.y, down, overDesktop };
}

/**
 * Describes what the foreground window does to the given display (physical rect):
 * 'fullscreen' when it covers it completely (games, videos), 'maximized' when it is
 * a maximized app on that display, otherwise null.
 */
function foregroundCoverage(physical, ownHwnds) {
  const a = load();
  if (!a) return null;
  try {
    const fg = num(a.GetForegroundWindow());
    if (!fg || ownHwnds.includes(fg)) return null;
    const cls = className(a, fg);
    if (DESKTOP_CLASSES.has(cls) || cls === 'Shell_TrayWnd' || cls === 'Windows.UI.Core.CoreWindow') return null;
    const r = {};
    if (!a.GetWindowRect(fg, r)) return null;
    const covers = r.left <= physical.x && r.top <= physical.y && r.right >= physical.x + physical.width && r.bottom >= physical.y + physical.height;
    if (covers) return 'fullscreen';
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const onThisDisplay = cx >= physical.x && cx < physical.x + physical.width && cy >= physical.y && cy < physical.y + physical.height;
    if (onThisDisplay && a.IsZoomed(fg)) return 'maximized';
    return null;
  } catch (err) {
    return null;
  }
}

module.exports = { available: () => Boolean(load()), attach, position, detach, rememberWallpaper, applyDarkWallpaper, restoreWallpaper, pollCursor, foregroundCoverage, hwndOf };
