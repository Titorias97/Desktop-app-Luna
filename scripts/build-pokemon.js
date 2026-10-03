#!/usr/bin/env node
/**
 * Downloads the Gen 5 (Black/White style) pixel-art sprites for Luna's Pokémon
 * from the PokeAPI sprites mirror on GitHub and packs them into PNG sprite
 * sheets + a JSON manifest the renderer can use.
 *
 *   node scripts/build-pokemon.js            # download (cached) + build
 *   node scripts/build-pokemon.js --offline  # build from .cache only
 *
 * Animated GIFs are decoded frame by frame (with correct GIF disposal
 * handling), identical frames are de-duplicated and consecutive duplicates
 * are merged into longer delays. Static PNGs (the two Megas) become one-frame
 * sheets which the renderer animates procedurally.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GifReader } = require('omggif');
const { PNG } = require('pngjs');

const BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white';

// id → file name used in the renderer, dex → PokeAPI id, kind → source type
const POKEMON = [
  { id: 'gengar',        dex: 94,    kind: 'anim' },
  { id: 'chandelure',    dex: 609,   kind: 'anim' },
  { id: 'froslass-mega', dex: 10285, kind: 'static' },
  { id: 'altaria-mega',  dex: 10067, kind: 'static' },
  { id: 'piplup',        dex: 393,   kind: 'anim' },
  { id: 'drifblim',      dex: 426,   kind: 'anim' },
  { id: 'mamoswine',     dex: 473,   kind: 'anim' },
  { id: 'lunatone',      dex: 337,   kind: 'anim' },
  { id: 'espeon',        dex: 196,   kind: 'anim' },
];

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'pokemon');
const OUT = path.join(ROOT, 'src', 'renderer', 'assets', 'pokemon');
const OFFLINE = process.argv.includes('--offline');

function sourceUrl(p) {
  return p.kind === 'anim' ? `${BASE}/animated/${p.dex}.gif` : `${BASE}/${p.dex}.png`;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  if (OFFLINE) throw new Error(`missing cached file ${dest} (offline mode)`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/** Decode every frame of a GIF into full-size RGBA buffers, honouring disposal. */
function decodeGif(buf) {
  const reader = new GifReader(buf);
  const w = reader.width;
  const h = reader.height;
  const canvas = Buffer.alloc(w * h * 4); // starts fully transparent
  const frames = [];
  let prevInfo = null;
  let saved = null;

  for (let i = 0; i < reader.numFrames(); i++) {
    const info = reader.frameInfo(i);
    // Dispose the previous frame before drawing this one.
    if (prevInfo) {
      if (prevInfo.disposal === 2) clearRect(canvas, w, prevInfo);
      else if (prevInfo.disposal === 3 && saved) saved.copy(canvas);
    }
    if (info.disposal === 3) saved = Buffer.from(canvas);
    reader.decodeAndBlitFrameRGBA(i, canvas);
    const delayCs = info.delay > 0 ? info.delay : 10; // browsers treat 0 as 100 ms
    frames.push({ rgba: Buffer.from(canvas), ms: delayCs * 10 });
    prevInfo = info;
  }
  return { w, h, frames };
}

function clearRect(canvas, w, f) {
  for (let y = f.y; y < f.y + f.height; y++) {
    canvas.fill(0, (y * w + f.x) * 4, (y * w + f.x + f.width) * 4);
  }
}

function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, frames: [{ rgba: png.data, ms: 0 }] };
}

/** Tight bounding box over all frames (so static 96x96 sprites lose their padding). */
function bounds(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (const f of img.frames) {
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        if (f.rgba[(y * img.w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: img.w, h: img.h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(rgba, srcW, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const srcStart = ((box.y + y) * srcW + box.x) * 4;
    rgba.copy(out, y * box.w * 4, srcStart, srcStart + box.w * 4);
  }
  return out;
}

function build(p, img) {
  const box = bounds(img);
  const unique = [];
  const byHash = new Map();
  const sequence = [];
  for (const f of img.frames) {
    const cropped = crop(f.rgba, img.w, box);
    const hash = crypto.createHash('md5').update(cropped).digest('hex');
    let idx = byHash.get(hash);
    if (idx === undefined) {
      idx = unique.length;
      unique.push(cropped);
      byHash.set(hash, idx);
    }
    const last = sequence[sequence.length - 1];
    if (last && last.i === idx) last.ms += f.ms; // merge consecutive identical frames
    else sequence.push({ i: idx, ms: f.ms });
  }
  // Pack unique frames into a near-square grid.
  const cols = Math.max(1, Math.ceil(Math.sqrt(unique.length)));
  const rows = Math.ceil(unique.length / cols);
  const sheet = new PNG({ width: cols * box.w, height: rows * box.h });
  unique.forEach((frame, n) => {
    const cx = (n % cols) * box.w;
    const cy = Math.floor(n / cols) * box.h;
    for (let y = 0; y < box.h; y++) {
      frame.copy(sheet.data, ((cy + y) * sheet.width + cx) * 4, y * box.w * 4, (y + 1) * box.w * 4);
    }
  });
  fs.writeFileSync(path.join(OUT, `${p.id}.png`), PNG.sync.write(sheet));
  const totalMs = sequence.reduce((a, s) => a + s.ms, 0);
  return {
    id: p.id,
    file: `pokemon/${p.id}.png`,
    w: box.w,
    h: box.h,
    cols,
    frames: unique.length,
    loopMs: totalMs,
    sequence,
    source: sourceUrl(p),
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  const manifest = {};
  for (const p of POKEMON) {
    const url = sourceUrl(p);
    const cached = path.join(CACHE, path.basename(url));
    process.stdout.write(`${p.id.padEnd(14)} `);
    await download(url, cached);
    const buf = fs.readFileSync(cached);
    const img = p.kind === 'anim' ? decodeGif(buf) : decodePng(buf);
    const entry = build(p, img);
    manifest[p.id] = entry;
    console.log(`${img.frames.length} src frames -> ${entry.frames} unique, ${entry.w}x${entry.h}, loop ${entry.loopMs} ms`);
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // The renderer loads this as a classic <script> so it also works from file://
  fs.writeFileSync(path.join(OUT, 'manifest.js'), `window.LUNA_POKEMON = ${JSON.stringify(manifest)};\n`);
  console.log(`wrote ${path.relative(ROOT, path.join(OUT, 'manifest.json'))} (+ manifest.js)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
