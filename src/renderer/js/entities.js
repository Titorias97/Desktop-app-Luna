/* Characters: Luna (the girl), her Pokémon, particles and speech bubbles. */
(function (Luna) {
  'use strict';
  const { clamp, dist, sign, rnd, rndInt, pick, chance, approach, lerp } = Luna.util;
  const { Sheet, Animator, animatorFromSequence, drawIcon, drawGlow, fillEllipse } = Luna.sprites;

  const GRAVITY = 420; // px/s² for hops

  // ---------------------------------------------------------------------------
  class Entity {
    constructor(world, id, sheet, anim, opts = {}) {
      this.world = world;
      this.id = id;
      this.sheet = sheet;
      this.anim = anim;
      this.x = opts.x || 0;
      this.y = opts.y || 0; // ground anchor (feet / shadow)
      this.hover = opts.hover || 0; // resting height above the ground
      this.bobAmp = opts.bobAmp || 0;
      this.bobPeriod = opts.bobPeriod || 3;
      this.bobPhase = rnd(world.rng, 0, Math.PI * 2);
      this.bob = 0;
      this.z = 0; // hop height
      this.vz = 0;
      this.facing = opts.facing || -1;
      this.baseFacing = opts.baseFacing || -1; // direction the sheet art faces
      this.alpha = 1;
      this.speed = opts.speed || 20;
      this.target = null;
      this.busy = false; // controlled by the director
      this.shadow = opts.shadow !== false;
      this.sortBias = 0;
      this.spin = 0;
      this.time = 0;
    }
    get w() { return this.sheet.w; }
    get h() { return this.sheet.h; }
    get lift() { return this.hover + this.bob + this.z; }
    get drawX() { return this.x; }
    get drawY() { return this.y - this.lift; }
    get sortY() { return this.y + this.sortBias; }
    get flip() {
      const f = this.spin > 0 ? (Math.floor(this.spin * 12) % 2 ? -this.facing : this.facing) : this.facing;
      return f !== this.baseFacing;
    }
    bounds(pad = 0) {
      return { x: this.drawX - this.w / 2 - pad, y: this.drawY - this.h - pad, w: this.w + pad * 2, h: this.h + pad * 2 };
    }
    contains(px, py, pad = 0) {
      const b = this.bounds(pad);
      return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    }
    get centerX() { return this.drawX; }
    get centerY() { return this.drawY - this.h / 2; }
    get topY() { return this.drawY - this.h; }

    faceToward(x) {
      if (Math.abs(x - this.x) > 1) this.facing = sign(x - this.x);
    }
    hop(power = 110) {
      if (this.z <= 0.01) this.vz = power;
    }
    /** Moves toward (tx, ty); returns true once there. */
    stepToward(tx, ty, dt, speed = this.speed) {
      const d = dist(this.x, this.y, tx, ty);
      if (d < 1.5) { this.x = tx; this.y = ty; return true; }
      const step = Math.min(d, speed * dt);
      this.x += ((tx - this.x) / d) * step;
      this.y += ((ty - this.y) / d) * step;
      this.faceToward(tx);
      return d - step < 1.5;
    }
    updatePhysics(dt) {
      this.time += dt;
      if (this.z > 0 || this.vz > 0) {
        this.vz -= GRAVITY * dt;
        this.z += this.vz * dt;
        if (this.z <= 0) { this.z = 0; this.vz = 0; this.onLand(); }
      }
      if (this.bobAmp) this.bob = Math.sin((this.time / this.bobPeriod) * Math.PI * 2 + this.bobPhase) * this.bobAmp;
      if (this.spin > 0) this.spin = Math.max(0, this.spin - dt);
      this.anim.update(dt * 1000);
    }
    onLand() {}
    drawShadow(ctx) {
      if (!this.shadow) return;
      const spread = clamp(1 - this.lift / 90, 0.35, 1);
      ctx.globalAlpha = 0.28 * spread;
      fillEllipse(ctx, this.x, this.y, Math.max(3, (this.w / 2.6) * spread), Math.max(1.5, (this.w / 9) * spread), '#07050d');
      ctx.globalAlpha = 1;
    }
    draw(ctx) {
      this.sheet.draw(ctx, this.anim.frame, this.drawX, this.drawY, this.flip, this.alpha);
    }
  }

  // ---------------------------------------------------------------------------
  class Girl extends Entity {
    constructor(world, img, meta) {
      const sheet = new Sheet(img, meta.w, meta.h, meta.cols || (meta.frames ? Object.keys(meta.frames).length : 1));
      super(world, 'luna', sheet, new Animator([0], [1000]), { baseFacing: meta.baseFacing || 1, facing: 1, speed: 30, bobAmp: meta.bob ? meta.bob[0] : 0, bobPeriod: meta.bob ? meta.bob[1] : 3 });
      this.meta = meta;
      this.state = 'idle';
      this.play('idle');
      this.idleTimer = rnd(world.rng, 2, 5);
      this.walkTarget = null;
      this.onArrive = null;
      this.dustTimer = 0;
    }
    play(name, loop) {
      if (this.current === name) return;
      const a = this.meta.animations[name];
      if (!a) return;
      this.current = name;
      this.anim.set(a.frames.map((f) => this.meta.frames[f]), a.ms.slice(), loop === undefined ? a.loop : loop);
    }
    goTo(x, y, cb) {
      const { zone } = this.world;
      this.walkTarget = { x: clamp(x, zone.x0, zone.x1), y: clamp(y, zone.y0, zone.y1) };
      this.onArrive = cb || null;
      this.state = 'walk';
      this.play('walk');
    }
    get arrived() { return !this.walkTarget; }
    stop() {
      this.walkTarget = null;
      this.onArrive = null;
      this.state = 'idle';
      this.play('idle');
      this.idleTimer = rnd(this.world.rng, 3, 8);
    }
    pose(name) {
      this.walkTarget = null;
      this.state = name;
      this.play(name);
    }
    update(dt) {
      this.updatePhysics(dt);
      if (this.walkTarget) {
        const t = this.walkTarget;
        if (this.stepToward(t.x, t.y, dt)) {
          const cb = this.onArrive;
          this.stop();
          if (cb) cb();
        } else {
          this.dustTimer -= dt;
          if (this.dustTimer <= 0) { this.dustTimer = 0.28; this.world.particles.spawn('dust', this.x - this.facing * 6, this.y, { vx: -this.facing * 6, vy: -4, life: 0.5 }); }
        }
        return;
      }
      if (this.busy) return;
      // Autonomous idling: wander a little now and then.
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        const { zone, rng } = this.world;
        this.goTo(rnd(rng, zone.x0 + 20, zone.x1 - 20), rnd(rng, zone.y0, zone.y1));
      }
    }
    draw(ctx) {
      super.draw(ctx);
    }
  }

  // ---------------------------------------------------------------------------
  // Species personalities. hover = resting height, bob = idle float, speed px/s.
  const SPECIES = {
    gengar: { kind: 'floater', hover: 6, bob: [3, 2.4], speed: 22, alpha: 0.9, curious: 1, glow: ['#9b5cff', 26, 0.12], react: 'grin', zone: 'ground' },
    chandelure: { kind: 'floater', hover: 22, bob: [4, 3.2], speed: 15, glow: ['#b57bff', 40, 0.22], flame: true, curious: 0.5, zone: 'ground' },
    'froslass-mega': { kind: 'floater', hover: 3, bob: [2, 2.8], speed: 24, glow: ['#9fe8ff', 30, 0.12], trail: 'snow', shy: true, zone: 'ground' },
    'altaria-mega': { kind: 'flyer', hover: 4, bob: [5, 4.0], speed: 24, zone: 'sky', sings: true },
    piplup: { kind: 'walker', hover: 0, bob: [0, 1], speed: 28, follow: 'luna', followDist: 30, hoppy: true, zone: 'ground' },
    drifblim: { kind: 'floater', hover: 54, bob: [6, 5.5], speed: 10, curious: 0.6, zone: 'ground' },
    mamoswine: { kind: 'walker', hover: 0, bob: [0, 1], speed: 12, lazy: true, zone: 'ground', heavy: true },
    lunatone: { kind: 'floater', hover: 60, bob: [3, 3.0], speed: 20, orbit: true, glow: ['#ffe39a', 22, 0.12], zone: 'sky' },
    espeon: { kind: 'walker', hover: 0, bob: [0, 1], speed: 34, follow: 'luna', followDist: 44, gem: true, zone: 'ground' },
  };

  class Pokemon extends Entity {
    constructor(world, id, img, entry) {
      const cfg = SPECIES[id];
      const sheet = new Sheet(img, entry.w, entry.h, entry.cols);
      const anim = entry.sequence.length > 1 ? animatorFromSequence(entry.sequence) : new Animator([0], [1000]);
      super(world, id, sheet, anim, { hover: cfg.hover, bobAmp: cfg.bob[0], bobPeriod: cfg.bob[1], speed: cfg.speed, baseFacing: -1, facing: -1 });
      this.cfg = cfg;
      this.name = id;
      this.mode = cfg.orbit ? 'orbit' : cfg.kind === 'flyer' ? 'fly' : cfg.follow ? 'follow' : 'wander';
      this.alpha = cfg.alpha || 1;
      this.airborne = cfg.kind === 'flyer' || cfg.orbit;
      this.restTimer = rnd(world.rng, 1, 4);
      this.wanderTarget = null;
      this.reactCooldown = 0;
      this.glowBoost = 0;
      this.trailTimer = 0;
      this.orbitAngle = rnd(world.rng, 0, Math.PI * 2);
      this.hopTimer = 0;
      this.curiousUntil = 0;
      this.heldOffset = null;
      this.shadow = !this.airborne;
    }
    get glowAlpha() { return this.cfg.glow ? this.cfg.glow[2] * (1 + this.glowBoost * 2) : 0; }

    /** Reactions: 'notice' (cursor hover), 'love' (clicked / petted). */
    react(kind) {
      const w = this.world;
      if (kind === 'notice') {
        if (this.reactCooldown > 0) return;
        this.reactCooldown = 2.2;
        this.hop(this.cfg.heavy ? 60 : 120);
        this.glowBoost = 1;
        if (this.cfg.sings) w.particles.burst('note', this.centerX, this.topY, 2);
        else if (this.cfg.gem) w.particles.burst('sparkle', this.centerX, this.topY + 8, 3);
        else if (this.cfg.trail === 'snow') w.particles.burst('snow', this.centerX, this.centerY, 5);
        else w.particles.burst('sparkleSmall', this.centerX, this.topY, 2);
        if (this.cfg.curious) this.curiousUntil = w.time + 4;
        if (this.cfg.shy) this.shyUntil = w.time + 1.5;
        if (this.cfg.hoppy || this.cfg.gem) this.spin = 0.5;
      } else if (kind === 'love') {
        this.reactCooldown = 1;
        this.hop(this.cfg.heavy ? 70 : 150);
        this.glowBoost = 1.5;
        w.particles.burst('heart', this.centerX, this.topY, 4);
        w.bubbles.show(this, 'heart', 1.6);
        if (this.cfg.sings) w.particles.burst('note', this.centerX, this.topY, 3);
      }
    }

    zoneTarget() {
      const { zone, rng, layout, W } = this.world;
      if (this.cfg.zone === 'sky') return { x: rnd(rng, 40, W - 40), y: rnd(rng, layout.horizon * 0.25, layout.horizon * 0.85) };
      return { x: rnd(rng, zone.x0 + 10, zone.x1 - 10), y: rnd(rng, zone.y0, zone.y1) };
    }

    update(dt) {
      const w = this.world;
      this.updatePhysics(dt);
      this.reactCooldown = Math.max(0, this.reactCooldown - dt);
      this.glowBoost = Math.max(0, this.glowBoost - dt * 1.2);
      if (this.cfg.trail === 'snow') {
        this.trailTimer -= dt;
        if (this.trailTimer <= 0) { this.trailTimer = rnd(w.rng, 0.25, 0.6); w.particles.spawn('snow', this.x + rnd(w.rng, -10, 10), this.drawY - rnd(w.rng, 10, 50), { vx: rnd(w.rng, -3, 3), vy: rnd(w.rng, 6, 12), life: rnd(w.rng, 1.5, 3) }); }
      }
      // Cursor awareness (only when not busy with a scene).
      const p = w.pointer;
      if (!this.busy && p.present && w.settings.interactive) {
        if (this.contains(p.x, p.y, 6)) this.react('notice');
        if (this.cfg.curious && dist(p.x, p.y, this.centerX, this.centerY) < 110) this.curiousUntil = w.time + 2.5;
      }
      if (this.busy) return;
      switch (this.mode) {
        case 'orbit': return this.updateOrbit(dt);
        case 'fly': return this.updateFly(dt);
        case 'follow': return this.updateFollow(dt);
        default: return this.updateWander(dt);
      }
    }

    updateOrbit(dt) {
      // Lazy ellipse around the moon; y is chosen so the sprite is centred on the path.
      const m = this.world.bg.moon;
      this.orbitAngle += dt * 0.18;
      this.x = m.x + Math.cos(this.orbitAngle) * (m.r * 3);
      this.y = m.y + Math.sin(this.orbitAngle) * (m.r * 1.2) + this.hover + this.h / 2;
      this.facing = Math.cos(this.orbitAngle) > 0 ? 1 : -1;
    }

    /** Gentle personal space: idle ground Pokémon drift apart instead of stacking. */
    separate(dt) {
      const w = this.world;
      for (const o of w.entities) {
        if (o === this || o.airborne || o === w.girl) continue;
        const dx = this.x - o.x;
        const dy = this.y - o.y;
        const d = Math.hypot(dx, dy);
        const min = (this.w + o.w) / 4 + 6;
        if (d > 0.01 && d < min) {
          const push = (min - d) * 1.5 * dt;
          this.x = clamp(this.x + (dx / d) * push, w.zone.x0, w.zone.x1);
          this.y = clamp(this.y + (dy / d) * push * 0.5, w.zone.y0, w.zone.y1);
        }
      }
    }

    updateFly(dt) {
      // Lazy figure-eights across the sky.
      if (!this.wanderTarget || this.stepToward(this.wanderTarget.x, this.wanderTarget.y, dt, this.speed)) this.wanderTarget = this.zoneTarget();
    }

    updateFollow(dt) {
      const w = this.world;
      const leader = w.girl;
      const curious = this.cfg.curious && w.time < this.curiousUntil && w.pointer.present;
      const goal = curious ? { x: w.pointer.x, y: clamp(w.pointer.y, w.zone.y0, w.zone.y1) } : { x: leader.x - leader.facing * this.cfg.followDist, y: leader.y + 4 };
      const d = dist(this.x, this.y, goal.x, goal.y);
      if (d > (curious ? 14 : 18)) {
        this.stepToward(goal.x, goal.y, dt, leader.walkTarget ? this.speed : this.speed * 0.7);
        if (this.cfg.hoppy) { this.hopTimer -= dt; if (this.hopTimer <= 0) { this.hopTimer = 0.42; this.hop(55); } }
      } else {
        this.faceToward(leader.x);
        this.separate(dt);
        this.restTimer -= dt;
        if (this.restTimer <= 0) { this.restTimer = rnd(w.rng, 6, 14); if (chance(w.rng, 0.4)) this.hop(50); }
      }
    }

    updateWander(dt) {
      const w = this.world;
      const curious = this.cfg.curious && w.time < this.curiousUntil && w.pointer.present && w.settings.interactive;
      const shy = this.cfg.shy && w.time < (this.shyUntil || 0) && w.pointer.present;
      if (curious) {
        const gx = w.pointer.x;
        const gy = clamp(w.pointer.y + this.hover, w.zone.y0, w.zone.y1);
        if (dist(this.x, this.y, gx, gy) > 26) this.stepToward(gx, gy, dt, this.speed * 0.8);
        else this.faceToward(gx);
        return;
      }
      if (shy) {
        const away = sign(this.x - w.pointer.x) || 1;
        const gx = clamp(this.x + away * 40, w.zone.x0, w.zone.x1);
        this.stepToward(gx, this.y, dt, this.speed * 1.4);
        this.facing = -away; // glances back at the cursor while slipping away
        return;
      }
      if (this.wanderTarget) {
        const sp = this.cfg.lazy ? this.speed * 0.6 : this.speed;
        if (this.stepToward(this.wanderTarget.x, this.wanderTarget.y, dt, sp)) {
          this.wanderTarget = null;
          this.restTimer = rnd(w.rng, this.cfg.lazy ? 12 : 3, this.cfg.lazy ? 30 : 9);
        } else if (this.cfg.hoppy) {
          this.hopTimer -= dt; if (this.hopTimer <= 0) { this.hopTimer = 0.42; this.hop(55); }
        }
        return;
      }
      this.separate(dt);
      this.restTimer -= dt;
      if (this.restTimer <= 0) this.wanderTarget = this.zoneTarget();
    }

    drawGlowLayer(ctx) {
      if (!this.cfg.glow) return;
      const [color, r] = this.cfg.glow;
      const t = this.time;
      const flick = this.cfg.flame ? 0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 5.3) : 1;
      const gy = this.cfg.flame ? this.topY + this.h * 0.25 : this.centerY;
      drawGlow(ctx, this.centerX, gy, r * (1 + this.glowBoost * 0.4), color, this.glowAlpha * flick);
    }

    draw(ctx) {
      this.drawGlowLayer(ctx);
      super.draw(ctx);
      if (this.cfg.gem && Math.floor(this.time * 2) % 7 === 0) {
        drawIcon(ctx, 'sparkleSmall', this.centerX + (this.flip ? -1 : 1) * 0, this.topY + 6, 0.8);
      }
    }
  }

  // ---------------------------------------------------------------------------
  const PARTICLE_DEFS = {
    heart: { icon: 'heart', life: 1.6, vy: -22, wobble: 8, fade: true },
    heartSmall: { icon: 'heartSmall', life: 1.2, vy: -18, wobble: 6, fade: true },
    sparkle: { icon: 'sparkle', life: 0.7, vy: -8, wobble: 0, fade: true, blink: true },
    sparkleSmall: { icon: 'sparkleSmall', life: 0.6, vy: -10, wobble: 0, fade: true, blink: true },
    note: { icon: 'note', life: 1.8, vy: -16, wobble: 10, fade: true },
    snow: { icon: 'snow', life: 2.2, vy: 9, wobble: 5, fade: true },
    dust: { icon: 'dust', life: 0.5, vy: -6, wobble: 0, fade: true },
    zz: { icon: 'zz', life: 2.4, vy: -9, wobble: 4, fade: true },
    bang: { icon: 'bang', life: 0.9, vy: -10, wobble: 0, fade: true },
  };

  class Particles {
    constructor(world) { this.world = world; this.list = []; }
    spawn(kind, x, y, o = {}) {
      const d = PARTICLE_DEFS[kind];
      this.list.push({ kind, icon: d.icon, x, y, vx: o.vx ?? 0, vy: o.vy ?? d.vy, life: o.life ?? d.life, t: 0, wobble: d.wobble, phase: rnd(this.world.rng, 0, 6), fade: d.fade, blink: d.blink });
    }
    burst(kind, x, y, n) {
      const rng = this.world.rng;
      for (let i = 0; i < n; i++) this.spawn(kind, x + rnd(rng, -8, 8), y + rnd(rng, -4, 4), { vx: rnd(rng, -8, 8), life: PARTICLE_DEFS[kind].life * rnd(rng, 0.8, 1.3) });
    }
    update(dt) {
      for (const p of this.list) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      this.list = this.list.filter((p) => p.t < p.life);
    }
    draw(ctx) {
      for (const p of this.list) {
        const k = p.t / p.life;
        if (p.blink && Math.floor(p.t * 16) % 2) continue;
        const a = p.fade ? (k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3) : 1;
        drawIcon(ctx, p.icon, p.x + Math.sin(p.t * 4 + p.phase) * p.wobble * 0.3, p.y, a);
      }
    }
  }

  class Bubbles {
    constructor(world) { this.world = world; this.list = []; }
    show(entity, icon, life = 1.5) {
      this.list = this.list.filter((b) => b.entity !== entity);
      this.list.push({ entity, icon, life, t: 0 });
    }
    update(dt) {
      for (const b of this.list) b.t += dt;
      this.list = this.list.filter((b) => b.t < b.life);
    }
    draw(ctx) {
      for (const b of this.list) {
        const e = b.entity;
        const ic = Luna.sprites.icon(b.icon);
        const w = ic.width + 6;
        const h = ic.height + 5;
        const x = Math.round(e.centerX - w / 2);
        const y = Math.round(e.topY - h - 4 - (b.t < 0.15 ? (0.15 - b.t) * 20 : 0));
        ctx.fillStyle = '#1a1020';
        ctx.fillRect(x - 1, y, w + 2, h); ctx.fillRect(x, y - 1, w, h + 2);
        ctx.fillRect(x + Math.floor(w / 2) - 2, y + h + 1, 4, 1); ctx.fillRect(x + Math.floor(w / 2) - 1, y + h + 2, 2, 1);
        ctx.fillStyle = '#f6f1f9';
        ctx.fillRect(x, y, w, h);
        ctx.fillRect(x + Math.floor(w / 2) - 1, y + h, 2, 1);
        ctx.drawImage(ic, x + 3, y + 2);
      }
    }
  }

  Luna.entities = { Entity, Girl, Pokemon, Particles, Bubbles, SPECIES };
})(window.Luna);
