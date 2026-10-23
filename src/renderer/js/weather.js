/* Weather: now and then rain or snow rolls in, lasts a few minutes and clears.
 * Rain draws slanted streaks with splashes and darkens the scene; snow drifts
 * down and slowly dusts the scenery (tops of roofs, branches, fence spikes and
 * gravestones, plus patches on the ground), then melts away after it stops.
 * The snow cover is worked out once per world from a snapshot of the
 * background, at the logical pixel size, so it looks like part of the art. */
(function (Luna) {
  'use strict';
  const { clamp, rnd, approach, makeRng } = Luna.util;

  const FADE = 1 / 20;        // intensity change per second (20 s to roll in or out)
  const SNOW_GROW = 1 / 70;   // cover per second at full snowfall
  const SNOW_MELT = 1 / 150;  // cover lost per second once it has stopped
  const TIERS = 3;            // the cover spreads in steps: caps and thick patches first

  class Weather {
    /** @param {object} w the world (W, H, layout, bg, settings.seed, settings.weather) */
    constructor(w) {
      this.w = w;
      this.rng = makeRng(((w.settings.seed || 20241031) ^ 0x5eed) >>> 0);
      this.mode = 'clear';     // what is falling (or fading out)
      this.target = 0;         // intensity we are heading to
      this.intensity = 0;      // 0..1, how hard it is falling
      this.cover = 0;          // 0..1, how much snow lies on the scenery
      this.timer = rnd(this.rng, 180, 480); // first change comes after a while
      this.drops = [];
      this.splashes = [];
      this.flakes = [];
      const area = w.W * w.H;
      this.maxDrops = Math.round(area / 420);
      this.maxFlakes = Math.round(area / 520);
      this.layers = this.buildCover();
      this.setMode(w.settings.weather || 'auto');
    }

    /** 'auto' (random), or force 'clear' / 'rain' / 'snow'. */
    setMode(mode) {
      this.forced = mode === 'auto' ? null : mode;
      if (this.forced) this.begin(this.forced);
    }

    begin(kind) {
      if (kind === 'clear') { this.target = 0; return; }
      // Switching straight from one to the other: stop the old one quickly.
      if (this.mode !== kind && this.intensity > 0) { this.drops.length = 0; this.flakes.length = 0; this.intensity = 0; }
      this.mode = kind;
      this.target = kind === 'rain' ? rnd(this.rng, 0.6, 1) : rnd(this.rng, 0.55, 1);
    }

    get raining() { return this.mode === 'rain' && this.intensity > 0.05; }
    get snowing() { return this.mode === 'snow' && this.intensity > 0.05; }

    // -----------------------------------------------------------------------
    /** Snow cover layers, one canvas per tier, from a snapshot of the background. */
    buildCover() {
      const { W, H, layout, bg } = this.w;
      const snap = document.createElement('canvas');
      snap.width = W; snap.height = H;
      const sg = snap.getContext('2d');
      if (bg.drawSnapshot) bg.drawSnapshot(sg); else bg.drawBack(sg);
      const src = sg.getImageData(0, 0, W, H).data;
      const lum = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) lum[i] = src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11;
      // Blocky value noise, so the cover forms clumps instead of a veil.
      const rng = makeRng(0xc0ffee);
      const grid = (step, stepY = step) => {
        const gw = Math.ceil(W / step) + 2;
        const gh = Math.ceil(H / stepY) + 2;
        const v = new Float32Array(gw * gh).map(() => rng());
        return (x, y) => {
          const fx = x / step, fy = y / stepY, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
          const a = v[y0 * gw + x0], b = v[y0 * gw + x0 + 1], c = v[(y0 + 1) * gw + x0], d = v[(y0 + 1) * gw + x0 + 1];
          return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        };
      };
      const coarse = grid(9);
      const fine = grid(3);
      // Ground clumps lie flat: wide and short, from two octaves.
      const flatA = grid(10, 4);
      const flatB = grid(4, 2);
      const clump = (x, y) => flatA(x, y) * 0.65 + flatB(x, y) * 0.35;
      const depthOf = (y) => clamp((y - layout.groundTop) / Math.max(1, H - layout.groundTop), 0, 1);
      const threshold = (y) => 0.67 - 0.07 * depthOf(y); // a little more snow nearer the viewer
      const inClump = (x, y) => y >= layout.groundTop && y < H && clump(x, y) > threshold(y);
      const noAt = (bg.moons || [bg.moon]).filter(Boolean); // never put snow on the moon
      const skyTop = Math.round(layout.horizon * 0.15);
      const layers = [];
      const data = [];
      for (let t = 0; t < TIERS; t++) {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        layers.push(c);
        data.push(c.getContext('2d').createImageData(W, H));
      }
      const LIT = [236, 241, 255];   // top of a clump, catching the moonlight
      const SNOW = [208, 216, 246];
      const SHADE = [158, 168, 214]; // underside
      const put = (x, y, a, tier, rgb = SNOW) => {
        const d = data[clamp(tier, 0, TIERS - 1)].data;
        const o = (y * W + x) * 4;
        const v = Math.round(a * 255);
        if (v <= d[o + 3]) return;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = v;
      };
      for (let y = Math.max(1, skyTop); y < H; y++) {
        const ground = y >= layout.groundTop - 2;
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const n = coarse(x, y) * 0.7 + fine(x, y) * 0.3;
          const tier = Math.floor((1 - n) * TIERS); // high noise: covered first
          // Caps: the top edge of something dark against a lighter background
          // (roofs, branches, fence spikes); on the ground any strong horizontal edge.
          const above = lum[i - W];
          const drop = above - lum[i];
          const edge = ground ? Math.abs(drop) > 26 : drop > 14 && lum[i] < 70;
          if (edge && !noAt.some((m) => Math.hypot(x - m.x, y - m.y) < m.r * 1.6)) {
            const run = Math.abs(lum[i - W - 1] - lum[i - 1]) > 10 || Math.abs(lum[i - W + 1] - lum[i + 1]) > 10; // not a lone star
            if (run) {
              put(x, y, 0.85, tier - 1, LIT);
              if (y + 1 < H && !ground) put(x, y + 1, 0.35, tier);
            }
          }
          // Ground: crisp, shaded clumps of snow with a dithered rim.
          if (ground) {
            const c = clump(x, y);
            const thr = threshold(y);
            const ctier = c > thr + 0.1 ? 0 : c > thr + 0.04 ? 1 : 2; // the biggest clumps form first
            if (inClump(x, y)) {
              if (!inClump(x, y - 1)) put(x, y, 0.92, ctier, LIT);
              else if (!inClump(x, y + 1)) put(x, y, 0.62, ctier, SHADE);
              else put(x, y, 0.72, ctier, SNOW);
            } else if (c > thr - 0.035 && (x + y) % 2 === 0) put(x, y, 0.45, 2, SNOW);
          }
        }
      }
      layers.forEach((c, t) => c.getContext('2d').putImageData(data[t], 0, 0));
      return layers;
    }

    // -----------------------------------------------------------------------
    update(dt) {
      const { rng } = this;
      if (!this.forced) {
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.target > 0) { this.target = 0; this.timer = rnd(rng, 240, 600); }                    // clear spell
          else { this.begin(rng() < 0.55 ? 'rain' : 'snow'); this.timer = rnd(rng, 150, 360); }  // a shower
        }
      }
      this.intensity = approach(this.intensity, this.target, FADE * dt);
      if (this.mode === 'snow' && this.intensity > 0.3) this.cover = Math.min(1, this.cover + SNOW_GROW * this.intensity * dt);
      else this.cover = Math.max(0, this.cover - (this.raining ? SNOW_MELT * 3 : SNOW_MELT) * dt); // rain washes it off faster

      const { W, H } = this.w;
      if (this.mode === 'rain') {
        const want = Math.round(this.maxDrops * this.intensity);
        while (this.drops.length < want) this.drops.push(this.newDrop(true));
        if (this.drops.length > want) this.drops.length = want;
        for (const d of this.drops) {
          d.x += d.vx * dt;
          d.y += d.vy * dt;
          if (d.y >= d.land) {
            if (d.land < H) this.splashes.push({ x: Math.round(d.x), y: Math.round(d.land), t: 0 });
            Object.assign(d, this.newDrop(false));
          }
        }
      }
      for (const s of this.splashes) s.t += dt;
      this.splashes = this.splashes.filter((s) => s.t < 0.18);

      if (this.mode === 'snow') {
        const want = Math.round(this.maxFlakes * this.intensity);
        while (this.flakes.length < want) this.flakes.push(this.newFlake(true));
        if (this.flakes.length > want) this.flakes.length = want;
        for (const f of this.flakes) {
          f.phase += dt * f.sway;
          f.x += (Math.sin(f.phase) * 6 + 3) * dt;
          f.y += f.vy * dt;
          if (f.y > f.land) Object.assign(f, this.newFlake(false));
          if (f.x > W + 4) f.x -= W + 8;
        }
      }
      // Stop drawing particles once the weather has fully faded out.
      if (this.intensity === 0) { this.drops.length = 0; this.flakes.length = 0; }
    }

    newDrop(anywhere) {
      const { W, H, layout } = this.w;
      const { rng } = this;
      const vy = rnd(rng, 230, 320);
      const land = rng() < 0.75 ? rnd(rng, layout.groundTop, H) : H + 20; // most hit the ground, some fall past
      return { x: rnd(rng, -40, W), y: anywhere ? rnd(rng, -20, land) : rnd(rng, -30, -4), vx: vy * 0.18, vy, len: Math.round(rnd(rng, 4, 8)), land };
    }

    newFlake(anywhere) {
      const { W, H, layout } = this.w;
      const { rng } = this;
      const land = rnd(rng, layout.groundTop, H + 4);
      return { x: rnd(rng, -10, W), y: anywhere ? rnd(rng, -10, land) : rnd(rng, -12, -2), vy: rnd(rng, 9, 22), phase: rnd(rng, 0, 6.3), sway: rnd(rng, 0.8, 2), big: rng() < 0.22, land, a: rnd(rng, 0.6, 1) };
    }

    // -----------------------------------------------------------------------
    /** On the background, under the characters. */
    drawCover(ctx) {
      if (this.cover <= 0) return;
      const k = this.cover * TIERS;
      for (let t = 0; t < TIERS; t++) {
        const a = clamp(k - t, 0, 1);
        if (a <= 0) break;
        ctx.globalAlpha = a;
        ctx.drawImage(this.layers[t], 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    /** In front of everything (before the vignette). */
    drawFront(ctx) {
      const { W, H } = this.w;
      if (this.mode === 'rain' && this.intensity > 0) {
        ctx.fillStyle = `rgba(14,16,40,${0.22 * this.intensity})`; // overcast
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(176,188,255,0.55)';
        for (const d of this.drops) {
          // a slanted streak, one pixel per step
          const x = Math.round(d.x);
          const y = Math.round(d.y);
          for (let i = 0; i < d.len; i++) ctx.fillRect(x - Math.round(i * 0.18), y - i, 1, 1);
        }
        ctx.fillStyle = 'rgba(200,210,255,0.6)';
        for (const s of this.splashes) {
          const r = s.t < 0.09 ? 1 : 2;
          ctx.fillRect(s.x - r, s.y - 1, 1, 1);
          ctx.fillRect(s.x + r, s.y - 1, 1, 1);
          if (r === 1) ctx.fillRect(s.x, s.y - 2, 1, 1);
        }
      }
      if (this.mode === 'snow' && this.intensity > 0) {
        ctx.fillStyle = `rgba(150,160,210,${0.06 * this.intensity})`; // snowy haze
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#eef2ff';
        for (const f of this.flakes) {
          ctx.globalAlpha = f.a;
          const x = Math.round(f.x);
          const y = Math.round(f.y);
          if (f.big) { ctx.fillRect(x, y - 1, 1, 3); ctx.fillRect(x - 1, y, 3, 1); } else ctx.fillRect(x, y, 1, 1);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  Luna.Weather = Weather;
})(window.Luna);
