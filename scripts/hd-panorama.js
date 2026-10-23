#!/usr/bin/env node
/**
 * Builds the wide HD background used when Luna spans several displays.
 *
 * The picture is extended sideways with Higgsfield outpainting, one narrow
 * edge strip at a time: a 9:16 strip outpainted to 21:9 comes back with new
 * scenery on both sides, and only the outer side is kept. The original pixels
 * stay untouched in the middle; each new piece is crossfaded into the strip it
 * grew from, so there is no visible join.
 *
 *   node scripts/hd-panorama.js strip <current.png> <left|right> <strip.png>
 *       writes the edge strip to upload for outpainting
 *   node scripts/hd-panorama.js grow <current.png> <left|right> <outpainted.png> <out.png>
 *       stitches the outpainted strip's new side onto the picture
 *   node scripts/hd-panorama.js info <pano.png> <original.png>
 *       prints where the original sits inside the panorama (assets-hd.json "main")
 */
'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');

const read = (f) => PNG.sync.read(fs.readFileSync(f));
const write = (f, png) => fs.writeFileSync(f, PNG.sync.write(png));

function blank(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  return png;
}

function crop(src, x0, w) {
  const out = blank(w, src.height);
  for (let y = 0; y < src.height; y++) src.data.copy(out.data, y * w * 4, (y * src.width + x0) * 4, (y * src.width + x0 + w) * 4);
  return out;
}

/** Mean absolute difference between `a` at (ax, 0) and `b` at (bx, 0) over w columns, sampled. */
function diff(a, ax, b, bx, w) {
  let sum = 0;
  let n = 0;
  for (let y = 8; y < a.height - 8; y += 7) {
    for (let x = 0; x < w; x += 5) {
      const i = (y * a.width + ax + x) * 4;
      const j = (y * b.width + bx + x) * 4;
      sum += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
      n++;
    }
  }
  return sum / n;
}

const stripWidth = (h) => Math.round((h * 9) / 16);

function strip(cur, side) {
  const w = stripWidth(cur.height);
  return crop(cur, side === 'left' ? 0 : cur.width - w, w);
}

/** Grayscale copy downsampled by k (box filter), for registration. */
function gray(p, k) {
  const w = Math.floor(p.width / k);
  const h = Math.floor(p.height / k);
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const o = ((y * k + j) * p.width + x * k + i) * 4;
          s += p.data[o] * 0.3 + p.data[o + 1] * 0.59 + p.data[o + 2] * 0.11;
        }
      }
      g[y * w + x] = s / (k * k);
    }
  }
  return { w, h, g };
}

function sampleGray(G, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi + 1 >= G.w || yi + 1 >= G.h) return NaN;
  const tx = x - xi;
  const ty = y - yi;
  const i = yi * G.w + xi;
  return (G.g[i] * (1 - tx) + G.g[i + 1] * tx) * (1 - ty) + (G.g[i + G.w] * (1 - tx) + G.g[i + G.w + 1] * tx) * ty;
}

/**
 * Where the strip landed in the outpainted picture: strip pixel (u, v) sits at
 * (ox + u*a, oy + v*a). The service rescales narrow inputs (by up to ~20%), so
 * scale and both offsets are searched, coarse to fine.
 */
function register(s, out) {
  const fit = (k, cands) => {
    const S = gray(s, k);
    const O = gray(out, k);
    const cost = (a, ox, oy) => {
      let sum = 0;
      let n = 0;
      for (let v = 1; v < S.h - 1; v += 2) {
        for (let u = 1; u < S.w - 1; u += 2) {
          const q = sampleGray(O, (ox + u * a * k) / k, (oy + v * a * k) / k);
          if (Number.isNaN(q)) continue;
          sum += Math.abs(q - S.g[v * S.w + u]);
          n++;
        }
      }
      return n > (S.w * S.h) / 8 ? sum / n : Infinity; // most of the strip must overlap
    };
    let best = { c: Infinity };
    for (const [a, ox, oy] of cands()) {
      const c = cost(a, ox, oy);
      if (c < best.c) best = { c, a, ox, oy };
    }
    return best;
  };
  const base = out.height / s.height;
  const coarse = fit(8, function* () {
    for (let a = base * 0.8; a <= base * 1.4; a += 0.01) {
      const cx = (out.width - s.width * a) / 2;
      for (let oy = -out.height * 0.35; oy <= out.height * 0.2; oy += 8) for (let ox = cx - 240; ox <= cx + 240; ox += 8) yield [a, ox, oy];
    }
  });
  const fine = fit(2, function* () {
    for (let a = coarse.a - 0.01; a <= coarse.a + 0.01; a += 0.001) {
      for (let oy = coarse.oy - 8; oy <= coarse.oy + 8; oy += 1) for (let ox = coarse.ox - 8; ox <= coarse.ox + 8; ox += 1) yield [a, ox, oy];
    }
  });
  return fine;
}

