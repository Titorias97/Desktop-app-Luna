/* The director runs little "scenes" (generator functions) that choreograph
 * Luna and her Pokémon: petting, pranks, rides, naps. A scene yields either a
 * number of seconds to wait or a condition object from until(). */
(function (Luna) {
  'use strict';
  const { rnd, rndInt, pick, chance, clamp, dist } = Luna.util;

  const until = (fn, timeout = 20) => ({ fn, timeout });

  class Director {
    constructor(world) {
      this.world = world;
      this.current = null;
      this.wait = 0;
      this.cond = null;
      this.cooldown = 5;
      this.lastRun = {};
    }

    start(name, gen) {
      this.cancel();
      this.current = { name, gen };
      this.wait = 0;
      this.cond = null;
      this.lastRun[name] = this.world.time;
    }

    cancel() {
      if (this.current) {
        try { this.current.gen.return(); } catch (e) { /* ignore */ }
        this.current = null;
      }
      this.world.releaseAll();
      this.cooldown = rnd(this.world.rng, 6, 14);
    }

    update(dt) {
      if (!this.current) {
        this.cooldown -= dt;
        if (this.cooldown <= 0) this.pickScene();
        return;
      }
      if (this.wait > 0) { this.wait -= dt; return; }
      if (this.cond) {
        this.cond.timeout -= dt;
        if (!this.cond.fn() && this.cond.timeout > 0) return;
        this.cond = null;
      }
      let r;
      try { r = this.current.gen.next(); } catch (e) { console.error('scene error', e); r = { done: true }; }
      if (r.done) { this.current = null; this.world.releaseAll(); this.cooldown = rnd(this.world.rng, 8, 18); return; }
      if (typeof r.value === 'number') this.wait = r.value;
      else if (r.value && typeof r.value.fn === 'function') this.cond = r.value;
    }

    pickScene() {
      const w = this.world;
      const hour = new Date().getHours();
      const since = (n) => w.time - (this.lastRun[n] ?? -1e9);
      const options = [
        ['visit', 5, () => true],
        ['benchRest', 2, () => since('benchRest') > 90],
        ['gengarPrank', 2.2, () => since('gengarPrank') > 100],
        ['mamoswineRide', 1.6, () => since('mamoswineRide') > 160],
        ['drifblimRide', 1.6, () => since('drifblimRide') > 150],
        ['altariaLanding', 1.6, () => since('altariaLanding') > 120 && w.pokemon['altaria-mega'].mode === 'fly'],
        ['froslassWaltz', 1.5, () => since('froslassWaltz') > 110],
        ['piplupParade', 1.5, () => since('piplupParade') > 80],
        ['piplupKick', 1.4, () => since('piplupKick') > 100],
        ['lunatoneVisit', 1.3, () => since('lunatoneVisit') > 140],
        ['chandelureLight', 1.2, () => since('chandelureLight') > 90],
        ['nap', hour >= 1 && hour < 6 ? 6 : 0.3, () => since('nap') > 240],
      ].filter(([, , ok]) => ok());
      const total = options.reduce((a, o) => a + o[1], 0);
      let r = w.rng() * total;
      for (const [name, weight] of options) {
        r -= weight;
        if (r <= 0) { this.start(name, SCENES[name](w)); return; }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers used by scenes
  function* walkGirlTo(w, x, y, timeout = 25) {
    w.girl.goTo(x, y);
    yield until(() => w.girl.arrived, timeout);
    if (!w.girl.arrived) w.girl.stop();
  }
  function* moveTo(w, mon, x, y, timeout = 25, speedMul = 1) {
    mon.busy = true;
    mon.wanderTarget = null;
    let done = false;
    const step = (dt) => { if (!done) done = mon.stepToward(x, y, dt, mon.speed * speedMul); };
    w.steppers.add(step);
    yield until(() => done, timeout);
    w.steppers.delete(step);
  }
  const groundMon = (w) => Object.values(w.pokemon).filter((m) => !m.airborne && !m.busy && m.cfg.zone === 'ground');
  const spotNear = (w, mon, side) => ({ x: clamp(mon.x + side * (mon.w / 2 + 12), w.zone.x0, w.zone.x1), y: clamp(mon.y + 2, w.zone.y0, w.zone.y1) });

  function* petPokemon(w, mon, seconds = 2.6) {
    mon.busy = true;
    mon.wanderTarget = null;
    const side = w.girl.x < mon.x ? -1 : 1;
    const spot = spotNear(w, mon, side);
    yield* walkGirlTo(w, spot.x, spot.y);
    yield* petHere(w, mon, seconds);
  }

  /** Luna and the Pokémon walk toward each other and meet halfway, then she pets it. */
  function* meetAndPet(w, mon, seconds = 2.2) {
    const girl = w.girl;
    mon.busy = true;
    mon.wanderTarget = null;
    const side = girl.x < mon.x ? -1 : 1; // which side of the Pokémon Luna is on
    const gap = mon.w / 2 + 12;
    const midX = (girl.x + mon.x) / 2;
    const midY = clamp((girl.y + mon.y) / 2, w.zone.y0, w.zone.y1);
    girl.goTo(clamp(midX + side * (gap / 2), w.zone.x0, w.zone.x1), midY);
    yield* moveTo(w, mon, clamp(midX - side * (gap / 2), w.zone.x0, w.zone.x1), clamp(midY + 2, w.zone.y0, w.zone.y1), 20, mon.cfg.lazy ? 1.8 : 1.5);
    yield until(() => girl.arrived, 20);
    if (!girl.arrived) girl.stop();
    yield* petHere(w, mon, seconds);
  }

  /** The petting itself, once Luna stands next to the Pokémon. */
  function* petHere(w, mon, seconds) {
    w.girl.faceToward(mon.x);
    mon.faceToward(w.girl.x);
    w.girl.pose('pet');
    yield 0.6;
    mon.react('love');
    for (let i = 0; i < seconds / 0.8; i++) {
      w.particles.spawn('heartSmall', mon.centerX + rnd(w.rng, -6, 6), mon.topY, {});
      yield 0.8;
    }
    w.girl.pose('happy');
    yield 1.2;
    w.girl.stop();
  }

  const SCENES = {
    *visit(w) {
      const candidates = groundMon(w);
      if (!candidates.length) return;
      const mon = pick(w.rng, candidates);
      yield* petPokemon(w, mon);
    },

    *benchRest(w) {
      const b = w.bg.benchSpot;
      yield* walkGirlTo(w, b.x + 2, b.y + 1);
      w.girl.busy = true;
      w.girl.pose('sit');
      w.girl.facing = 1;
      w.girl.hover = 6; // up on the seat
      const esp = w.pokemon.espeon;
      yield* moveTo(w, esp, b.x - 36, b.y - 2, 12);
      esp.faceToward(b.x);
      for (let i = 0; i < 6; i++) {
        if (chance(w.rng, 0.4)) w.particles.spawn('note', w.girl.centerX + 6, w.girl.topY, {});
        yield 2.5;
      }
      w.girl.stop();
    },

    *nap(w) {
      const b = w.bg.benchSpot;
      yield* walkGirlTo(w, b.x + 2, b.y + 1);
      w.girl.busy = true;
      w.girl.pose('sit');
      w.girl.hover = 6;
      const esp = w.pokemon.espeon;
      const pip = w.pokemon.piplup;
      yield* moveTo(w, esp, b.x - 36, b.y - 2, 12);
      yield* moveTo(w, pip, b.x + 26, b.y + 2, 12);
      esp.faceToward(b.x); pip.faceToward(b.x);
      for (let i = 0; i < 24; i++) {
        w.particles.spawn('zz', w.girl.centerX + 8, w.girl.topY - 2, {});
        if (i % 3 === 0) w.particles.spawn('zz', pip.centerX + 4, pip.topY, {});
        yield 2.4;
      }
      w.girl.stop();
    },

    *gengarPrank(w) {
      const g = w.pokemon.gengar;
      const girl = w.girl;
      g.busy = true;
      g.wanderTarget = null;
      // fade out, sneak behind her, fade in and BOO
      for (let a = g.alpha; a > 0; a -= 0.1) { g.alpha = Math.max(0, a); yield 0.05; }
      yield 1.2;
      g.x = clamp(girl.x - girl.facing * 26, w.zone.x0, w.zone.x1);
      g.y = clamp(girl.y + 1, w.zone.y0, w.zone.y1);
      g.faceToward(girl.x);
      for (let a = 0; a <= 0.9; a += 0.1) { g.alpha = a; yield 0.05; }
      g.alpha = 0.9;
      g.hop(140);
      yield 0.25;
      girl.busy = true;
      girl.pose('startle');
      girl.facing = -girl.facing;
      w.bubbles.show(girl, 'bang', 1.2);
      w.particles.spawn('bang', girl.centerX + 10, girl.topY - 2, { life: 0.8 });
      girl.hop(90);
      yield 1.4;
      girl.pose('happy');
      g.hop(100);
      w.particles.burst('heartSmall', g.centerX, g.topY, 3);
      yield 1.6;
      girl.stop();
      g.alpha = g.cfg.alpha;
    },

    *mamoswineRide(w) {
      const m = w.pokemon.mamoswine;
      const girl = w.girl;
      m.busy = true; m.wanderTarget = null;
      const side = girl.x < m.x ? -1 : 1;
      yield* walkGirlTo(w, m.x + side * (m.w / 2 + 6), m.y + 2);
      girl.busy = true;
      girl.faceToward(m.x);
      girl.hop(160);
      yield 0.3;
      // mount
      girl.pose('sit');
      const ride = { on: true };
      const seatH = m.h * 0.6;
      const dir = chance(w.rng, 0.5) ? 1 : -1;
      const dest = { x: clamp(m.x + dir * rnd(w.rng, 120, 220), w.zone.x0 + 50, w.zone.x1 - 50), y: clamp(m.y + rnd(w.rng, -20, 20), w.zone.y0, w.zone.y1) };
      let arrived = false;
      const step = (dt) => {
        if (!arrived) arrived = m.stepToward(dest.x, dest.y, dt, m.speed * 0.8);
        girl.x = m.x - m.facing * 12; // sits toward the back
        girl.y = m.y + 0.5;
        girl.hover = seatH + m.bob + (arrived ? 0 : Math.abs(Math.sin(w.time * 6)) * 2);
        girl.facing = m.facing;
      };
      w.steppers.add(step);
      yield 1.0;
      yield until(() => arrived, 30);
      yield 1.5;
      w.steppers.delete(step);
      girl.hover = 0;
      girl.x = m.x - m.facing * (m.w / 2 + 6);
      girl.y = m.y + 2;
      girl.pose('happy');
      girl.hop(120);
      yield 1.3;
      girl.stop();
      m.restTimer = 20;
    },

    *drifblimRide(w) {
      const d = w.pokemon.drifblim;
      const girl = w.girl;
      d.busy = true; d.wanderTarget = null;
      const target = { x: girl.x, y: girl.y + 0.5 };
      // Drifblim floats over, lowers its ropes
      yield* moveTo(w, d, target.x, target.y, 20, 1.6);
      girl.busy = true;
      girl.pose('reach');
      const handH = girl.h - 8; // Drifblim's feet reach her raised hands
      let t = 0;
      const dir = chance(w.rng, 0.5) ? 1 : -1;
      const step = (dt) => {
        t += dt;
        const lift = t < 1 ? 0 : t < 4 ? (t - 1) / 3 * 26 : t < 9 ? 26 : Math.max(0, 26 - (t - 9) / 2.5 * 26);
        d.hover = handH + lift;
        girl.hover = lift;
        if (t > 2 && t < 10) { girl.x = clamp(girl.x + dir * 9 * dt, w.zone.x0 + 20, w.zone.x1 - 20); }
        d.x = girl.x;
        d.y = girl.y + 0.5;
        girl.facing = dir;
      };
      w.steppers.add(step);
      yield 12;
      w.steppers.delete(step);
      girl.hover = 0;
      d.hover = d.cfg.hover;
      girl.pose('happy');
      w.particles.burst('heartSmall', girl.centerX, girl.topY, 3);
      yield 1.4;
      girl.stop();
    },

    *altariaLanding(w) {
      const a = w.pokemon['altaria-mega'];
      const girl = w.girl;
      a.busy = true;
      const spot = { x: clamp(girl.x + (girl.facing || 1) * 70, w.zone.x0 + 40, w.zone.x1 - 40), y: clamp(girl.y, w.zone.y0, w.zone.y1) };
      // glide down
      yield* moveTo(w, a, spot.x, spot.y - 30, 20, 1.4);
      yield* moveTo(w, a, spot.x, spot.y, 10, 0.6);
      a.airborne = false; a.shadow = true; a.mode = 'rest';
      w.particles.burst('note', a.centerX, a.topY, 3);
      yield* petPokemon(w, a, 3);
      // take off
      a.busy = true;
      w.particles.burst('note', a.centerX, a.topY, 2);
      yield* moveTo(w, a, spot.x - 60, w.layout.horizon * 0.5, 20, 1.4);
      a.airborne = true; a.shadow = false; a.mode = 'fly';
    },

    *froslassWaltz(w) {
      const f = w.pokemon['froslass-mega'];
      const girl = w.girl;
      f.busy = true; f.wanderTarget = null;
      yield* moveTo(w, f, girl.x + 40, girl.y, 15, 1.3);
      girl.busy = true;
      girl.faceToward(f.x);
      girl.pose('happy');
      let t = 0;
      const cx = girl.x, cy = girl.y;
      const step = (dt) => {
        t += dt;
        f.x = cx + Math.cos(t * 1.1) * 42;
        f.y = clamp(cy + Math.sin(t * 1.1) * 12, w.zone.y0, w.zone.y1);
        f.facing = Math.sin(t * 1.1) > 0 ? 1 : -1;
        girl.facing = f.x > girl.x ? 1 : -1;
      };
      w.steppers.add(step);
      for (let i = 0; i < 8; i++) { w.particles.burst('snow', f.centerX, f.centerY, 3); yield 1; }
      w.steppers.delete(step);
      w.bubbles.show(girl, 'heart', 1.5);
      yield 1.2;
      girl.stop();
    },

    *piplupParade(w) {
      const p = w.pokemon.piplup;
      const girl = w.girl;
      p.busy = true; p.wanderTarget = null;
      girl.busy = true;
      girl.pose('idle');
      let t = 0;
      const cx = girl.x, cy = girl.y;
      const step = (dt) => {
        t += dt;
        p.x = cx + Math.cos(t * 1.6) * 30;
        p.y = clamp(cy + 1 + Math.sin(t * 1.6) * 9, w.zone.y0, w.zone.y1);
        p.facing = -Math.sin(t * 1.6) > 0 ? 1 : -1;
        girl.facing = p.x > girl.x ? 1 : -1;
      };
      w.steppers.add(step);
      for (let i = 0; i < 7; i++) { p.hop(70); if (i === 3) { girl.pose('happy'); w.particles.burst('note', p.centerX, p.topY, 2); } yield 0.9; }
      w.steppers.delete(step);
      w.bubbles.show(p, 'heart', 1.4);
      yield 1.2;
      girl.stop();
    },

    /** Luna punts Piplup across the garden; it tumbles into the wall, sees stars, and waddles back. */
    *piplupKick(w) {
      const p = w.pokemon.piplup;
      const girl = w.girl;
      p.busy = true; p.wanderTarget = null;
      // Walk up behind it.
      const side = girl.x < p.x ? -1 : 1;
      yield* walkGirlTo(w, clamp(p.x + side * (p.w / 2 + 10), w.zone.x0, w.zone.x1), clamp(p.y + 1, w.zone.y0, w.zone.y1), 12);
      girl.busy = true;
      girl.faceToward(p.x);
      p.faceToward(girl.x);
      // Wind-up ... (with a few choice words)
      girl.pose('pet');
      w.bubbles.show(girl, { text: 'Putita' }, 1.6);
      yield 0.55;
      // ... KICK.
      const dir = girl.facing;
      girl.pose('reach');
      girl.hop(70);
      w.particles.spawn('bang', p.centerX, p.topY - 2, { life: 0.7 });
      w.bubbles.show(p, 'bang', 0.9);
      p.hop(150);
      let vx = dir * 210;
      let hits = 0;
      let rolling = true;
      const step = (dt) => {
        if (!rolling) return;
        p.x += vx * dt;
        p.roll += (vx / 11) * dt;
        p.facing = dir;
        const wallL = w.zone.x0 + p.w / 2, wallR = w.zone.x1 - p.w / 2;
        if (p.x <= wallL || p.x >= wallR) {
          // Thud against the wall: bounce back, slower.
          p.x = clamp(p.x, wallL, wallR);
          vx = -vx * 0.45;
          hits++;
          p.hop(60);
          w.particles.spawn('bang', p.centerX + (p.x <= wallL + 1 ? -6 : 6), p.topY, { life: 0.5 });
          w.particles.burst('dust', p.centerX, p.y, 4);
        }
        if (p.z <= 0.01) vx *= Math.max(0, 1 - 1.1 * dt); // ground friction
        if (Math.abs(vx) < 12 && p.z <= 0.01) { rolling = false; vx = 0; }
      };
      w.steppers.add(step);
      yield until(() => !rolling, 6);
      w.steppers.delete(step);
      rolling = false;
      // Lands on its feet eventually.
      p.roll = 0;
      girl.pose('happy');
      // Dizzy: stars circle its head.
      for (let i = 0; i < 4; i++) { w.particles.spawn('sparkleSmall', p.centerX + Math.cos(i * 1.6) * 8, p.topY - 2, { life: 0.8, vy: -4 }); yield 0.45; }
      // Luna feels a little bad (or does she?), waves it back over.
      girl.pose('wave');
      yield 0.8;
      yield* moveTo(w, p, girl.x - dir * (p.w / 2 + 12), girl.y + 2, 10, 2.4);
      p.faceToward(girl.x);
      p.hop(50);
      w.bubbles.show(p, 'heart', 1.2);
      yield 1.2;
      girl.stop();
    },

    *lunatoneVisit(w) {
      const l = w.pokemon.lunatone;
      const girl = w.girl;
      l.busy = true;
      girl.busy = true;
      girl.pose('idle');
      const spot = { x: girl.x + 30, y: girl.y + 0.5 };
      const origHover = l.hover;
      l.hover = 18;
      l.shadow = true;
      yield* moveTo(w, l, spot.x, spot.y, 20, 2.2);
      girl.faceToward(l.x);
      girl.pose('wave');
      for (let i = 0; i < 4; i++) { w.particles.burst('sparkle', l.centerX, l.centerY, 2); yield 0.8; }
      w.bubbles.show(girl, 'heart', 1.4);
      yield 1;
      girl.stop();
      yield* moveTo(w, l, w.bg.moon.x, w.bg.moon.y + origHover, 20, 2.2);
      l.hover = origHover;
      l.shadow = false;
      l.mode = 'orbit';
    },

    *chandelureLight(w) {
      const c = w.pokemon.chandelure;
      const girl = w.girl;
      c.busy = true; c.wanderTarget = null;
      yield* moveTo(w, c, girl.x - girl.facing * 34, girl.y + 0.5, 15, 1.4);
      girl.busy = true;
      girl.faceToward(c.x);
      girl.pose('reach');
      for (let i = 0; i < 5; i++) { c.glowBoost = 1.6; w.particles.spawn('sparkleSmall', c.centerX + rnd(w.rng, -12, 12), c.topY + 10, {}); yield 1; }
      girl.pose('happy');
      w.bubbles.show(girl, 'heart', 1.3);
      yield 1.2;
      girl.stop();
    },

    // -- user triggered ------------------------------------------------------
    *userVisit(w, mon) { yield* petPokemon(w, mon, 2); },
    *userMeet(w, mon) { yield* meetAndPet(w, mon, 2.2); },
    *userWave(w) {
      const girl = w.girl;
      girl.busy = true;
      girl.walkTarget = null;
      girl.pose('wave');
      w.bubbles.show(girl, 'heart', 1.5);
      w.particles.burst('heartSmall', girl.centerX, girl.topY, 3);
      for (const m of groundMon(w)) if (dist(m.x, m.y, girl.x, girl.y) < 90) m.hop(80);
      yield 1.6;
      girl.stop();
    },
    *userWalk(w, x, y) {
      yield* walkGirlTo(w, x, y, 30);
      w.girl.busy = true;
      if (chance(w.rng, 0.4)) { w.girl.pose('happy'); yield 1; }
      w.girl.stop();
    },
  };

  Luna.Director = Director;
  Luna.SCENES = SCENES;
  Luna.until = until;
})(window.Luna);
