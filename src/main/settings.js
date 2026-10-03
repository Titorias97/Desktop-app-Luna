'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  scale: 0,          // 0 = automatic (3 at 1080p, 4 at 1440p, 6 at 4K)
  bottomInset: 48,   // physical pixels kept free at the bottom (taskbar)
  interactive: true, // react to the cursor
  fps: 30,
  luna: 'hd',     // 'hd' (Higgsfield sprite) | 'classic' (hand-drawn)
  bg: 'hd',       // 'hd' (Higgsfield picture) | 'classic' (procedural graveyard)
  detail: 'hd',   // 'hd' (full-resolution picture) | 'pixel' (snapped to the sprite grid)
  displays: 'primary', // 'primary' | 'all'
  paused: false,
  pauseWhenCovered: true, // also pause behind maximized windows (saves battery)
  launchAtLogin: false,
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      if (fs.existsSync(this.file)) Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) { /* corrupt file: keep defaults */ }
  }
  get(key) { return this.data[key]; }
  set(patch) {
    Object.assign(this.data, patch);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch (e) { /* ignore */ }
    return this.data;
  }
  /** The subset the renderer cares about. */
  forRenderer() {
    const { scale, bottomInset, interactive, fps, luna, bg, detail } = this.data;
    return { scale, bottomInset, interactive, fps, luna, bg, detail };
  }
}

module.exports = { Settings, DEFAULTS };