function sampleRgb(p, x, y, dst, o) {
  const xi = Math.max(0, Math.min(p.width - 2, Math.floor(x)));
  const yi = Math.max(0, Math.min(p.height - 2, Math.floor(y)));
  const tx = Math.max(0, Math.min(1, x - xi));
  const ty = Math.max(0, Math.min(1, y - yi));
  for (let c = 0; c < 3; c++) {
    const i = (yi * p.width + xi) * 4 + c;
    const r = p.width * 4;
    dst[o + c] = (p.data[i] * (1 - tx) + p.data[i + 4] * tx) * (1 - ty) + (p.data[i + r] * (1 - tx) + p.data[i + r + 4] * tx) * ty;
  }
}

function grow(cur, side, outpainted) {
  const h = cur.height;
  const s = strip(cur, side);
  const sx0 = side === 'left' ? 0 : cur.width - s.width; // strip position in the current picture
  const { a, ox, oy, c } = register(s, outpainted);
  const EDGE = 8; // outpainted pixels this close to the border are unreliable
  const add = Math.floor(side === 'left' ? (ox - EDGE) / a : (outpainted.width - EDGE - ox) / a - s.width);
  // Rows the outpainted picture does not reach (it was scaled up): the sky at the
  // top is reflected from the rows below; the ground at the bottom is the strip's
  // own ground, mirror-tiled outward and blended in over BLEND rows.
  const vTop = Math.ceil((EDGE - oy) / a);
  const vBottom = Math.floor((outpainted.height - EDGE - oy) / a);
  const BLEND = 60;
  const mirror = (u) => { const m = ((u % (2 * s.width)) + 2 * s.width) % (2 * s.width); return m < s.width ? m : 2 * s.width - 1 - m; };
  console.log(`strip registered: scale ${a.toFixed(3)}, offset ${ox.toFixed(1)},${oy.toFixed(1)}, difference ${c.toFixed(1)}; +${add}px, rows ${Math.max(0, vTop)}..${Math.min(h - 1, vBottom)} covered`);
  const out = blank(cur.width + add, h);
  const fade = Math.round(s.width * 0.3); // crossfade the new scenery into the original strip
  const px = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = y < vTop ? Math.min(vBottom, 2 * vTop - y) : Math.min(y, vBottom);
    const g = Math.max(0, Math.min(1, (y - (vBottom - BLEND)) / BLEND)); // weight of the tiled ground
    for (let x = 0; x < out.width; x++) {
      const cx = side === 'left' ? x - add : x; // column in the current picture
      const u = cx - sx0; // column relative to the strip
      let t; // weight of the outpainted pixel
      if (cx < 0 || cx >= cur.width) t = 1;
      else t = Math.max(0, 1 - (side === 'left' ? cx : cur.width - 1 - cx) / fade);
      const o = (y * out.width + x) * 4;
      if (t > 0) {
        sampleRgb(outpainted, ox + u * a, oy + v * a, px, 0);
        if (g > 0) { const gi = (y * cur.width + sx0 + mirror(u)) * 4; for (let ch = 0; ch < 3; ch++) px[ch] = px[ch] * (1 - g) + cur.data[gi + ch] * g; }
      }
      for (let ch = 0; ch < 3; ch++) {
        const q = t < 1 ? cur.data[(y * cur.width + cx) * 4 + ch] : 0;
        out.data[o + ch] = Math.round(px[ch] * t + q * (1 - t));
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function locate(pano, orig) {
  if (pano.height !== orig.height) throw new Error('panorama and original differ in height');
  // Columns well inside the original are untouched: find them exactly.
  const probe = crop(orig, Math.round(orig.width * 0.4), Math.round(orig.width * 0.2));
  let best = { x: 0, d: Infinity };
  for (let x = 0; x + probe.width <= pano.width; x += 1) {
    const d = diff(pano, x, probe, 0, probe.width);
    if (d < best.d) best = { x, d };
    if (d === 0) break;
  }
  const x = best.x - Math.round(orig.width * 0.4);
  return { x: +(x / pano.width).toFixed(6), w: +(orig.width / pano.width).toFixed(6), px: x, diff: best.d };
}

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'strip') write(a[2], strip(read(a[0]), a[1]));
  else if (cmd === 'grow') { const out = grow(read(a[0]), a[1], read(a[2])); write(a[3], out); console.log(`${out.width}x${out.height}`); }
  else if (cmd === 'info') console.log(JSON.stringify(locate(read(a[0]), read(a[1]))));
  else { console.error('usage: see the header of scripts/hd-panorama.js'); process.exit(1); }
}

module.exports = { strip, grow, locate };
