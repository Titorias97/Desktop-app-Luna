'use strict';
/**
 * Build mode of the HD asset pipeline (called by scripts/hd-assets.js build).
 *
 *  - background: copies the chosen Higgsfield picture to src/renderer/assets/hd/bg.png
 *    and analyses it (stars, warm lights, moon) so the renderer can animate them.
 *  - luna: cuts the chosen 12-pose sprite sheet into frames, scales them to a
 *    common pixel size, snaps alpha, quantises the palette and packs a sheet
 *    + manifest in the same format as the hand-drawn girl.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const POSES = ['idle0', 'walk0', 'walk1', 'walk2', 'pet0', 'pet1', 'wave0', 'wave1', 'sit0', 'startle0', 'reach0', 'happy0'];
const ANIMATIONS = {
  idle: { frames: ['idle0'], ms: [1000], loop: true },
  walk: { frames: ['walk0', 'walk1', 'walk2', 'walk1'], ms: [150, 150, 150, 150], loop: true },
  pet: { frames: ['pet0', 'pet1'], ms: [320, 320], loop: true },
  wave: { frames: ['wave0', 'wave1'], ms: [260, 260], loop: true },
  sit: { frames: ['sit0'], ms: [1000], loop: true },
  startle: { frames: ['startle0'], ms: [600], loop: false },
  reach: { frames: ['reach0'], ms: [1000], loop: true },
  happy: { frames: ['happy0', 'idle0'], ms: [260, 260], loop: true },
};

module.exports = async function build(t) {
  const { config, download, readPng, writePng, downscale, chromaKey, bbox, crop, OUT, DOCS, ROOT } = t;
  fs.mkdirSync(OUT, { recursive: true });
  const chosen = config.chosen;

  // ---------------------------------------------------------------- background
  const bgSrc = config.candidates.background.find((c) => c.id === chosen.background);
  if (!bgSrc) throw new Error(`unknown background ${chosen.background}`);
  const bgFile = await download(bgSrc.url, `bg-${bgSrc.id}.png`);
  const bg = readPng(bgFile);
  fs.copyFileSync(bgFile, path.join(OUT, 'bg.png'));
  const analysis = analyseBackground(bg, chosen.layout);
  const bgMeta = {
    available: true,
    file: 'hd/bg.png',
    width: bg.width,
    height: bg.height,
    source: { model: bgSrc.model, url: bgSrc.url },
    layout: chosen.layout,
    bench: chosen.bench,
    moon: analysis.moon,
    stars: analysis.stars,
    lights: analysis.lights,
    seed: 7,
  };
  fs.writeFileSync(path.join(OUT, 'bg.js'), `window.LUNA_HD_BG = ${JSON.stringify(bgMeta)};\n`);
  console.log(`background ${bgSrc.id}: ${bg.width}x${bg.height}, ${analysis.stars.length} stars, ${analysis.lights.length} lights, moon ${JSON.stringify(analysis.moon)}`);

  // ---------------------------------------------------------------- luna design (for docs)
  const design = config.candidates.luna.find((c) => c.id === chosen.luna);
  if (design) {
    const file = await download(design.url, `luna-${design.id}.png`);
    const png = readPng(file);
    if (design.chroma) chromaKey(png, design.chroma, 120);
    const box = bbox(png);
    writePng(path.join(ROOT, 'docs', 'luna-hd.png'), box ? crop(png, box) : png);
  }

  // ---------------------------------------------------------------- luna poses
  const sheetSrc = config.candidates.sheets.find((c) => c.id === chosen.sheet);
  if (!sheetSrc) { console.log('no pose sheet chosen yet — Luna HD skipped'); return; }
  const sheetFile = await download(sheetSrc.url, `sheet-${sheetSrc.id}.png`);
  const sheet = readPng(sheetFile);
  if (sheetSrc.chroma) chromaKey(sheet, sheetSrc.chroma, 120);
  let cells = gridCells(sheet, 4, 3);
  if (!cells) {
    const blobs = segment(sheet, chosen.minBlobArea || 400, chosen.mergeGap || 10);
    console.log(`sheet ${sheetSrc.id}: band detection failed, ${blobs.length} blobs found`);
    cells = assignCells(blobs, sheet.width, sheet.height, 4, 3);
  }
  console.log(`sheet ${sheetSrc.id}: ${sheet.width}x${sheet.height}, cells: ${cells.map((c) => (c ? `${c.w}x${c.h}` : '-')).join(' ')}`);
  const idle = cells[0];
  if (!idle) throw new Error('no idle pose found in cell 1');
  const factor = idle.h / (chosen.targetHeight || 84);
  const frames = POSES.map((name, i) => {
    const b = cells[i] || idle;
    if (!cells[i]) console.warn(`pose ${name} missing — using idle`);
    const override = (chosen.scaleOverrides || {})[name] || 1;
    const img = downscale(crop(sheet, b), factor / override);
    snapAlpha(img, 128);
    const tb = bbox(img, 0);
    return { name, png: tb ? crop(img, tb) : img };
  });
  quantise(frames.map((f) => f.png), chosen.colors || 64);
  const fw = Math.max(...frames.map((f) => f.png.width)) + 2;
  const fh = Math.max(...frames.map((f) => f.png.height)) + 1;
  const cols = 4;
  const rows = Math.ceil(frames.length / cols);
  const out = new PNG({ width: fw * cols, height: fh * rows });
  frames.forEach((f, i) => {
    const cx = (i % cols) * fw + Math.floor((fw - f.png.width) / 2);
    const cy = Math.floor(i / cols) * fh + (fh - f.png.height); // feet on the cell floor
    for (let y = 0; y < f.png.height; y++) f.png.data.copy(out.data, ((cy + y) * out.width + cx) * 4, y * f.png.width * 4, (y + 1) * f.png.width * 4);
  });
  writePng(path.join(OUT, 'luna.png'), out);
  const manifest = {
    available: true,
    file: 'hd/luna.png',
    w: fw,
    h: fh,
    cols,
    anchor: { x: fw / 2, y: fh },
    baseFacing: 1,
    bob: [1, 3.4],
    frames: Object.fromEntries(POSES.map((n, i) => [n, i])),
    animations: ANIMATIONS,
    source: { model: sheetSrc.model, url: sheetSrc.url },
  };
  fs.writeFileSync(path.join(OUT, 'luna.js'), `window.LUNA_GIRL_HD = ${JSON.stringify(manifest)};\n`);
  fs.writeFileSync(path.join(OUT, 'luna.json'), JSON.stringify(manifest, null, 2));
  // preview strip for the docs
  writePng(path.join(DOCS, 'luna-hd-sheet.png'), upscaleFlat(out, 3, '#303040'));
  console.log(`luna HD: ${frames.length} frames of ${fw}x${fh} (${frames.map((f) => `${f.name}:${f.png.width}x${f.png.height}`).join(', ')})`);
};

// -----------------------------------------------------------------------------
/**
 * Splits a cols x rows pose sheet into cells using occupancy profiles: column
 * bands over the whole sheet, then row bands inside each column. Returns an
 * array of bounding boxes (row-major) or null when the bands cannot be found.
 */
