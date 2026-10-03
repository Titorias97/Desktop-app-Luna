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
  // Ask Progman to create the WorkerW behind the desktop icons. Both forms are
  // sent because different Windows builds expect different lParam values.
  const out = [0];
  a.SendMessageTimeoutW(progman, 0x052c, 0xd, 0x1, 0, 1000, out);
  a.SendMessageTimeoutW(progman, 0x052c, 0xd, 0x0, 0, 1000, out);

  let host = 0;
  // Windows 11 24H2 and later: the icons' SHELLDLL_DefView lives inside Progman
  // and the wallpaper WorkerW is a child of Progman as well.
  const defViewInProgman = num(a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null));
  if (defViewInProgman) {
    host = num(a.FindWindowExW(progman, 0, 'WorkerW', null));
    if (!host) host = progman;
  } else {
    // Classic layout: a top-level WorkerW holds SHELLDLL_DefView and the
    // *next* WorkerW sibling is the one drawn behind the icons.
    a.EnumWindows((hwnd) => {
      const defView = num(a.FindWindowExW(num(hwnd), 0, 'SHELLDLL_DefView', null));
      if (defView) {
        host = num(a.FindWindowExW(0, num(hwnd), 'WorkerW', null));
        if (host) return false;
      }
      return true;
    }, 0);
    if (!host) host = progman;
  }
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
    a.SetParent(hwnd, found.host);
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

let originalWallpaper = null;
function rememberWallpaper() {
  const a = load();
  if (!a) return;
  try {
    const buf = Buffer.alloc(260 * 2);
    if (a.SystemParametersInfoW(0x73 /* SPI_GETDESKWALLPAPER */, 260, buf, 0)) {
      originalWallpaper = buf.toString('utf16le').split('\0')[0];
      log.info(`original wallpaper: ${originalWallpaper}`);
    }
  } catch (err) { log.error('could not read wallpaper path', err); }
}

/** Re-applies the wallpaper Windows had before we started (clears the black area left behind). */
function restoreWallpaper() {
  const a = load();
  if (!a || !originalWallpaper) return;
  try {
    const buf = Buffer.from(`${originalWallpaper}\0`, 'utf16le');
    a.SystemParametersInfoW(0x14 /* SPI_SETDESKWALLPAPER */, 0, buf, 0x01 | 0x02);
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

module.exports = { available: () => Boolean(load()), attach, position, detach, rememberWallpaper, restoreWallpaper, pollCursor, foregroundCoverage, hwndOf };
