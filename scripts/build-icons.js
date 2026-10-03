#!/usr/bin/env node
/**
 * Generates the app/tray icons from Luna's sprite: a crescent moon behind her
 * face on a dark rounded square. Writes PNGs plus Windows .ico files (pure JS).
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const girl = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'girl', 'girl.png')));

/** 32x32 base icon drawn by hand with the sprite's head pasted in. */
function baseIcon() {
  const S = 32;
  const img = new PNG({ width: S, height: S });
  const px = (x, y, hex, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    img.data[i] = parseInt(hex.slice(1, 3), 16); img.data[i + 1] = parseInt(hex.slice(3, 5), 16); img.data[i + 2] = parseInt(hex.slice(5, 7), 16); img.data[i + 3] = a;
  };
  // rounded dark square
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const corner = (x < 3 && y < 3) || (x > S - 4 && y < 3) || (x < 3 && y > S - 4) || (x > S - 4 && y > S - 4);
    const r = Math.hypot(Math.min(x - 3, S - 4 - x, 0), Math.min(y - 3, S - 4 - y, 0));
    if (corner && r > 3) continue;
    const t = y / S;
    px(x, y, t < 0.5 ? '#160f2a' : '#2a1a46');
  }
  // moon (crescent) top right
  for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
    const inMoon = x * x + y * y <= 49;
    const inCut = (x - 3) * (x - 3) + (y - 2) * (y - 2) <= 36;
    if (inMoon && !inCut) px(22 + x, 9 + y, '#f4edd3');
  }
  // stars
  for (const [x, y] of [[4, 5], [10, 3], [6, 12], [27, 20], [3, 20]]) px(x, y, '#fff6c8');
  // Luna's head from frame 0: columns 4..23, rows 0..17 → paste at (6, 12)
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) {
    const si = (y * girl.width + (x + 4)) * 4;
    if (girl.data[si + 3] === 0) continue;
    const i = ((y + 13) * S + (x + 6)) * 4;
    if (y + 13 >= S) continue;
    img.data[i] = girl.data[si]; img.data[i + 1] = girl.data[si + 1]; img.data[i + 2] = girl.data[si + 2]; img.data[i + 3] = 255;
  }
  return img;
}

function scale(src, factor) {
  const out = new PNG({ width: src.width * factor, height: src.height * factor });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const si = (Math.floor(y / factor) * src.width + Math.floor(x / factor)) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1]; out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = src.data[si + 3];
  }
  return out;
}

function downscale(src, factor) {
  // box filter (used for 16px from 32px)
  const out = new PNG({ width: src.width / factor, height: src.height / factor });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const acc = [0, 0, 0, 0];
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const si = ((y * factor + dy) * src.width + (x * factor + dx)) * 4;
      const a = src.data[si + 3] / 255;
      acc[0] += src.data[si] * a; acc[1] += src.data[si + 1] * a; acc[2] += src.data[si + 2] * a; acc[3] += a;
    }
    const di = (y * out.width + x) * 4;
    const n = factor * factor;
    if (acc[3] > 0) { out.data[di] = acc[0] / acc[3]; out.data[di + 1] = acc[1] / acc[3]; out.data[di + 2] = acc[2] / acc[3]; }
    out.data[di + 3] = Math.round((acc[3] / n) * 255);
  }
  return out;
}

/** Builds an .ico: small sizes as 32-bit DIBs, 256px as PNG. */
function ico(images) {
  const entries = images.map((img) => {
    const { width: w, height: h } = img;
    if (w >= 256) return { w, h, data: PNG.sync.write(img) };
    const rowBytes = w * 4;
    const maskRow = Math.ceil(w / 32) * 4;
    const buf = Buffer.alloc(40 + rowBytes * h + maskRow * h);
    buf.writeUInt32LE(40, 0); buf.writeInt32LE(w, 4); buf.writeInt32LE(h * 2, 8); buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14);
    buf.writeUInt32LE(0, 16); buf.writeUInt32LE(rowBytes * h, 20);
    let o = 40;
    for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      buf[o++] = img.data[si + 2]; buf[o++] = img.data[si + 1]; buf[o++] = img.data[si]; buf[o++] = img.data[si + 3];
    }
    for (let y = h - 1; y >= 0; y--) {
      const row = Buffer.alloc(maskRow);
      for (let x = 0; x < w; x++) if (img.data[(y * w + x) * 4 + 3] < 128) row[x >> 3] |= 0x80 >> (x & 7);
      row.copy(buf, o); o += maskRow;
    }
    return { w, h, data: buf };
  });
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const d = 6 + i * 16;
    header[d] = e.w >= 256 ? 0 : e.w; header[d + 1] = e.h >= 256 ? 0 : e.h; header[d + 2] = 0; header[d + 3] = 0;
    header.writeUInt16LE(1, d + 4); header.writeUInt16LE(32, d + 6); header.writeUInt32LE(e.data.length, d + 8); header.writeUInt32LE(offset, d + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

const base = baseIcon();
const i16 = downscale(base, 2);
const i48 = scale(i16, 3);
const i64 = scale(base, 2);
const i256 = scale(base, 8);
const build = path.join(ROOT, 'build');
const icons = path.join(ROOT, 'src', 'main', 'icons');
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(icons, { recursive: true });
fs.writeFileSync(path.join(build, 'icon.png'), PNG.sync.write(i256));
fs.writeFileSync(path.join(build, 'icon.ico'), ico([i16, base, i48, i64, i256]));
fs.writeFileSync(path.join(icons, 'tray.png'), PNG.sync.write(base));
fs.writeFileSync(path.join(icons, 'tray@2x.png'), PNG.sync.write(i64));
fs.writeFileSync(path.join(icons, 'tray.ico'), ico([i16, base, i64]));
console.log('icons written to build/ and src/main/icons/');