function gridCells(png, cols, rows) {
  const { width: w, height: h } = png;
  const opaque = (x, y) => png.data[(y * w + x) * 4 + 3] > 40;
  const bands = (len, occupied, minGap, expected) => {
    // occupied(i) -> bool; returns [start,end] runs, merging runs separated by gaps < minGap
    const runs = [];
    let start = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && occupied(i);
      if (on && start < 0) start = i;
      if (!on && start >= 0) { runs.push([start, i - 1]); start = -1; }
    }
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] - 1 < minGap) last[1] = r[1]; else merged.push([...r]);
    }
    // drop slivers (noise) then, while too many, merge the smallest band into its nearest neighbour
    let out = merged.filter((r) => r[1] - r[0] + 1 >= len * 0.02);
    while (out.length > expected) {
      let si = 0;
      for (let i = 1; i < out.length; i++) if (out[i][1] - out[i][0] < out[si][1] - out[si][0]) si = i;
      const prev = out[si - 1], next = out[si + 1];
      const toPrev = prev ? out[si][0] - prev[1] : Infinity;
      const toNext = next ? next[0] - out[si][1] : Infinity;
      if (toPrev <= toNext) { prev[1] = out[si][1]; out.splice(si, 1); } else { next[0] = out[si][0]; out.splice(si, 1); }
    }
    if (out.length && out.length !== expected) {
      // poses touch or have uneven gaps: split the overall extent evenly
      const a = out[0][0], b = out[out.length - 1][1];
      const size = (b - a + 1) / expected;
      out = Array.from({ length: expected }, (_, i) => [Math.round(a + i * size), Math.round(a + (i + 1) * size) - 1]);
    }
    return out.length === expected ? out : null;
  };
  const colCount = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (opaque(x, y)) colCount[x]++;
  const colBands = bands(w, (x) => colCount[x] > 2, Math.round(w * 0.01), cols);
  if (!colBands) return null;
  const cells = new Array(cols * rows).fill(null);
  for (let c = 0; c < cols; c++) {
    const [x0, x1] = colBands[c];
    const rowCount = new Int32Array(h);
    for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (opaque(x, y)) rowCount[y]++;
    const rowBands = bands(h, (y) => rowCount[y] > 2, Math.round(h * 0.01), rows);
    if (!rowBands) return null;
    for (let r = 0; r < rows; r++) {
      const [y0, y1] = rowBands[r];
      let bx0 = x1, bx1 = x0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (opaque(x, y)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
      cells[r * cols + c] = { x: bx0, y: y0, w: bx1 - bx0 + 1, h: y1 - y0 + 1 };
    }
  }
  return cells;
}

