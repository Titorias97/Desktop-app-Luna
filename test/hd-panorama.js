/**
 * scripts/hd-panorama.js against a fake outpainting service: a known wide
 * picture is cropped to an "original", and each "outpaint" returns the true
 * surroundings of the uploaded strip, rescaled the way the real service does
 * (narrow inputs come back enlarged and offset). Growing the original must then
 * reproduce the wide picture and keep the original pixels untouched.
 */
'use strict';
const { PNG } = require('pngjs');
const { strip, grow, locate } = require('../scripts/hd-panorama');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// Smooth but distinctive scenery: overlapping gradients plus blobs, so registration has something to lock on.
const H = 304;
const TRUE_W = 1600;
function truth(x, y) {
  const r = 120 + 60 * Math.sin(x / 37) + 40 * Math.cos(y / 23 + x / 91);
  const g = 100 + 50 * Math.sin((x + y) / 53) + 30 * Math.sin(x / 11) * Math.cos(y / 17);
  const b = 140 + 60 * Math.cos(x / 29 - y / 41);
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}
function image(w, h, f) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); const o = (y * w + x) * 4; p.data[o] = c[0]; p.data[o + 1] = c[1]; p.data[o + 2] = c[2]; p.data[o + 3] = 255; }
  return p;
}

const ORIG_X = 560; // where the original sits in the true panorama
const ORIG_W = 540;
const original = image(ORIG_W, H, (x, y) => truth(ORIG_X + x, y));

/** The fake service: strip placed at scale `a` (output px per strip px) and offset (ox, oy). */
function fakeOutpaint(stripX, stripW, a, oy) {
  const OW = 640;
  const OH = 272; // 21:9-ish, smaller than the input like the real one
  const ox = (OW - stripW * a) / 2;
  return image(OW, OH, (x, y) => truth(stripX + (x - ox) / a, (y - oy) / a));
}

let pano = original;
let left = ORIG_X; // true x of the panorama's first column
for (const [side, a, oy] of [['left', 0.95, 4], ['right', 1.04, -9]]) {
  const s = strip(pano, side);
  const stripX = side === 'left' ? left : left + pano.width - s.width;
  const before = pano.width;
  pano = grow(pano, side, fakeOutpaint(stripX, s.width, a, oy));
  assert(pano.width > before + 100, `${side}: picture grew (${before} -> ${pano.width})`);
  if (side === 'left') left -= pano.width - before;
}

// The original is found again, untouched, at the right place.
const where = locate(pano, original);
assert(where.px === ORIG_X - left && where.diff === 0, `original located intact (got ${JSON.stringify(where)}, want px ${ORIG_X - left})`);

// New scenery matches the truth (away from the reflected bottom rows and the very edges).
let err = 0;
let n = 0;
for (let y = 20; y < H - 60; y += 3) {
  for (let x = 12; x < pano.width - 12; x += 3) {
    const t = truth(left + x, y);
    const o = (y * pano.width + x) * 4;
    err += Math.abs(pano.data[o] - t[0]) + Math.abs(pano.data[o + 1] - t[1]) + Math.abs(pano.data[o + 2] - t[2]);
    n++;
  }
}
const mean = err / n / 3;
assert(mean < 6, `stitched panorama matches the scenery (mean error ${mean.toFixed(2)} per channel)`);
console.log(`hd-panorama test ok (${pano.width}x${pano.height}, mean error ${mean.toFixed(2)})`);
