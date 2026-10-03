#!/usr/bin/env node
/**
 * Generates Luna's pixel-art sprite sheet from hand-drawn ASCII layers.
 *
 *   node scripts/build-girl.js            -> src/renderer/assets/girl/girl.{png,json}
 *   node scripts/build-girl.js --preview  -> also writes a 6x preview strip to .cache/
 *
 * Each frame is 28x40 px, drawn facing RIGHT (the renderer mirrors it for left).
 * The anchor is the bottom-centre of the frame (her feet).
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 28;
const H = 40;

const PALETTE = {
  o: '#1a1020', // outline
  h: '#241d33', // hair base
  H: '#413659', // hair highlight
  d: '#140f1c', // hair deep shadow
  s: '#f7e8de', // skin
  S: '#e2c1b4', // skin shade
  b: '#f0a6b6', // blush
  w: '#f6f1f9', // white (lace, socks, eye shine)
  W: '#cdc3d8', // white shade
  k: '#2d2642', // dress base
  K: '#453c5e', // dress highlight
  j: '#1d1829', // dress deep shade
  r: '#8b2e5f', // ribbon wine
  R: '#b84b86', // ribbon highlight
  e: '#8a4ccf', // iris violet
  E: '#2a1640', // eye dark
  g: '#15111c', // shoe
  G: '#3a3350', // shoe highlight
};

// ---------------------------------------------------------------------------
// Layers. '.' is transparent. Each layer has an (x, y) origin inside the frame.
// ---------------------------------------------------------------------------
const L = {};

// Long hair hanging behind the shoulders (drawn first, under the body).
L.hairBack = { x: 4, y: 14, rows: [
  '.oo..............oo.',
  '.ohho...........ohho',
  '.ohhho.........ohhho',
  '.ohhhho.......ohhhho',
  '.ohhhho.......ohhhho',
  '.ohhhho.......ohhhho',
  '.ohhhho.......ohhhho',
  '.ohhhho.......ohhhho',
  '..ohhho.......ohhho.',
  '..ohhho.......ohhho.',
  '...ohho.......ohho..',
  '....oo.........oo...',
]};

// Head: 3/4 view facing right. Bangs, big violet eyes, blush.
L.head = { x: 4, y: 0, rows: [
  '.......oooooooo.....',
  '.....oohhhhhhhhoo...',
  '....ohhhhHHhhhhhho..',
  '...ohhhhHHHhhhhhhho.',
  '..ohhhhhHHhhhhhhhhho',
  '..ohhhhhhhhhhhhhhhho',
  '.ohhhhhhhhhhhhhhhhho',
  '.ohhhhhhhhhhhhhhhhho',
  '.ohhhhdhhhdhhhdhhhho',
  '.ohhhossossssssssHho',
  '.ohhosssssssssssshho',
  '.ohhosEEssssEEssshho',
  '.ohhoseesssseessshho',
  '.ohhosEwssssEwssshho',
  '.ohhhosbsssssbssShho',
  '.ohhhhossssssssSohho',
  '..ohhhhooosSSooohho.',
  '..ohhhhhoossoohhhho.',
]};

// Small wine ribbon on the right side of her hair.
L.bow = { x: 19, y: 3, rows: [
  '.oo.oo.',
  'orRooRo',
  'orrRrro',
  '.orrro.',
  '.oo.oo.',
]};

// Bodice with white collar, puffed sleeves with white cuffs, arms down.
L.torso = { x: 7, y: 17, rows: [
  '....ooswwso...',
  '...okkowwokko.',
  '..okKkkwwkkKko',
  '..okkkkrrkkkko',
  '..okkokRrokkko',
  '..okkokkkkokko',
  '..owwokkkkowwo',
  '...osokkkkoso.',
  '...osokkkkoso.',
  '....o.okko.o..',
]};

// Bell skirt with lace hem (knee socks show below it).
L.skirt = { x: 4, y: 26, rows: [
  '........oooo........',
  '......ookkkkoo......',
  '.....okKkkkkkko.....',
  '....okKkkkkkkkko....',
  '...okKkkkkkkkkkko...',
  '..okkjkkjkkjkkjkkko.',
  '.owwwwwwwwwwwwwwwwwo',
  '.oWwWWwWWwWWwWWwWWWo',
  '..ooooooooooooooooo.',
]};

// Sitting skirt: spread flat and wide.
L.skirtSit = { x: 3, y: 29, rows: [
  '.........oooo.........',
  '......ookkkkkkoo......',
  '....okKkkkkkkkkkko....',
  '..okkkkkkkkkkkkkkkkko.',
  '.okkjkkjkkjkkjkkjkkkko',
  '.owwwwwwwwwwwwwwwwwwwo',
  '..oWWwWWwWWwWWwWWwWWo.',
  '...oooooooooooooooo...',
]};

// Legs: knee socks + mary janes. Row 33 hides under the skirt when standing.
L.legsStand = { x: 6, y: 33, rows: [
  '...owwo.owwo....',
  '...owwo.owwo....',
  '...owwo.owwo....',
  '...owwo.owwo....',
  '..ogGgo.ogGgo...',
  '..ogggo.ogggo...',
  '...ooo...ooo....',
]};
L.legsStrideA = { x: 6, y: 33, rows: [ // front leg steps forward
  '...owwo...owwo..',
  '...owwo...owwo..',
  '...owwo....owwo.',
  '..ogGgo....owwo.',
  '..ogggo...ogGggo',
  '...ooo....oggggo',
  '...........oooo.',
]};
L.legsStrideB = { x: 6, y: 33, rows: [ // back leg trails behind
  '.owwo...owwo....',
  '.owwo...owwo....',
  'owwo....owwo....',
  'ogGgo...owwo....',
  'ogggo..ogGgo....',
  '.ooo...ogggo....',
  '........ooo.....',
]};
L.legsSit = { x: 6, y: 35, rows: [ // dangling in front
  '........owwowwo.',
  '........owwowwo.',
  '.......ogGggGgo.',
  '.......oggggggo.',
  '........oooooo..',
]};

// Arm overlays (drawn on top of torso/skirt).
L.armPet = { x: 17, y: 20, rows: [ // right arm extended forward and down
  'okko....',
  'okkko...',
  '.okkko..',
  '..osso..',
  '...oso..',
]};
L.armWave = { x: 18, y: 12, rows: [ // right arm raised, hand open
  '.oso..',
  'osso..',
  'osko..',
  'okko..',
  'okko..',
  'okko..',
  'okko..',
  'okko..',
  'okko..',
]};
L.armsUp = { x: 5, y: 12, rows: [ // both arms up (startled / holding balloon strings)
  '.oso.............oso.',
  'osso.............osso',
  'okko.............okko',
  'okko.............okko',
  'okko.............okko',
  'okko.............okko',
  'okko.............okko',
  'okko.............okko',
  'okko.............okko',
  '.oo...............oo.',
]};
// Eye overlays paint skin over the base eyes first.
L.eyesWide = { x: 9, y: 10, rows: [
  '.EE...EE..',
  'EwweE.Ewwe',
  'Eeee..Eeee',
  '.EE...EE..',
]};
L.eyesHappy = { x: 9, y: 11, rows: [
  '.EE...EE..',
  'EssE..EssE',
  '.ss....ss.',
]};

// ---------------------------------------------------------------------------
// Frame definitions: list of [layer, dx, dy] drawn in order.
// ---------------------------------------------------------------------------
const body = (dy = 0, legs = 'legsStand', skirtDy = 0) => [
  ['hairBack', 0, dy],
  ['skirt', 0, skirtDy],
  [legs, 0, 0],
  ['torso', 0, dy],
  ['head', 0, dy],
  ['bow', 0, dy],
];

const FRAMES = {
  idle0: body(0),
  idle1: body(1),
  walk0: body(-1, 'legsStrideA', -1),
  walk1: body(0, 'legsStand', 0),
  walk2: body(-1, 'legsStrideB', -1),
  walk3: body(0, 'legsStand', 0),
  pet0: [...body(1), ['armPet', 0, 1]],
  pet1: [...body(2), ['armPet', 0, 3]],
  wave0: [...body(0), ['armWave', 0, 0]],
  wave1: [...body(0), ['armWave', 2, -1]],
  sit0: [['hairBack', 0, 3], ['skirtSit', 0, 0], ['legsSit', 0, 0], ['torso', 0, 3], ['head', 0, 3], ['bow', 0, 3]],
  startle0: [...body(-1), ['armsUp', 0, -1], ['eyesWide', 0, -1]],
  reach0: [...body(0), ['armsUp', 0, 0]],
  happy0: [...body(0), ['eyesHappy', 0, 0]],
  happy1: [...body(-1), ['eyesHappy', 0, -1]],
};

const ANIMATIONS = {
  idle:    { frames: ['idle0', 'idle1'], ms: [900, 700], loop: true },
  walk:    { frames: ['walk0', 'walk1', 'walk2', 'walk3'], ms: [140, 140, 140, 140], loop: true },
  pet:     { frames: ['pet0', 'pet1'], ms: [320, 320], loop: true },
  wave:    { frames: ['wave0', 'wave1'], ms: [260, 260], loop: true },
  sit:     { frames: ['sit0'], ms: [1000], loop: true },
  startle: { frames: ['startle0'], ms: [600], loop: false },
  reach:   { frames: ['reach0'], ms: [1000], loop: true },
  happy:   { frames: ['happy0', 'happy1'], ms: [220, 220], loop: true },
};

// ---------------------------------------------------------------------------
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

for (const [name, layer] of Object.entries(L)) {
  const widths = new Set(layer.rows.map((r) => r.length));
  if (widths.size !== 1) throw new Error(`layer ${name} has ragged rows: ${[...widths].join(',')}`);
}

function renderFrame(defs) {
  const px = new Uint8Array(W * H * 4);
  for (const [name, dx, dy] of defs) {
    const layer = L[name];
    if (!layer) throw new Error(`unknown layer ${name}`);
    layer.rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === '.') continue;
        const col = PALETTE[ch];
        if (!col) throw new Error(`unknown palette key '${ch}' in layer ${name}`);
        const x = layer.x + dx + rx;
        const y = layer.y + dy + ry;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const [r, g, b] = hex(col);
        const i = (y * W + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
    });
  }
  return px;
}

const names = Object.keys(FRAMES);
const sheet = new PNG({ width: W * names.length, height: H });
names.forEach((name, n) => {
  const px = renderFrame(FRAMES[name]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = (y * sheet.width + n * W + x) * 4;
      sheet.data[di] = px[si]; sheet.data[di + 1] = px[si + 1]; sheet.data[di + 2] = px[si + 2]; sheet.data[di + 3] = px[si + 3];
    }
  }
});

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'girl');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'girl.png'), PNG.sync.write(sheet));
const manifest = {
  file: 'girl/girl.png',
  w: W,
  h: H,
  anchor: { x: W / 2, y: H },
  frames: Object.fromEntries(names.map((n, i) => [n, i])),
  animations: ANIMATIONS,
};
fs.writeFileSync(path.join(OUT, 'girl.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'girl.js'), `window.LUNA_GIRL = ${JSON.stringify(manifest)};\n`);
console.log(`girl sheet: ${names.length} frames (${sheet.width}x${sheet.height}) -> ${path.relative(process.cwd(), OUT)}`);

if (process.argv.includes('--preview')) {
  const scale = 6;
  const prev = new PNG({ width: sheet.width * scale, height: sheet.height * scale });
  for (let y = 0; y < prev.height; y++) {
    for (let x = 0; x < prev.width; x++) {
      const si = ((y / scale | 0) * sheet.width + (x / scale | 0)) * 4;
      const di = (y * prev.width + x) * 4;
      const a = sheet.data[si + 3];
      prev.data[di] = a ? sheet.data[si] : 0x30; prev.data[di + 1] = a ? sheet.data[si + 1] : 0x30;
      prev.data[di + 2] = a ? sheet.data[si + 2] : 0x40; prev.data[di + 3] = 255;
    }
  }
  const cache = path.join(__dirname, '..', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'girl-preview.png'), PNG.sync.write(prev));
  console.log('preview: .cache/girl-preview.png');
}