function snapAlpha(png, threshold) {
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = png.data[i] >= threshold ? 255 : 0;
}

/** Connected components of opaque pixels (8-connected after a small dilation to bridge gaps). */
function segment(png, minArea, gap) {
  const { width: w, height: h } = png;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = png.data[i * 4 + 3] > 40 ? 1 : 0;
  // dilate
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!solid[y * w + x]) continue;
    for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) dil[yy * w + xx] = 1;
    }
  }
  const label = new Int32Array(w * h).fill(-1);
  const blobs = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!dil[s] || label[s] >= 0) continue;
    const id = blobs.length;
    const b = { x0: w, y0: h, x1: -1, y1: -1, area: 0 };
    stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop();
      const y = (p / w) | 0, x = p - y * w;
      if (solid[p]) { b.area++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
      const n = [p - 1, p + 1, p - w, p + w];
      if (x === 0) n[0] = -1; if (x === w - 1) n[1] = -1;
      for (const q of n) if (q >= 0 && q < w * h && dil[q] && label[q] < 0) { label[q] = id; stack.push(q); }
    }
    blobs.push(b);
  }
  return blobs.filter((b) => b.area >= minArea && b.x1 >= 0).map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area }));
}

/** Maps blobs onto a cols x rows grid by their centres (largest blob wins a cell). */
function assignCells(blobs, W, H, cols, rows) {
  const cells = new Array(cols * rows).fill(null);
  for (const b of blobs.sort((a, c) => c.area - a.area)) {
    const col = Math.min(cols - 1, Math.floor(((b.x + b.w / 2) / W) * cols));
    const row = Math.min(rows - 1, Math.floor(((b.y + b.h / 2) / H) * rows));
    const i = row * cols + col;
    if (!cells[i]) cells[i] = b;
  }
  return cells;
}

/** Median-cut palette shared by all frames; opaque pixels are remapped in place. */
function quantise(pngs, maxColors) {
  const pixels = [];
  for (const p of pngs) for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3]) pixels.push([p.data[i], p.data[i + 1], p.data[i + 2]]);
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift();
    if (!box || box.length < 2) { if (box) boxes.push(box); break; }
    const ranges = [0, 1, 2].map((c) => { let lo = 255, hi = 0; for (const px of box) { if (px[c] < lo) lo = px[c]; if (px[c] > hi) hi = px[c]; } return hi - lo; });
    const ch = ranges.indexOf(Math.max(...ranges));
    if (ranges[ch] < 6) { boxes.push(box); break; }
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  const palette = boxes.map((box) => { const s = [0, 0, 0]; for (const px of box) { s[0] += px[0]; s[1] += px[1]; s[2] += px[2]; } return s.map((v) => Math.round(v / box.length)); });
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let best = cache.get(key);
    if (best) return best;
    let bd = Infinity;
    for (const c of palette) { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = c; } }
    cache.set(key, best);
    return best;
  };
  for (const p of pngs) for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3]) { const c = nearest(p.data[i], p.data[i + 1], p.data[i + 2]); p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; }
}

