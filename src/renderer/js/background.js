/* Procedural gothic graveyard background, rendered at the logical pixel
 * resolution and cached in offscreen canvases. Props (tombstones, trees,
 * bench, lamp) are exposed so the scene can y-sort them with the characters. */
(function (Luna) {
  'use strict';
  const { clamp, rnd, rndInt, pick, chance, rgba } = Luna.util;
  const { drawGlow, fillEllipse, drawIcon } = Luna.sprites;

  const SKY_BANDS = ['#06040d', '#0b0719', '#120b26', '#1a1035', '#241646', '#2e1c54', '#3a2460', '#472c68'];

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /** Real lunar phase, 0 = new, 0.5 = full. */
  function moonPhase(date = new Date()) {
    const synodic = 29.530588853;
    const known = Date.UTC(2000, 0, 6, 18, 14); // a new moon
    const days = (date.getTime() - known) / 86400000;
    return ((days % synodic) + synodic) % synodic / synodic;
  }

  class Background {
    constructor(W, H, layout, seed = 20241031) {
      this.W = W;
      this.H = H;
      this.layout = layout;
      this.rng = Luna.util.makeRng(seed);
      this.time = 0;
      this.props = [];
      this.build();
    }

    // -----------------------------------------------------------------------
    build() {
      const { W, H, rng } = this;
      const { horizon, groundTop } = this.layout;
      this.sky = makeCanvas(W, H);
      this.ground = makeCanvas(W, H);
      this.buildSky();
      this.buildMoon();
      this.buildFarSilhouette();
      this.buildGround();
      this.buildFence();
      this.buildFog();
      this.buildProps();

      // Stars
      this.stars = [];
      const count = Math.round((W * horizon) / 700);
      for (let i = 0; i < count; i++) {
        this.stars.push({
          x: rndInt(rng, 0, W - 1),
          y: rndInt(rng, 0, horizon - 12),
          phase: rnd(rng, 0, Math.PI * 2),
          speed: rnd(rng, 0.6, 2.2),
          color: pick(rng, ['#ffffff', '#fff4d6', '#d8e4ff', '#f6d9ff']),
          big: chance(rng, 0.06),
        });
      }
      // Clouds (slow parallax)
      this.clouds = [];
      for (let i = 0; i < 5; i++) {
        const w = rndInt(rng, 50, 120);
        const c = this.makeCloud(w, rndInt(rng, 12, 20));
        this.clouds.push({ canvas: c, x: rnd(rng, -w, W), y: rndInt(rng, 6, Math.round(horizon * 0.55)), speed: rnd(rng, 1.5, 4) * (chance(rng, 0.5) ? 1 : -1) * 0.5, alpha: rnd(rng, 0.5, 0.85) });
      }
      // Will-o'-wisps
      this.wisps = [];
      for (let i = 0; i < 7; i++) {
        this.wisps.push({
          x: rnd(rng, 10, W - 10), y: rnd(rng, groundTop, this.layout.groundBottom),
          seed: rnd(rng, 0, 100), color: pick(rng, ['#9ffcf0', '#b8ffb0', '#d6c2ff']),
        });
      }
      this.bats = [];
      this.nextBats = rnd(rng, 6, 20);
      this.shooting = null;
      this.nextShooting = rnd(rng, 20, 60);
    }

    buildSky() {
      const { W, H } = this;
      const { horizon } = this.layout;
      const g = this.sky.getContext('2d');
      const bandH = horizon / (SKY_BANDS.length - 1);
      for (let y = 0; y < H; y++) {
        const f = clamp(y / bandH, 0, SKY_BANDS.length - 1);
        let i = Math.floor(f);
        const frac = f - i;
        for (let x = 0; x < W; x++) {
          // 2x2 ordered dither between neighbouring bands for a chunky gradient.
          const dither = ((x & 1) ^ (y & 1)) ? 0.25 : 0.75;
          const idx = frac > dither ? Math.min(i + 1, SKY_BANDS.length - 1) : i;
          g.fillStyle = SKY_BANDS[idx];
          g.fillRect(x, y, 1, 1);
        }
      }
      // Horizon haze
      for (let y = horizon - 18; y < horizon; y++) {
        const a = (y - (horizon - 18)) / 18;
        g.fillStyle = rgba('#5d3a7a', a * 0.5);
        g.fillRect(0, y, W, 1);
      }
    }

    buildMoon() {
      const { W } = this;
      const r = Math.round(clamp(this.layout.horizon * 0.11, 12, 26));
      const phase = moonPhase();
      this.moon = { x: Math.round(W * 0.8), y: Math.round(this.layout.horizon * 0.3), r, phase, lit: (1 - Math.cos(phase * Math.PI * 2)) / 2 };
      const c = makeCanvas(r * 2 + 2, r * 2 + 2);
      const g = c.getContext('2d');
      const cx = r + 1;
      const cy = r + 1;
      const theta = phase * Math.PI * 2;
      // Lit part
      g.fillStyle = '#f4edd3';
      for (let y = -r; y <= r; y++) {
        const w = Math.sqrt(r * r - y * y);
        let x0, x1;
        if (phase < 0.5) { x0 = w * Math.cos(theta); x1 = w; } else { x0 = -w; x1 = -w * Math.cos(theta); }
        if (x1 - x0 < 0.5) continue;
        g.fillRect(Math.round(cx + x0), cy + y, Math.max(1, Math.round(x1 - x0)), 1);
      }
      // Craters only where it is lit
      g.globalCompositeOperation = 'source-atop';
      const craters = [[-0.35, -0.2, 0.22], [0.3, 0.15, 0.17], [-0.05, 0.45, 0.13], [0.45, -0.45, 0.1], [-0.5, 0.3, 0.09]];
      for (const [ox, oy, rr] of craters) {
        fillEllipse(g, cx + ox * r, cy + oy * r, Math.max(1, rr * r), Math.max(1, rr * r * 0.85), '#d9cfa9');
        fillEllipse(g, cx + ox * r + 1, cy + oy * r, Math.max(1, rr * r * 0.6), Math.max(1, rr * r * 0.5), '#e8dfbf');
      }
      // Earthshine disk behind
      g.globalCompositeOperation = 'destination-over';
      fillEllipse(g, cx, cy, r, r, '#2a2342');
      this.moon.canvas = c;
    }

    makeCloud(w, h) {
      const rng = this.rng;
      const c = makeCanvas(w, h + 4);
      const g = c.getContext('2d');
      const blobs = rndInt(rng, 5, 9);
      for (let i = 0; i < blobs; i++) {
        const bx = rnd(rng, h / 2, w - h / 2);
        const by = rnd(rng, h * 0.45, h * 0.8);
        const rx = rnd(rng, h * 0.5, h * 0.9);
        const ry = rnd(rng, h * 0.3, h * 0.5);
        fillEllipse(g, bx, by + 2, rx, ry, '#1c1233');
        fillEllipse(g, bx, by, rx * 0.9, ry * 0.8, '#281a45');
      }
      return c;
    }

    buildFarSilhouette() {
      const { W, rng } = this;
      const { horizon, groundTop } = this.layout;
      const g = this.sky.getContext('2d');
      const dark = '#0d0916';
      // Rolling hills
      const hill = (x) => horizon - 6 + Math.sin(x / 61) * 5 + Math.sin(x / 23 + 1.3) * 3 + Math.cos(x / 140) * 7;
      g.fillStyle = dark;
      for (let x = 0; x < W; x++) {
        const top = Math.round(hill(x));
        g.fillRect(x, top, 1, groundTop - top + 2);
      }
      this.hill = hill;
      this.windows = [];
      // Gothic mansion on the left
      const mx = Math.round(W * 0.14);
      const mw = Math.round(clamp(W * 0.17, 70, 140));
      const base = Math.round(hill(mx + mw / 2)) + 2;
      const bodyH = Math.round(clamp(horizon * 0.22, 26, 60));
      g.fillRect(mx, base - bodyH, mw, bodyH); // main block
      // battlements
      for (let x = mx; x < mx + mw; x += 4) g.fillRect(x, base - bodyH - 3, 2, 3);
      // towers
      const towers = [[mx - 6, 12, bodyH + 22], [mx + mw - 8, 12, bodyH + 30], [mx + Math.round(mw * 0.45), 10, bodyH + 40]];
      for (const [tx, tw, th] of towers) {
        g.fillRect(tx, base - th, tw, th);
        // pointed roof
        for (let i = 0; i <= tw / 2 + 3; i++) g.fillRect(tx - 2 + i, base - th - (tw / 2 + 3) + i, tw + 4 - i * 2, 1);
        // window
        this.windows.push({ x: tx + Math.floor(tw / 2) - 1, y: base - th + 8, w: 2, h: 4, lit: chance(rng, 0.7), flicker: rnd(rng, 0, 10) });
        this.windows.push({ x: tx + Math.floor(tw / 2) - 1, y: base - Math.round(th * 0.55), w: 2, h: 4, lit: chance(rng, 0.5), flicker: rnd(rng, 0, 10) });
      }
      // Main block windows (arched)
      const cols = Math.floor(mw / 12);
      for (let i = 0; i < cols; i++) {
        const wx = mx + 6 + i * 12;
        for (let row = 0; row < 2; row++) {
          this.windows.push({ x: wx, y: base - bodyH + 8 + row * 12, w: 3, h: 5, lit: chance(rng, 0.45), flicker: rnd(rng, 0, 10), arched: true });
        }
      }
      // Big arched door glow
      this.windows.push({ x: mx + Math.round(mw / 2) - 2, y: base - 9, w: 4, h: 8, lit: true, flicker: 3, arched: true, door: true });

      // Chapel with spire on the right
      const cx = Math.round(W * 0.68);
      const cw = Math.round(clamp(W * 0.07, 28, 56));
      const cbase = Math.round(hill(cx + cw / 2)) + 2;
      const ch = Math.round(clamp(horizon * 0.14, 18, 40));
      g.fillRect(cx, cbase - ch, cw, ch);
      for (let i = 0; i <= cw / 2; i++) g.fillRect(cx + i, cbase - ch - (cw / 2) + i, cw - i * 2, 1); // gable
      const sx = cx + cw - 10;
      const sh = ch + 26;
      g.fillRect(sx, cbase - sh, 8, sh);
      for (let i = 0; i <= 10; i++) g.fillRect(sx + i * 0.4, cbase - sh - 14 + i * 1.4, 8 - i * 0.8, 2); // spire
      g.fillRect(sx + 3, cbase - sh - 20, 2, 7); // cross
      g.fillRect(sx + 1, cbase - sh - 18, 6, 2);
      this.windows.push({ x: cx + 5, y: cbase - ch + 7, w: 2, h: 6, lit: true, flicker: 1, arched: true });
      this.windows.push({ x: cx + cw - 16, y: cbase - ch + 7, w: 2, h: 6, lit: true, flicker: 5, arched: true });
      this.windows.push({ x: sx + 3, y: cbase - sh + 6, w: 2, h: 4, lit: chance(rng, 0.5), flicker: 7 });

      // Dead trees on the hills
      const treeCount = Math.round(W / 90);
      for (let i = 0; i < treeCount; i++) {
        const tx = rndInt(rng, 10, W - 10);
        if (Math.abs(tx - (mx + mw / 2)) < mw * 0.7 || Math.abs(tx - (cx + cw / 2)) < cw) continue;
        this.drawDeadTree(g, tx, Math.round(hill(tx)) + 2, rndInt(rng, 14, 30), dark, rng);
      }
      // Fog-coloured far meadow between the hills and the fence
      const far = g.createLinearGradient(0, horizon, 0, groundTop);
      far.addColorStop(0, '#120d20');
      far.addColorStop(1, '#19132a');
      g.fillStyle = far;
      g.fillRect(0, horizon + 8, W, groundTop - horizon - 8);
      for (let x = 0; x < W; x++) {
        const top = Math.round(hill(x));
        if (top < horizon + 8) { g.fillStyle = dark; g.fillRect(x, top, 1, horizon + 8 - top); }
      }
    }

    drawDeadTree(g, x, baseY, h, color, rng) {
      g.fillStyle = color;
      const branch = (bx, by, len, angle, width, depth) => {
        const ex = bx + Math.cos(angle) * len;
        const ey = by - Math.sin(angle) * len;
        this.line(g, bx, by, ex, ey, width, color);
        if (depth <= 0 || len < 3) return;
        const n = rndInt(rng, 1, 2);
        for (let i = 0; i < n; i++) {
          branch(ex, ey, len * rnd(rng, 0.55, 0.75), angle + rnd(rng, -0.9, 0.9), Math.max(1, width - 1), depth - 1);
        }
      };
      branch(x, baseY, h * 0.45, Math.PI / 2 + rnd(rng, -0.1, 0.1), 2, 4);
    }

    line(g, x0, y0, x1, y1, w, color) {
      g.fillStyle = color;
      const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        g.fillRect(Math.round(x0 + (x1 - x0) * t - w / 2), Math.round(y0 + (y1 - y0) * t), w, 1);
      }
    }

    buildGround() {
      const { W, H, rng } = this;
      const { groundTop } = this.layout;
      const g = this.ground.getContext('2d');
      // Base: dark mossy purple, slightly lighter towards the viewer.
      for (let y = groundTop; y < H; y++) {
        const t = (y - groundTop) / Math.max(1, H - groundTop);
        g.fillStyle = Luna.util.mix('#171226', '#211a33', t);
        g.fillRect(0, y, W, 1);
      }
      // Grass tufts and pebbles
      const specks = Math.round((W * (H - groundTop)) / 60);
      for (let i = 0; i < specks; i++) {
        const x = rndInt(rng, 0, W - 1);
        const y = rndInt(rng, groundTop + 2, H - 1);
        const kind = rng();
        if (kind < 0.55) { g.fillStyle = pick(rng, ['#263047', '#2b2a44', '#1f2a3a']); g.fillRect(x, y, 1, 1); g.fillRect(x + 1, y - 1, 1, 1); }
        else if (kind < 0.8) { g.fillStyle = '#2d2740'; g.fillRect(x, y, 2, 1); }
        else { g.fillStyle = '#120d1c'; g.fillRect(x, y, 1, 1); }
      }
      // Winding cobblestone path from the bottom to the gate.
      const gateX = Math.round(W * 0.5);
      const pathW = 22;
      for (let y = groundTop + 2; y < H; y++) {
        const t = (y - groundTop) / (H - groundTop);
        const cx = gateX + Math.sin(t * 2.2) * W * 0.06 + Math.sin(t * 7) * 4;
        const w = pathW * (0.6 + t * 0.6);
        for (let x = Math.round(cx - w / 2); x < cx + w / 2; x++) {
          const edge = Math.abs(x - cx) > w / 2 - 2;
          const cob = ((x >> 2) + (y >> 1)) % 2 === 0;
          g.fillStyle = edge ? '#1c1729' : cob ? '#2c2740' : '#262138';
          if (!edge || ((x + y) & 1)) g.fillRect(x, y, 1, 1);
        }
      }
    }

    buildFence() {
      const { W } = this;
      const { groundTop } = this.layout;
      const g = this.ground.getContext('2d');
      const y = groundTop;
      const gateX = Math.round(W * 0.5);
      const gateHalf = 14;
      const railColor = '#2b2340';
      const railHi = '#3d3358';
      for (let x = 0; x < W; x += 1) {
        if (Math.abs(x - gateX) < gateHalf) continue;
        // rails
        if ((x + 2) % 5 !== 0) { g.fillStyle = railColor; g.fillRect(x, y - 6, 1, 1); g.fillRect(x, y - 2, 1, 1); }
        // pickets
        if (x % 5 === 0) {
          g.fillStyle = railHi; g.fillRect(x, y - 9, 1, 10);
          g.fillStyle = railColor; g.fillRect(x, y - 10, 1, 1);
        }
      }
      // stone pillars every ~48px and at the gate
      const pillar = (px, tall) => {
        g.fillStyle = '#3a3250'; g.fillRect(px, y - tall, 4, tall + 1);
        g.fillStyle = '#4c4466'; g.fillRect(px, y - tall, 1, tall);
        g.fillStyle = '#2a2440'; g.fillRect(px + 3, y - tall, 1, tall + 1);
        g.fillStyle = '#56507a'; g.fillRect(px - 1, y - tall - 1, 6, 1);
        g.fillStyle = '#1c1629'; g.fillRect(px - 1, y + 1, 6, 1);
      };
      this.lanterns = [];
      for (let px = 20; px < W - 4; px += 48) {
        if (Math.abs(px - gateX) < gateHalf + 8) continue;
        pillar(px, 13);
      }
      pillar(gateX - gateHalf - 4, 18);
      pillar(gateX + gateHalf, 18);
      // gate arch
      g.fillStyle = railHi;
      for (let i = 0; i < gateHalf * 2 + 4; i++) {
        const t = (i / (gateHalf * 2 + 4)) * Math.PI;
        g.fillRect(gateX - gateHalf - 2 + i, y - 20 - Math.round(Math.sin(t) * 6), 1, 1);
      }
      // lanterns on gate pillars
      for (const lx of [gateX - gateHalf - 2, gateX + gateHalf + 2]) {
        g.fillStyle = '#1a1424'; g.fillRect(lx - 1, y - 24, 3, 5);
        g.fillStyle = '#ffd27a'; g.fillRect(lx, y - 23, 1, 3);
        this.lanterns.push({ x: lx, y: y - 22, seed: lx * 0.13 });
      }
    }

    buildFog() {
      const { W, rng } = this;
      const h = 40;
      const c = makeCanvas(W * 2, h);
      const g = c.getContext('2d');
      for (let i = 0; i < W / 6; i++) {
        const x = rnd(rng, 0, W * 2);
        const y = rnd(rng, h * 0.3, h * 0.8);
        fillEllipse(g, x, y, rnd(rng, 14, 40), rnd(rng, 4, 9), rgba('#b9a7d9', 0.08));
        fillEllipse(g, x, y + 2, rnd(rng, 8, 20), rnd(rng, 2, 5), rgba('#d6c8ef', 0.06));
      }
      this.fog = c;
    }

    // -----------------------------------------------------------------------
    // Props: pre-rendered canvases with a ground anchor so the scene can sort
    // them among the characters.
    buildProps() {
      const { W, rng } = this;
      const { groundTop, groundBottom } = this.layout;
      const gateX = Math.round(W * 0.5);
      const used = [];
      const free = (x, y, r) => used.every((u) => Math.hypot(u.x - x, u.y - y) > r + u.r);
      const place = (x, y, r) => { used.push({ x, y, r }); };

      // Stone bench for sitting (the girl's favourite spot).
      const benchX = Math.round(W * 0.3);
      const benchY = groundTop + 16;
      this.props.push(this.makeProp(benchX, benchY, this.drawBench(), 24, 'bench'));
      this.benchSpot = { x: benchX, y: benchY };
      place(benchX, benchY, 20);
      // Lamp post with a warm glow
      const lampX = Math.round(W * 0.6);
      const lampY = groundTop + 10;
      this.props.push(this.makeProp(lampX, lampY, this.drawLamp(), 4, 'lamp'));
      this.lanterns.push({ x: lampX, y: lampY - 26, seed: 4.2, big: true });
      place(lampX, lampY, 10);
      // Big dead trees near the edges
      for (const tx of [Math.round(W * 0.06), Math.round(W * 0.93)]) {
        const ty = groundTop + rndInt(rng, 4, 10);
        this.props.push(this.makeProp(tx, ty, this.drawBigTree(rndInt(rng, 44, 60), rng), 6, 'tree'));
        place(tx, ty, 16);
      }
      // Tombstones
      const count = Math.round(W / 70);
      for (let i = 0; i < count * 4 && used.length < count + 4; i++) {
        const x = rndInt(rng, 12, W - 12);
        const y = rndInt(rng, groundTop + 6, groundBottom - 6);
        if (Math.abs(x - gateX) < 26 && y < groundTop + 40) continue; // keep the path clear
        if (!free(x, y, 14)) continue;
        place(x, y, 10);
        this.props.push(this.makeProp(x, y, this.drawTombstone(pick(rng, ['round', 'cross', 'slab', 'tall']), rng), 8, 'tomb'));
      }
      // Candles & mushrooms
      for (let i = 0; i < Math.round(W / 120); i++) {
        const x = rndInt(rng, 8, W - 8);
        const y = rndInt(rng, groundTop + 4, groundBottom - 2);
        if (!free(x, y, 8)) continue;
        place(x, y, 3);
        if (chance(rng, 0.5)) {
          this.props.push(this.makeProp(x, y, this.drawCandle(), 2, 'candle'));
          this.lanterns.push({ x, y: y - 4, seed: x * 0.7, small: true });
        } else {
          this.props.push(this.makeProp(x, y, this.drawMushrooms(rng), 3, 'mushroom'));
        }
      }
    }

    makeProp(x, y, canvas, halfW, kind) {
      return { x, y, canvas, halfW, kind, draw(ctx) { ctx.drawImage(canvas, Math.round(x - canvas.width / 2), Math.round(y - canvas.height)); } };
    }

    drawTombstone(kind, rng) {
      const c = makeCanvas(16, 20);
      const g = c.getContext('2d');
      const stone = '#4b455e', hi = '#5f5976', sh = '#2c2740', out = '#1a1526';
      const lean = pick(rng, [0, 0, 1, -1]);
      if (kind === 'round') {
        for (let y = 0; y < 14; y++) {
          const w = y < 4 ? 6 + y * 2 : 12;
          const x0 = 8 - w / 2 + Math.round((lean * y) / 10);
          g.fillStyle = out; g.fillRect(x0 - 1, y + 4, w + 2, 1);
          g.fillStyle = stone; g.fillRect(x0, y + 4, w, 1);
          g.fillStyle = hi; g.fillRect(x0, y + 4, 1, 1);
          g.fillStyle = sh; g.fillRect(x0 + w - 1, y + 4, 1, 1);
        }
        g.fillStyle = out; g.fillRect(2, 18, 12, 1);
        g.fillStyle = '#3a3450'; g.fillRect(5, 9, 6, 1); g.fillRect(5, 11, 6, 1); g.fillRect(6, 13, 4, 1);
      } else if (kind === 'cross') {
        g.fillStyle = out; g.fillRect(6, 2, 4, 17); g.fillRect(2, 6, 12, 4);
        g.fillStyle = stone; g.fillRect(7, 3, 2, 15); g.fillRect(3, 7, 10, 2);
        g.fillStyle = hi; g.fillRect(7, 3, 1, 15); g.fillRect(3, 7, 10, 1);
        g.fillStyle = sh; g.fillRect(4, 18, 8, 1);
      } else if (kind === 'slab') {
        g.fillStyle = out; g.fillRect(1, 13, 14, 6);
        g.fillStyle = stone; g.fillRect(2, 14, 12, 4);
        g.fillStyle = hi; g.fillRect(2, 14, 12, 1);
        g.fillStyle = '#3a3450'; g.fillRect(4, 16, 8, 1);
      } else {
        for (let y = 0; y < 17; y++) {
          const w = y < 3 ? 4 + y * 2 : 8;
          const x0 = 8 - w / 2 + Math.round((lean * y) / 12);
          g.fillStyle = out; g.fillRect(x0 - 1, y + 1, w + 2, 1);
          g.fillStyle = stone; g.fillRect(x0, y + 1, w, 1);
          g.fillStyle = hi; g.fillRect(x0, y + 1, 1, 1);
          g.fillStyle = sh; g.fillRect(x0 + w - 1, y + 1, 1, 1);
        }
        g.fillStyle = out; g.fillRect(3, 18, 10, 1);
        g.fillStyle = '#3a3450'; g.fillRect(6, 6, 4, 1); g.fillRect(6, 8, 4, 1);
      }
      // moss
      if (chance(rng, 0.6)) { g.fillStyle = '#2f4a3e'; g.fillRect(rndInt(rng, 3, 10), 17, rndInt(rng, 2, 4), 1); }
      return c;
    }

    drawBench() {
      const c = makeCanvas(48, 18);
      const g = c.getContext('2d');
      const stone = '#4b455e', hi = '#5f5976', out = '#1a1526', sh = '#2c2740';
      g.fillStyle = out; g.fillRect(3, 8, 42, 5); g.fillRect(6, 12, 5, 6); g.fillRect(37, 12, 5, 6);
      g.fillStyle = stone; g.fillRect(4, 9, 40, 3); g.fillRect(7, 13, 3, 4); g.fillRect(38, 13, 3, 4);
      g.fillStyle = hi; g.fillRect(4, 9, 40, 1);
      g.fillStyle = sh; g.fillRect(4, 11, 40, 1);
      g.fillStyle = '#2f4a3e'; g.fillRect(12, 11, 3, 1); g.fillRect(30, 11, 2, 1);
      return c;
    }

    drawLamp() {
      const c = makeCanvas(12, 34);
      const g = c.getContext('2d');
      g.fillStyle = '#1a1424';
      g.fillRect(5, 6, 2, 27); // post
      g.fillRect(3, 31, 6, 3); // base
      g.fillRect(2, 2, 8, 2); // lantern top
      g.fillRect(3, 4, 6, 6); // lantern body
      g.fillRect(4, 0, 4, 2); // cap
      g.fillStyle = '#ffd27a'; g.fillRect(4, 5, 4, 4);
      g.fillStyle = '#fff1c0'; g.fillRect(5, 6, 2, 2);
      g.fillStyle = '#2a2440'; g.fillRect(5, 10, 2, 1);
      return c;
    }

    drawBigTree(h, rng) {
      const c = makeCanvas(56, h + 2);
      const g = c.getContext('2d');
      const color = '#1b1327';
      const hi = '#2c2140';
      const branch = (bx, by, len, angle, width, depth) => {
        const ex = bx + Math.cos(angle) * len;
        const ey = by - Math.sin(angle) * len;
        this.line(g, bx, by, ex, ey, width, color);
        if (width >= 3) this.line(g, bx - 1, by, ex - 1, ey, 1, hi);
        if (depth <= 0 || len < 3) return;
        const n = rndInt(rng, 1, 3);
        for (let i = 0; i < n; i++) branch(ex, ey, len * rnd(rng, 0.5, 0.75), angle + rnd(rng, -1.0, 1.0), Math.max(1, width - 1), depth - 1);
      };
      branch(28, h + 1, h * 0.42, Math.PI / 2 + rnd(rng, -0.15, 0.15), 4, 5);
      g.fillStyle = color; g.fillRect(22, h - 1, 12, 3); // roots
      return c;
    }

    drawCandle() {
      const c = makeCanvas(5, 7);
      const g = c.getContext('2d');
      g.fillStyle = '#e9e2f0'; g.fillRect(1, 3, 3, 4);
      g.fillStyle = '#b8aec6'; g.fillRect(3, 3, 1, 4);
      g.fillStyle = '#ffd27a'; g.fillRect(2, 1, 1, 2);
      g.fillStyle = '#fff6d8'; g.fillRect(2, 0, 1, 1);
      return c;
    }

    drawMushrooms(rng) {
      const c = makeCanvas(9, 6);
      const g = c.getContext('2d');
      const n = rndInt(rng, 1, 3);
      for (let i = 0; i < n; i++) {
        const x = 1 + i * 3;
        g.fillStyle = '#cfc4e4'; g.fillRect(x + 1, 3, 1, 3);
        g.fillStyle = '#7a4bd6'; g.fillRect(x, 1, 3, 2);
        g.fillStyle = '#b98cff'; g.fillRect(x + 1, 1, 1, 1);
      }
      return c;
    }

    // -----------------------------------------------------------------------
    update(dt) {
      this.time += dt;
      const { W, rng } = this;
      const { horizon } = this.layout;
      for (const c of this.clouds) {
        c.x += c.speed * dt;
        if (c.speed > 0 && c.x > W) c.x = -c.canvas.width;
        if (c.speed < 0 && c.x < -c.canvas.width) c.x = W;
      }
      // Windows change now and then (someone walks past a candle...)
      if (chance(rng, dt * 0.08)) {
        const w = pick(rng, this.windows);
        if (!w.door) w.lit = !w.lit;
      }
      // Bats
      this.nextBats -= dt;
      if (this.nextBats <= 0) {
        this.nextBats = rnd(rng, 25, 70);
        const dir = chance(rng, 0.5) ? 1 : -1;
        const n = rndInt(rng, 2, 5);
        const y = rnd(rng, horizon * 0.15, horizon * 0.6);
        for (let i = 0; i < n; i++) {
          this.bats.push({ x: dir > 0 ? -20 - i * 14 : W + 20 + i * 14, y: y + rnd(rng, -8, 8), vx: dir * rnd(rng, 34, 50), phase: rnd(rng, 0, 6), amp: rnd(rng, 2, 6) });
        }
      }
      for (const b of this.bats) b.x += b.vx * dt;
      this.bats = this.bats.filter((b) => b.x > -40 && b.x < W + 40);
      // Shooting star
      if (this.shooting) {
        this.shooting.t += dt;
        if (this.shooting.t > this.shooting.life) this.shooting = null;
      } else {
        this.nextShooting -= dt;
        if (this.nextShooting <= 0) {
          this.nextShooting = rnd(rng, 30, 90);
          this.shooting = { x: rnd(rng, W * 0.1, W * 0.9), y: rnd(rng, 4, horizon * 0.4), vx: rnd(rng, 90, 160) * (chance(rng, 0.5) ? 1 : -1), vy: rnd(rng, 30, 60), t: 0, life: 0.7 };
        }
      }
    }

    /** Everything behind the characters. */
    drawBack(ctx) {
      const t = this.time;
      const { W, H } = this;
      const { horizon, groundTop } = this.layout;
      ctx.drawImage(this.sky, 0, 0);
      // Stars
      for (const s of this.stars) {
        const tw = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
        ctx.globalAlpha = tw;
        ctx.fillStyle = s.color;
        if (s.big) { ctx.fillRect(s.x - 1, s.y, 3, 1); ctx.fillRect(s.x, s.y - 1, 1, 3); }
        else ctx.fillRect(s.x, s.y, 1, 1);
      }
      ctx.globalAlpha = 1;
      if (this.shooting) {
        const s = this.shooting;
        const k = s.t / s.life;
        const x = s.x + s.vx * s.t;
        const y = s.y + s.vy * s.t;
        ctx.globalAlpha = 1 - k;
        for (let i = 0; i < 10; i++) {
          ctx.fillStyle = i < 2 ? '#ffffff' : '#c9c3ff';
          ctx.fillRect(Math.round(x - (s.vx / 50) * i), Math.round(y - (s.vy / 50) * i), 1, 1);
        }
        ctx.globalAlpha = 1;
      }
      // Moon with glow
      const m = this.moon;
      drawGlow(ctx, m.x, m.y, m.r * 3, '#b7a6ff', 0.07 + m.lit * 0.12);
      ctx.drawImage(m.canvas, m.x - m.r - 1, m.y - m.r - 1);
      // Clouds
      for (const c of this.clouds) {
        ctx.globalAlpha = c.alpha;
        ctx.drawImage(c.canvas, Math.round(c.x), c.y);
      }
      ctx.globalAlpha = 1;
      // Bats
      for (const b of this.bats) {
        const flap = Math.floor((t * 9 + b.phase) % 2) === 0;
        drawIcon(ctx, flap ? 'batA' : 'batB', b.x, b.y + Math.sin(t * 3 + b.phase) * b.amp);
      }
      // Lit windows
      for (const w of this.windows) {
        if (!w.lit) continue;
        const f = 0.75 + 0.25 * Math.sin(t * 7 + w.flicker) * Math.sin(t * 3.1 + w.flicker * 2);
        ctx.fillStyle = w.door ? '#ffb15e' : '#ffd27a';
        ctx.globalAlpha = f;
        ctx.fillRect(w.x, w.y, w.w, w.h);
        if (w.arched) ctx.fillRect(w.x + 1, w.y - 1, w.w - 2, 1);
        ctx.globalAlpha = 1;
        if (w.door) drawGlow(ctx, w.x + w.w / 2, w.y + w.h, 14, '#ffb15e', 0.25 * f);
      }
      // Ground + fence + path
      ctx.drawImage(this.ground, 0, 0);
      // Far fog drifting just behind the fence line
      this.drawFog(ctx, groundTop - 14, 0.32, 5);
      // Lantern glows
      for (const l of this.lanterns) {
        const f = 0.8 + 0.2 * Math.sin(t * 6 + l.seed) * Math.sin(t * 2.3 + l.seed);
        drawGlow(ctx, l.x, l.y, l.big ? 34 : l.small ? 9 : 18, '#ffb860', (l.small ? 0.22 : 0.3) * f);
      }
      // Will-o'-wisps
      for (const w of this.wisps) {
        const x = w.x + Math.sin(t * 0.4 + w.seed) * 24 + Math.sin(t * 1.3 + w.seed * 2) * 6;
        const y = w.y + Math.sin(t * 0.7 + w.seed * 3) * 10;
        const blink = 0.4 + 0.6 * Math.max(0, Math.sin(t * 1.7 + w.seed * 5));
        drawGlow(ctx, x, y, 8, w.color, 0.35 * blink);
        ctx.globalAlpha = blink;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        ctx.globalAlpha = 1;
      }
    }

    /** Everything in front of the characters. */
    drawFront(ctx) {
      const { H } = this;
      this.drawFog(ctx, H - 26, 0.22, -3);
    }

    drawFog(ctx, y, alpha, speed) {
      const { W } = this;
      const off = ((this.time * speed) % W + W) % W;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.fog, Math.round(-off), y);
      ctx.drawImage(this.fog, Math.round(-off + this.fog.width), y);
      ctx.drawImage(this.fog, Math.round(-off - this.fog.width), y);
      ctx.globalAlpha = 1;
    }
  }

  Luna.Background = Background;
  Luna.moonPhase = moonPhase;
})(window.Luna);
