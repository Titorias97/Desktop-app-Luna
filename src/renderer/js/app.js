/* Boot, world assembly, input and the frame loop. Works as a plain web page
 * (browser preview, Lively Wallpaper, Wallpaper Engine) and inside Electron,
 * where window.luna (see src/main/preload.js) feeds cursor events in. */
(function (Luna) {
  'use strict';
  const { clamp, rnd, makeRng, dist } = Luna.util;
  const { Girl, Pokemon, Particles, Bubbles } = Luna.entities;

  const POKEMON_ORDER = ['gengar', 'chandelure', 'froslass-mega', 'altaria-mega', 'piplup', 'drifblim', 'mamoswine', 'lunatone', 'espeon'];

  const params = new URLSearchParams(location.search);
  const settings = {
    scale: Number(params.get('scale')) || 0, // 0 = auto
    bottomInset: params.has('inset') ? Number(params.get('inset')) : 48, // physical px kept free for the taskbar
    interactive: params.get('interactive') !== '0',
    fps: Number(params.get('fps')) || 30,
    debug: params.get('debug') === '1',
    seed: Number(params.get('seed')) || 0,
  };

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  let world = null;
  let paused = false;
  let assets = null;

  // ---------------------------------------------------------------------------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load ${src}`));
      img.src = src;
    });
  }

  async function loadAssets() {
    const pokemonMeta = window.LUNA_POKEMON;
    const girlMeta = window.LUNA_GIRL;
    if (!pokemonMeta || !girlMeta) throw new Error('asset manifests missing — run `npm run assets`');
    const images = {};
    await Promise.all([
      ...POKEMON_ORDER.map(async (id) => { images[id] = await loadImage(`assets/${pokemonMeta[id].file}`); }),
      (async () => { images.girl = await loadImage(`assets/${girlMeta.file}`); })(),
    ]);
    return { pokemonMeta, girlMeta, images };
  }

  // ---------------------------------------------------------------------------
  /** Integer scale in *physical* pixels so the art stays crisp on 125%/150% DPI displays. */
  function computeScale() {
    const dpr = window.devicePixelRatio || 1;
    const physScale = settings.scale || clamp(Math.round((window.innerHeight * dpr) / 360), 2, 8);
    return { physScale, cssScale: physScale / dpr, dpr };
  }

  function buildWorld() {
    const { physScale, cssScale, dpr } = computeScale();
    const W = Math.ceil((window.innerWidth * dpr) / physScale);
    const H = Math.ceil((window.innerHeight * dpr) / physScale);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W * cssScale}px`;
    canvas.style.height = `${H * cssScale}px`;
    ctx.imageSmoothingEnabled = false;

    const scale = cssScale; // CSS px per logical pixel (pointer conversion)
    const inset = Math.ceil(settings.bottomInset / physScale);
    const layout = {
      horizon: Math.round(H * 0.56),
      groundTop: Math.round(H * 0.7),
      groundBottom: Math.max(Math.round(H * 0.7) + 30, H - inset - 4),
    };
    const seed = settings.seed || 20241031;
    const rng = makeRng(seed ^ 0x9e3779b9);
    const w = {
      W, H, scale, physScale, layout, rng, settings,
      zone: { x0: 18, x1: W - 18, y0: layout.groundTop + 8, y1: layout.groundBottom },
      time: 0,
      pointer: { x: -1, y: -1, present: false },
      steppers: new Set(),
      entities: [],
      pokemon: {},
    };
    w.bg = new Luna.Background(W, H, layout, seed);
    w.particles = new Particles(w);
    w.bubbles = new Bubbles(w);
    w.girl = new Girl(w, assets.images.girl, assets.girlMeta);
    w.girl.x = Math.round(W * 0.5);
    w.girl.y = Math.round((w.zone.y0 + w.zone.y1) / 2);
    w.entities.push(w.girl);
    POKEMON_ORDER.forEach((id, i) => {
      const mon = new Pokemon(w, id, assets.images[id], assets.pokemonMeta[id]);
      if (mon.cfg.zone === 'sky') {
        mon.x = rnd(rng, 60, W - 60);
        mon.y = rnd(rng, layout.horizon * 0.3, layout.horizon * 0.8);
      } else {
        mon.x = clamp(Math.round((W / (POKEMON_ORDER.length + 1)) * (i + 1) + rnd(rng, -20, 20)), w.zone.x0 + 10, w.zone.x1 - 10);
        mon.y = rnd(rng, w.zone.y0, w.zone.y1);
      }
      w.pokemon[id] = mon;
      w.entities.push(mon);
    });
    w.director = new Luna.Director(w);
    w.releaseAll = () => releaseAll(w);
    // Vignette
    const v = document.createElement('canvas');
    v.width = W; v.height = H;
    const vg = v.getContext('2d');
    const grad = vg.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    grad.addColorStop(0, 'rgba(5,3,10,0)');
    grad.addColorStop(1, 'rgba(5,3,10,0.55)');
    vg.fillStyle = grad;
    vg.fillRect(0, 0, W, H);
    w.vignette = v;
    return w;
  }

  function releaseAll(w) {
    w.steppers.clear();
    const g = w.girl;
    g.busy = false;
    g.hover = 0;
    if (!g.walkTarget) g.stop();
    for (const m of Object.values(w.pokemon)) {
      m.busy = false;
      m.hover = m.cfg.hover;
      if (m.cfg.alpha) m.alpha = m.cfg.alpha;
      if (m.cfg.kind === 'flyer') { m.airborne = true; m.shadow = false; m.mode = 'fly'; m.wanderTarget = null; }
      else if (m.cfg.orbit) { m.airborne = true; m.shadow = false; m.mode = 'orbit'; }
    }
  }

  // ---------------------------------------------------------------------------
  function handleClick(x, y) {
    if (!world || !settings.interactive) return;
    const w = world;
    // Topmost (nearest) entity under the cursor wins.
    const hits = w.entities.filter((e) => e.contains(x, y, 2)).sort((a, b) => b.sortY - a.sortY);
    const hit = hits[0];
    if (hit === w.girl) {
      w.director.start('userWave', Luna.SCENES.userWave(w));
    } else if (hit) {
      hit.react('love');
      if (!hit.airborne) w.director.start('userVisit', Luna.SCENES.userVisit(w, hit));
    } else {
      // Walk there (clamped into the garden), scatter sparkles where she clicked.
      w.particles.burst('sparkleSmall', x, y, 3);
      w.director.start('userWalk', Luna.SCENES.userWalk(w, x, y + 8));
    }
  }

  function setPointer(px, py, present) {
    if (!world) return;
    world.pointer.present = present;
    if (present) {
      world.pointer.x = px / world.scale;
      world.pointer.y = py / world.scale;
    }
  }

  function bindInput() {
    if (window.luna && window.luna.onPointer) {
      window.luna.onPointer((p) => {
        setPointer(p.x, p.y, p.present);
        if (p.click && p.present) handleClick(p.x / world.scale, p.y / world.scale);
      });
      window.luna.onPause((v) => { paused = v; });
      window.luna.onSettings((s) => applySettings(s));
    }
    // DOM events (browser preview, Lively, Wallpaper Engine; also Electron dev windows)
    window.addEventListener('mousemove', (e) => setPointer(e.clientX, e.clientY, true));
    window.addEventListener('mouseleave', () => setPointer(0, 0, false));
    document.addEventListener('mouseleave', () => setPointer(0, 0, false));
    window.addEventListener('mousedown', (e) => { if (e.button === 0 && world) handleClick(e.clientX / world.scale, e.clientY / world.scale); });
    window.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t && world) handleClick(t.clientX / world.scale, t.clientY / world.scale); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) lastFrame = 0; });
    let resizeTimer = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { world = buildWorld(); }, 250); });
  }

  function applySettings(s) {
    let rebuild = false;
    if (s.scale !== undefined && s.scale !== settings.scale) { settings.scale = s.scale; rebuild = true; }
    if (s.bottomInset !== undefined && s.bottomInset !== settings.bottomInset) { settings.bottomInset = s.bottomInset; rebuild = true; }
    if (s.interactive !== undefined) settings.interactive = s.interactive;
    if (s.fps !== undefined && s.fps) settings.fps = s.fps;
    if (rebuild && assets) world = buildWorld();
  }

  // ---------------------------------------------------------------------------
  let lastFrame = 0;
  let fpsCounter = { frames: 0, t: 0, value: 0 };

  function update(w, dt) {
    w.time += dt;
    w.bg.update(dt);
    w.director.update(dt);
    for (const fn of w.steppers) fn(dt);
    for (const e of w.entities) e.update(dt);
    w.particles.update(dt);
    w.bubbles.update(dt);
  }

  function render(w) {
    w.bg.drawBack(ctx);
    const air = w.entities.filter((e) => e.airborne);
    for (const e of air) e.draw(ctx);
    const ground = w.entities.filter((e) => !e.airborne);
    for (const e of ground) e.drawShadow(ctx);
    const sortable = [...w.bg.props.map((p) => ({ y: p.y, draw: (c) => p.draw(c) })), ...ground.map((e) => ({ y: e.sortY, draw: (c) => e.draw(c) }))];
    sortable.sort((a, b) => a.y - b.y);
    for (const s of sortable) s.draw(ctx);
    w.particles.draw(ctx);
    w.bubbles.draw(ctx);
    w.bg.drawFront(ctx);
    ctx.drawImage(w.vignette, 0, 0);
    if (settings.debug) {
      ctx.fillStyle = '#fff';
      ctx.font = '8px monospace';
      ctx.fillText(`${fpsCounter.value} fps  scene:${w.director.current ? w.director.current.name : '-'}  ptr:${w.pointer.present ? `${w.pointer.x | 0},${w.pointer.y | 0}` : '-'}`, 3, 9);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused || document.hidden || !world) return;
    const interval = 1000 / settings.fps;
    if (now - lastFrame < interval - 2) return;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / settings.fps;
    lastFrame = now;
    update(world, dt);
    render(world);
    fpsCounter.frames++;
    fpsCounter.t += dt;
    if (fpsCounter.t >= 1) { fpsCounter.value = fpsCounter.frames; fpsCounter.frames = 0; fpsCounter.t = 0; }
  }

  /** Advances the simulation without rendering (used by the screenshot tests). */
  function fastForward(seconds, step = 1 / 30) {
    if (!world) return;
    for (let t = 0; t < seconds; t += step) update(world, step);
    render(world);
  }

  async function boot() {
    try {
      assets = await loadAssets();
      world = buildWorld();
      bindInput();
      requestAnimationFrame(frame);
      document.body.classList.add('ready');
      if (window.luna && window.luna.ready) window.luna.ready();
    } catch (err) {
      console.error(err);
      const el = document.getElementById('error');
      el.textContent = String(err.message || err);
      el.style.display = 'block';
    }
  }

  Luna.app = { get world() { return world; }, settings, fastForward, handleClick, setPointer, applySettings };
  boot();
})(window.Luna);