function upscaleFlat(src, k, hex) {
  const bg = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const out = new PNG({ width: src.width * k, height: src.height * k });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const si = (((y / k) | 0) * src.width + ((x / k) | 0)) * 4;
    const di = (y * out.width + x) * 4;
    const a = src.data[si + 3] ? 1 : 0;
    out.data[di] = a ? src.data[si] : bg[0]; out.data[di + 1] = a ? src.data[si + 1] : bg[1]; out.data[di + 2] = a ? src.data[si + 2] : bg[2]; out.data[di + 3] = 255;
  }
  return out;
}

/** Finds twinkle-able stars, warm lights and the moon (fractions of the image size). */
function analyseBackground(png, layout) {
  const k = 2; // analyse at half resolution
  const w = Math.floor(png.width / k), h = Math.floor(png.height / k);
  const lum = new Float32Array(w * h), R = new Uint8Array(w * h), G = new Uint8Array(w * h), B = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * k) * png.width + x * k) * 4;
    R[y * w + x] = png.data[i]; G[y * w + x] = png.data[i + 1]; B[y * w + x] = png.data[i + 2];
    lum[y * w + x] = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  }
  const blobsOf = (mask, maxArea) => {
    const label = new Int32Array(w * h).fill(-1);
    const out = [];
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || label[s] >= 0) continue;
      const b = { sx: 0, sy: 0, area: 0, maxL: 0 };
      stack.push(s); label[s] = out.length;
      while (stack.length) {
        const p = stack.pop();
        const y = (p / w) | 0, x = p - y * w;
        b.sx += x; b.sy += y; b.area++; if (lum[p] > b.maxL) b.maxL = lum[p];
        for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && mask[q] && label[q] < 0 && Math.abs((q % w) - x) <= 1) { label[q] = out.length; stack.push(q); }
      }
      if (b.area <= maxArea) out.push({ x: b.sx / b.area, y: b.sy / b.area, area: b.area, maxL: b.maxL });
      else out.push({ x: b.sx / b.area, y: b.sy / b.area, area: b.area, maxL: b.maxL, big: true });
    }
    return out;
  };
  const skyBottom = Math.floor(layout.horizon * h);
  // Moon: biggest bright, low-saturation blob in the sky.
  const brightMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) brightMask[i] = i < skyBottom * w && lum[i] > 200 && Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i]) < 70 ? 1 : 0;
  const bright = blobsOf(brightMask, 1e9).sort((a, b) => b.area - a.area);
  const moonBlob = bright[0] && bright[0].area > 200 ? bright[0] : null;
  const moon = moonBlob ? { x: moonBlob.x / w, y: moonBlob.y / h, r: Math.sqrt(moonBlob.area / Math.PI) / w } : { x: 0.8, y: 0.12, r: 0.05 };
  // Stars: small bright specks away from the moon.
  const stars = bright.filter((b) => b.area <= 20 && b !== moonBlob && Math.hypot(b.x - (moon.x * w), b.y - (moon.y * h)) > moon.r * w * 1.6)
    .sort((a, b) => b.maxL - a.maxL).slice(0, 160).map((b) => [+(b.x / w).toFixed(4), +(b.y / h).toFixed(4)]);
  // Warm lights: amber pixels (lanterns, windows, candles) anywhere.
  const warmMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) warmMask[i] = R[i] > 190 && G[i] > 110 && G[i] < 230 && B[i] < 130 && R[i] - B[i] > 90 ? 1 : 0;
  const lights = blobsOf(warmMask, 1e9).filter((b) => b.area >= 6 && b.area <= 3000).sort((a, b) => b.area - a.area).slice(0, 80)
    .map((b) => [+(b.x / w).toFixed(4), +(b.y / h).toFixed(4), +(Math.sqrt(b.area) / w).toFixed(4)]);
  return { moon: { x: +moon.x.toFixed(4), y: +moon.y.toFixed(4), r: +moon.r.toFixed(4) }, stars, lights };
}
