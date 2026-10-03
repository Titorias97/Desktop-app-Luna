/**
 * Renders the wallpaper in headless Chromium, drives the cursor, runs every
 * director scene and saves screenshots to test/output/. Fails on any page error.
 *
 *   npm test
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page_url = pathToFileURL(path.join(root, 'src', 'renderer', 'index.html')).href;
const out = path.join(root, 'test', 'output');
fs.mkdirSync(out, { recursive: true });

const sizes = [[1920, 1080], [1366, 768], [2560, 1440]];
const browser = await chromium.launch();
const errors = [];
let shots = 0;

for (const [width, height] of sizes) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(`${width}x${height}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${width}x${height}: console: ${m.text()}`); });
  await page.goto(`${page_url}?debug=1&seed=7`);
  await page.waitForSelector('body.ready', { timeout: 15000 });
  const ff = (s) => page.evaluate((sec) => window.Luna.app.fastForward(sec), s);
  const shot = async (name) => { await page.screenshot({ path: path.join(out, `${width}x${height}-${name}.png`) }); shots++; };

  await ff(3);
  await shot('01-idle');
  if (width !== 1920) { await page.close(); continue; }

  // Hover over Gengar: it should notice (hop + sparkles).
  const gengar = await page.evaluate(() => { const g = window.Luna.app.world.pokemon.gengar; const s = window.Luna.app.world.scale; return { x: g.centerX * s, y: g.centerY * s }; });
  await page.mouse.move(gengar.x, gengar.y);
  await ff(0.3);
  await shot('02-hover-gengar');

  // Click on Piplup: Luna walks over and pets it.
  const piplup = await page.evaluate(() => { const p = window.Luna.app.world.pokemon.piplup; const s = window.Luna.app.world.scale; return { x: p.centerX * s, y: p.centerY * s }; });
  await page.mouse.click(piplup.x, piplup.y);
  await ff(6);
  await shot('03-click-piplup');

  // Every scripted scene, fast-forwarded.
  const scenes = ['gengarPrank', 'mamoswineRide', 'drifblimRide', 'altariaLanding', 'froslassWaltz', 'piplupParade', 'lunatoneVisit', 'chandelureLight', 'benchRest', 'nap', 'userWave'];
  let n = 10;
  for (const name of scenes) {
    await page.evaluate((nm) => { const w = window.Luna.app.world; w.director.start(nm, window.Luna.SCENES[nm](w)); }, name);
    const mid = { gengarPrank: 2.2, mamoswineRide: 9, drifblimRide: 6, altariaLanding: 9, froslassWaltz: 7, piplupParade: 5, lunatoneVisit: 7, chandelureLight: 6, benchRest: 7, nap: 9, userWave: 0.6 }[name];
    await ff(mid);
    await shot(`${n++}-scene-${name}`);
    await ff(30); // let the scene finish and release everyone
  }
  // Long idle run to shake out errors in the autonomous director.
  await ff(600);
  await shot('99-after-10min');
  const state = await page.evaluate(() => { const w = window.Luna.app.world; return { time: w.time, scene: w.director.current && w.director.current.name, particles: w.particles.list.length, girl: [w.girl.x | 0, w.girl.y | 0, w.girl.state] }; });
  console.log('final state', JSON.stringify(state));
  await page.close();
}
await browser.close();
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log(`ok: ${shots} screenshots in test/output/`);
