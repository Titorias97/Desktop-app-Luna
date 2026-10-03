/* Sprite sheets, frame animators and tiny procedural pixel icons. */
(function (Luna) {
  'use strict';

  /** A sprite sheet laid out in a grid of equally sized frames. */
  class Sheet {
    constructor(img, w, h, cols) {
      this.img = img;
      this.w = w;
      this.h = h;
      this.cols = cols;
    }
    /** Draws frame `i` with its bottom-centre at (x, y). */
    draw(ctx, i, x, y, flip = false, alpha = 1) {
      const sx = (i % this.cols) * this.w;
      const sy = Math.floor(i / this.cols) * this.h;
      const dx = Math.round(x - this.w / 2);
      const dy = Math.round(y - this.h);
      if (alpha !== 1) ctx.globalAlpha = alpha;
      if (flip) {
        ctx.save();
        ctx.translate(dx + this.w, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(this.img, sx, sy, this.w, this.h, 0, 0, this.w, this.h);
        ctx.restore();
      } else {
        ctx.drawImage(this.img, sx, sy, this.w, this.h, dx, dy, this.w, this.h);
      }
      if (alpha !== 1) ctx.globalAlpha = 1;
    }
  }

  /** Plays a list of frame indices with per-frame durations (ms). */
  class Animator {
    constructor(frames, ms, loop = true) {
      this.set(frames, ms, loop);
    }
    set(frames, ms, loop = true) {
      this.frames = frames;
      this.ms = ms;
      this.loop = loop;
      this.index = 0;
      this.elapsed = 0;
      this.done = false;
      return this;
    }
    update(dtMs) {
      if (this.done || this.frames.length <= 1) return;
      this.elapsed += dtMs;
      while (this.elapsed >= this.ms[this.index]) {
        this.elapsed -= this.ms[this.index];
        if (this.index + 1 >= this.frames.length) {
          if (this.loop) this.index = 0;
          else { this.done = true; break; }
        } else {
          this.index++;
        }
      }
    }
    get frame() {
      return this.frames[this.index];
    }
  }

  /** Converts a Pokémon manifest entry into an Animator (loops forever). */
  function animatorFromSequence(seq) {
    return new Animator(seq.map((s) => s.i), seq.map((s) => s.ms), true);
  }

  // ---------------------------------------------------------------------------
  // Procedural pixel icons. Each is an ASCII grid rendered to a cached canvas.
  // ---------------------------------------------------------------------------
  const ICONS = {
    heart: { pal: { r: '#ff5c8a', R: '#ffa3c0', o: '#5a1430' }, rows: [
      '.oo.oo.',
      'orRorro',
      'orrrrro',
      '.orrro.',
      '..oro..',
      '...o...',
    ]},
    heartSmall: { pal: { r: '#ff5c8a', R: '#ffa3c0' }, rows: [
      'rR.rR',
      'rrrrr',
      '.rrr.',
      '..r..',
    ]},
    sparkle: { pal: { w: '#fff6c8', y: '#ffe08a' }, rows: [
      '..w..',
      '.wyw.',
      'wyyyw',
      '.wyw.',
      '..w..',
    ]},
    sparkleSmall: { pal: { w: '#ffffff' }, rows: [
      '.w.',
      'www',
      '.w.',
    ]},
    note: { pal: { n: '#e9d5ff', o: '#3b2160' }, rows: [
      '...oo',
      '...on',
      '...on',
      '.oooon',
      'onnnon',
      'onnno.',
      '.ooo..',
    ]},
    bang: { pal: { w: '#fff3f8', o: '#3a1030' }, rows: [
      '.ooo.',
      'owwwo',
      'owwwo',
      'owwwo',
      '.owo.',
      '.owo.',
      '..o..',
      '.ooo.',
      'owwwo',
      '.ooo.',
    ]},
    zz: { pal: { z: '#cdb8f5' }, rows: [
      'zzzz',
      '..z.',
      '.z..',
      'zzzz',
    ]},
    snow: { pal: { w: '#e8fbff', b: '#9fd9ff' }, rows: [
      '.b.',
      'bwb',
      '.b.',
    ]},
    dust: { pal: { d: '#8a7a9a' }, rows: [
      '.d.',
      'd.d',
      '.d.',
    ]},
    batA: { pal: { k: '#1a1024', e: '#ff4f6a' }, rows: [
      'k.........k',
      'kk...k...kk',
      'kkkk.k.kkkk',
      '.kkkkkkkkk.',
      '...kkkkk...',
      '....e.e....',
    ]},
    batB: { pal: { k: '#1a1024', e: '#ff4f6a' }, rows: [
      '...........',
      '...........',
      '.....k.....',
      'kkkkkkkkkkk',
      'k..kkkkk..k',
      '....e.e....',
    ]},
    star: { pal: { w: '#fff8dc' }, rows: [
      '.w.',
      'www',
      '.w.',
    ]},
  };

  const iconCache = new Map();
  /** Returns a canvas with the icon drawn, cached by name. */
  function icon(name) {
    if (iconCache.has(name)) return iconCache.get(name);
    const def = ICONS[name];
    const c = document.createElement('canvas');
    c.width = def.rows[0].length;
    c.height = def.rows.length;
    const g = c.getContext('2d');
    def.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const col = def.pal[row[x]];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    });
    iconCache.set(name, c);
    return c;
  }

  /** Draws an icon centred at (x, y). */
  function drawIcon(ctx, name, x, y, alpha = 1) {
    const c = icon(name);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(c, Math.round(x - c.width / 2), Math.round(y - c.height / 2));
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  /** Chunky radial glow (drawn with 'lighter' so it adds light to the scene). */
  function drawGlow(ctx, x, y, r, color, alpha) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, Luna.util.rgba(color, alpha));
    grad.addColorStop(0.5, Luna.util.rgba(color, alpha * 0.35));
    grad.addColorStop(1, Luna.util.rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }

  /** Pixel ellipse (filled) — used for ground shadows. */
  function fillEllipse(ctx, cx, cy, rx, ry, color) {
    ctx.fillStyle = color;
    for (let y = -ry; y <= ry; y++) {
      const w = Math.floor(rx * Math.sqrt(1 - (y * y) / (ry * ry)));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
    }
  }

  Luna.sprites = { Sheet, Animator, animatorFromSequence, icon, drawIcon, drawGlow, fillEllipse };
})(window.Luna);
