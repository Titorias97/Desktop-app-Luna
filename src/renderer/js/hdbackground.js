/* Image-based background (Higgsfield-generated HD scene). Draws the picture
 * cover-fitted on a full-resolution canvas behind the pixel scene, and reuses
 * the procedural Background for the live layers (fog, bats, wisps, shooting
 * stars) plus star twinkle and light flicker at positions detected at build
 * time (scripts/hd-build.js). */
(function (Luna) {
  'use strict';
  const { rgba } = Luna.util;
  const { drawGlow } = Luna.sprites;

  /**
   * Cover-fit placement of an image inside a box, anchored to the bottom so
   * the ground stays visible on wide/short screens.
   */
  function coverFit(iw, ih, W, H) {
    const s = Math.max(W / iw, H / ih);
    const dw = iw * s;
    const dh = ih * s;
    return { s, x: (W - dw) / 2, y: H - dh, w: dw, h: dh };
  }

  class ImageBackground {
    /**
     * @param {HTMLImageElement} img the HD picture
     * @param {object} meta  window.LUNA_HD_BG (layout fractions, stars, lights, moon)
     * @param {number} W,H   logical scene size
     * @param {object} opts  { detail: 'hd'|'pixel', surfaces: [{ canvas, rect }], frame, inset }
     *   frame: the logical rect the picture is cover-fitted to (the main display);
     *   the rest of a wider scene (other displays) continues with mirrored
     *   copies, so every seam between copies lines up.
     *   surfaces: full-resolution canvases, each showing the logical rect `rect`.
     */
    constructor(img, meta, W, H, opts) {
      this.img = img;
      this.meta = meta;
      this.W = W;
      this.H = H;
      this.opts = opts;
      this.time = 0;
      const frame = opts.frame || { x: 0, y: 0, w: W, h: H };
      // A panorama keeps the original picture somewhere in the middle (meta.main,
      // fractions of its width): that part is fitted to the main display and the
      // extensions continue onto the others. Feature positions are fractions of the whole image.
      const main = meta.main || { x: 0, w: 1 };
      const fit = coverFit(img.width * main.w, img.height, frame.w, frame.h);
      const fullW = fit.w / main.w;
      this.fit = { s: fit.s, w: fullW, h: fit.h, x: frame.x + fit.x - main.x * fullW, y: frame.y + fit.y };
      const left = Math.max(0, Math.ceil(this.fit.x / this.fit.w));
      const right = Math.max(0, Math.ceil((W - this.fit.x - this.fit.w) / this.fit.w));
      this.tiles = [];
      for (let i = -left; i <= right; i++) this.tiles.push({ x: this.fit.x + i * this.fit.w, mirror: i % 2 !== 0 });
      const L = meta.layout;
      const fy = (f) => Math.round(this.fit.y + f * this.fit.h);
      const fx = (f, t = this.tiles[left]) => Math.round(t.x + (t.mirror ? 1 - f : f) * this.fit.w);
      // Picture features repeat in every copy; drop the ones off the scene.
      const everyTile = (list, make) => this.tiles.flatMap((t) => list.map((p, i) => make(p, i, (f) => fx(f, t)))).filter((p) => p.x > -40 && p.x < W + 40);
      this.layout = {
        horizon: fy(L.horizon),
        groundTop: fy(L.groundTop),
        groundBottom: Math.min(frame.y + frame.h - opts.inset - 4, fy(L.groundBottom)),
      };
      this.benchSpot = meta.bench ? { x: fx(meta.bench.x), y: fy(meta.bench.y) } : { x: Math.round(W * 0.3), y: this.layout.groundTop + 16 };
      this.benchSpot.half = Math.round(fit.w * 0.065); // half the bench's width (clicking it makes Luna sit)
      this.moon = meta.moon
        ? { x: fx(meta.moon.x), y: fy(meta.moon.y), r: Math.max(8, Math.round(meta.moon.r * this.fit.w)), lit: 1 }
        : { x: Math.round(W * 0.8), y: Math.round(this.layout.horizon * 0.3), r: 18, lit: 1 };
      this.moons = meta.moon ? everyTile([meta.moon], (m, _i, x) => ({ ...this.moon, x: x(m.x) })) : [this.moon];
      this.stars = everyTile(meta.stars || [], ([x, y], i, tx) => ({ x: tx(x), y: fy(y), phase: (i * 0.73) % 6.28, speed: 0.8 + ((i * 7) % 10) / 8, color: ['#ffffff', '#fff4d6', '#d8e4ff'][i % 3], big: false }));
      this.lights = everyTile(meta.lights || [], ([x, y, size], i, tx) => ({ x: tx(x), y: fy(y), size: Math.max(6, Math.round(size * this.fit.w)), seed: i * 1.37 }));
      // Outlines of things standing on the ground, so snow does not bury them.
      this.uprights = this.tiles.flatMap((tile) => (meta.uprights || []).map((u) => ({
        bars: !!u.bars,
        poly: u.poly.map(([x, y]) => [tile.x + (tile.mirror ? 1 - x : x) * this.fit.w, this.fit.y + y * this.fit.h]),
      }))).filter((u) => u.poly.some(([x]) => x > 0 && x < W));
      this.props = [];
      // Procedural helper only for the live layers (fog/bats/wisps/shooting stars).
      this.live = new Luna.Background(W, H, this.layout, (meta.seed || 7) + 1, { liveOnly: true });
      this.pixelLayer = null;
      if (opts.detail === 'pixel') {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.fillStyle = '#06040d';
        g.fillRect(0, 0, W, H);
        this.paintTiles(g, 1, 0, 0);
        this.pixelLayer = c;
      }
      for (const s of opts.surfaces || []) this.drawHd(s.canvas, s.rect);
    }

    /**
     * Draws every copy of the picture at k device px per logical px, with the
     * logical point (ox, oy) at the canvas origin. Edges are rounded to whole
     * device pixels so neighbouring copies meet without a hairline.
     */
    paintTiles(g, k, ox, oy) {
      const y0 = Math.round((this.fit.y - oy) * k);
      const y1 = Math.round((this.fit.y + this.fit.h - oy) * k);
      for (const t of this.tiles) {
        const x0 = Math.round((t.x - ox) * k);
        const x1 = Math.round((t.x + this.fit.w - ox) * k);
        if (x1 <= 0 || x0 >= g.canvas.width) continue;
        if (!t.mirror) { g.drawImage(this.img, x0, y0, x1 - x0, y1 - y0); continue; }
        g.save();
        g.translate(x1, 0);
        g.scale(-1, 1);
        g.drawImage(this.img, 0, y0, x1 - x0, y1 - y0);
        g.restore();
      }
    }

    /** The picture at the logical pixel size (what the weather dusts with snow). */
    drawSnapshot(g) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.fillStyle = '#06040d';
      g.fillRect(0, 0, this.W, this.H);
      if (this.pixelLayer) g.drawImage(this.pixelLayer, 0, 0);
      else this.paintTiles(g, 1, 0, 0);
    }

    /** Paints the picture on a full-resolution canvas showing the logical rect `rect`. */
    drawHd(c, rect) {
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.fillStyle = '#06040d';
      g.fillRect(0, 0, c.width, c.height);
      if (this.pixelLayer) {
        g.imageSmoothingEnabled = false;
        g.drawImage(this.pixelLayer, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
        return;
      }
      this.paintTiles(g, c.width / rect.w, rect.x, rect.y);
    }

    update(dt) {
      this.time += dt;
      this.live.update(dt);
    }

    drawBack(ctx) {
      const t = this.time;
      ctx.clearRect(0, 0, this.W, this.H);
      for (const s of this.stars) {
        const tw = 0.3 + 0.7 * Math.max(0, Math.sin(t * s.speed + s.phase));
        ctx.globalAlpha = tw;
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x, s.y, 1, 1);
      }
      ctx.globalAlpha = 1;
      this.live.drawShooting(ctx);
      for (const m of this.moons) drawGlow(ctx, m.x, m.y, m.r * 2.4, '#b7a6ff', 0.08 + 0.03 * Math.sin(t * 0.5));
      this.live.drawBats(ctx);
      for (const l of this.lights) {
        const f = 0.75 + 0.25 * Math.sin(t * 6 + l.seed) * Math.sin(t * 2.3 + l.seed);
        drawGlow(ctx, l.x, l.y, l.size * 2.2, '#ffb860', 0.26 * f);
      }
      this.live.drawFog(ctx, this.layout.groundTop - 14, 0.28, 5);
      this.live.drawWisps(ctx);
    }

    drawFront(ctx) {
      this.live.drawFront(ctx);
    }
  }

  Luna.ImageBackground = ImageBackground;
  Luna.coverFit = coverFit;
})(window.Luna);
