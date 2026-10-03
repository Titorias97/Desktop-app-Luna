/**
 * Exercises scripts/hd-build.js without network: builds a fake 12-pose sheet
 * from the hand-drawn girl and a fake background from the procedural preview,
 * then runs the build and checks the outputs. `npm test` runs it.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hd-'));
const girl = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'src/renderer/assets/girl/girl.png')));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/assets/girl/girl.json'), 'utf8'));

// Fake sheet: 12 frames of the classic girl, upscaled 8x, laid out 4x3 with gaps.
const K = 8, cell = 320, sheet = new PNG({ width: cell * 4, height: cell * 3 });
const names = ['idle0', 'walk0', 'walk1', 'walk2', 'pet0', 'pet1', 'wave0', 'wave1', 'sit0', 'startle0', 'reach0', 'happy0'];
names.forEach((n, i) => {
  const fi = meta.frames[n];
  const ox = (i % 4) * cell + 40, oy = Math.floor(i / 4) * cell + 0;
  for (let y = 0; y < meta.h; y++) for (let x = 0; x < meta.w; x++) {
    const si = (y * girl.width + fi * meta.w + x) * 4;
    if (!girl.data[si + 3]) continue;
    for (let dy = 0; dy < K; dy++) for (let dx = 0; dx < K; dx++) {
      const di = ((oy + y * K + dy) * sheet.width + ox + x * K + dx) * 4;
      sheet.data[di] = girl.data[si]; sheet.data[di + 1] = girl.data[si + 1]; sheet.data[di + 2] = girl.data[si + 2]; sheet.data[di + 3] = 255;
    }
  }
});
fs.writeFileSync(path.join(tmp, 'sheet.png'), PNG.sync.write(sheet));
// Fake background: upscale the preview picture to a wide canvas.
const prev = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'docs/preview.png')));
fs.writeFileSync(path.join(tmp, 'bg.png'), PNG.sync.write(prev));
const config = {
  candidates: { background: [{ id: 'fake', model: 'test', url: path.join(tmp, 'bg.png') }], luna: [{ id: 'fake', model: 'test', url: path.join(tmp, 'sheet.png') }], sheets: [{ id: 'fake', model: 'test', url: path.join(tmp, 'sheet.png') }] },
  chosen: { background: 'fake', luna: 'fake', sheet: 'fake', targetHeight: 80, colors: 32, layout: { horizon: 0.5, groundTop: 0.7, groundBottom: 0.98 }, bench: { x: 0.3, y: 0.75 } },
};
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
const out = path.join(ROOT, 'src/renderer/assets/hd');
// Everything the build may write: snapshot it so the real assets survive the test.
const outputs = ['bg.js', 'luna.js', 'bg.png', 'luna.png', 'luna.json'].map((f) => path.join(out, f))
  .concat([path.join(ROOT, 'docs/luna-hd.png'), path.join(ROOT, 'docs/hd/luna-hd-sheet.png')]);
const backup = new Map();
for (const p of outputs) if (fs.existsSync(p)) backup.set(p, fs.readFileSync(p));
try {
  let log;
  try {
    log = execFileSync('node', [path.join(ROOT, 'scripts/hd-assets.js'), 'build'], { env: { ...process.env, LUNA_HD_CONFIG: path.join(tmp, 'config.json'), LUNA_HD_CACHE: path.join(tmp, 'cache') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    process.stdout.write(String(err.stdout || ''));
    process.stderr.write(String(err.stderr || '').split('\n').filter((l) => !l.trim().startsWith('at ')).join('\n'));
    throw new Error('hd build failed');
  }
  process.stdout.write(log);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'luna.json'), 'utf8'));
  if (Object.keys(manifest.frames).length !== 12) throw new Error('expected 12 frames');
  if (!(manifest.h >= 70 && manifest.h <= 100)) throw new Error(`unexpected frame height ${manifest.h}`);
  const bgMeta = fs.readFileSync(path.join(out, 'bg.js'), 'utf8');
  if (!bgMeta.includes('"available":true')) throw new Error('bg.js not written');
  console.log('hd-build synthetic test ok');
  if (process.argv.includes('--keep')) { console.log('keeping synthetic HD assets in place'); process.exit(0); }
} finally {
  if (!process.argv.includes('--keep')) {
    for (const p of outputs) {
      if (backup.has(p)) fs.writeFileSync(p, backup.get(p)); else if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
