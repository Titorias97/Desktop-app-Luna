#!/usr/bin/env node
/**
 * HD asset pipeline (Higgsfield-generated background + Luna sprites).
 *
 *   node scripts/hd-assets.js preview   # docs/hd/*.png — downscaled previews of every candidate
 *   node scripts/hd-assets.js build     # src/renderer/assets/hd/ — final assets for the renderer
 *
 * Sources are listed in assets-hd.json. Downloads are cached in .cache/hd/.
 * Pure Node (pngjs only) so it runs on Windows, CI and anywhere else.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'hd');
const DOCS = path.join(ROOT, 'docs', 'hd');
const OUT = path.join(ROOT, 'src', 'renderer', 'assets', 'hd');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets-hd.json'), 'utf8'));
const mode = process.argv[2] || 'preview';

// ---------------------------------------------------------------------------
async function download(url, name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return dest;
}

const readPng = (file) => PNG.sync.read(fs.readFileSync(file));
const writePng = (file, png) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, PNG.sync.write(png)); };

/** Box-filter downscale by an arbitrary factor (alpha-weighted). */
function downscale(src, factor) {
  const w = Math.max(1, Math.round(src.width / factor));
  const h = Math.max(1, Math.round(src.height / factor));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3];
          r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/** Composites onto a solid colour (for previews of transparent sprites). */
function flatten(src, hex) {
  const bg = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    out.data[i] = src.data[i] * a + bg[0] * (1 - a);
    out.data[i + 1] = src.data[i + 1] * a + bg[1] * (1 - a);
    out.data[i + 2] = src.data[i + 2] * a + bg[2] * (1 - a);
    out.data[i + 3] = 255;
  }
  return out;
}

/** Keys out a chroma background (green screen) with a tolerance, in place. */
function chromaKey(png, hex, tol = 90) {
  const key = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  for (let i = 0; i < png.data.length; i += 4) {
    const d = Math.abs(png.data[i] - key[0]) + Math.abs(png.data[i + 1] - key[1]) + Math.abs(png.data[i + 2] - key[2]);
    if (d < tol) png.data[i + 3] = 0;
  }
  return png;
}

/** Bounding box of non-transparent pixels. */
function bbox(png, threshold = 8) {
  let x0 = png.width, y0 = png.height, x1 = -1, y1 = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (png.data[(y * png.width + x) * 4 + 3] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(png, box) {
  const out = new PNG({ width: box.w, height: box.h });
  for (let y = 0; y < box.h; y++) png.data.copy(out.data, y * box.w * 4, ((box.y + y) * png.width + box.x) * 4, ((box.y + y) * png.width + box.x + box.w) * 4);
  return out;
}

// ---------------------------------------------------------------------------
async function preview() {
  fs.mkdirSync(DOCS, { recursive: true });
  for (const c of config.candidates.background) {
    const file = await download(c.url, `bg-${c.id}.png`);
    const png = readPng(file);
    writePng(path.join(DOCS, `bg-${c.id}.png`), downscale(png, 3));
    console.log(`bg ${c.id}: ${png.width}x${png.height}`);
  }
  for (const c of config.candidates.luna) {
    const file = await download(c.url, `luna-${c.id}.png`);
    let png = readPng(file);
    if (c.chroma) chromaKey(png, c.chroma);
    const box = bbox(png);
    console.log(`luna ${c.id}: ${png.width}x${png.height}, figure ${box ? `${box.w}x${box.h}` : 'none'}`);
    writePng(path.join(DOCS, `luna-${c.id}.png`), flatten(downscale(png, 2), '#303040'));
  }
  for (const s of config.candidates.sheets) {
    const file = await download(s.url, `sheet-${s.id}.png`);
    const png = readPng(file);
    console.log(`sheet ${s.id}: ${png.width}x${png.height}`);
    writePng(path.join(DOCS, `sheet-${s.id}.png`), flatten(downscale(png, 2), '#303040'));
  }
}

// ---------------------------------------------------------------------------
if (mode === 'preview') preview().catch((e) => { console.error(e); process.exit(1); });
else if (mode === 'build') require('./hd-build.js')({ config, download, readPng, writePng, downscale, chromaKey, bbox, crop, OUT, DOCS, CACHE, ROOT });
else { console.error('usage: node scripts/hd-assets.js preview|build'); process.exit(1); }
