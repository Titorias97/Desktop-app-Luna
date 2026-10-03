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
     * @param {object} opts  { detail: 'hd'|'pixel', bgCanvas, physScale }
     */
    constructor(img, meta, W, H, opts) {
      this.img = img;
      this.meta = meta;
      this.W = W;
      this.H = H;
      this.opts = opts;
      this.time = 0;
      this.fit = coverFit(img.width, img.height, W, H);
      const L = meta.layout;
      const fy = (f) => Math.round(this.fit.y + f * this.fit.h);
      const fx = (f) => Math.round(this.fit.x + f * this.fit.w);
      this.layout = {
        horizon: fy(L.horizon),
        groundTop: fy(L.groundTop),
        groundBottom: Math.min(H - opts.inset - 4, fy(L.groundBottom)),
      };
      this.benchSpot = meta.bench ? { x: fx(meta.bench.x), y: fy(meta.bench.y) } : { x: Math.round(W * 0.3), y: this.layout.groundTop + 16 };
      this.moon = meta.moon
        ? { x: fx(meta.moon.x), y: fy(meta.moon.y), r: Math.max(8, Math.round(meta.moon.r * this.fit.w)), lit: 1 }
        : { x: Math.round(W * 0.8), y: Math.round(this.layout.horizon * 0.3), r: 18, lit: 1 };
      this.stars = (meta.stars || []).map(([x, y], i) => ({ x: fx(x), y: fy(y), phase: (i * 0.73) % 6.28, speed: 0.8 + ((i * 7) % 10) / 8, color: ['#ffffff', '#fff4d6', '#d8e4ff'][i % 3], big: false }));
      this.lights = (meta.lights || []).map(([x, y, size], i) => ({ x: fx(x), y: fy(y), size: Math.max(6, Math.round(size * this.fit.w)), seed: i * 1.37 }));
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
        g.drawImage(img, this.fit.x, this.fit.y, this.fit.w, this.fit.h);
        this.pixelLayer = c;
      }
      this.drawHd();
    }

    /** Paints the picture on the full-resolution canvas behind the scene. */
    drawHd() {
      const c = this.opts.bgCanvas;
      if (!c) return;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.fillStyle = '#06040d';
      g.fillRect(0, 0, c.width, c.height);
      if (this.pixelLayer) {
        g.imageSmoothingEnabled = false;
        g.drawImage(this.pixelLayer, 0, 0, c.width, c.height);
        return;
      }
      const k = c.width / this.W;
      g.drawImage(this.img, this.fit.x * k, this.fit.y * k, this.fit.w * k, this.fit.h * k);
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
      drawGlow(ctx, this.moon.x, this.moon.y, this.moon.r * 2.4, '#b7a6ff', 0.08 + 0.03 * Math.sin(t * 0.5));
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
