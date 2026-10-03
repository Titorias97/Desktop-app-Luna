/* Shared helpers. Everything lives on window.Luna so the page works from file://
 * (Electron, Lively Wallpaper, Wallpaper Engine) without a bundler or ES modules. */
window.Luna = window.Luna || {};
(function (Luna) {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const sign = (v) => (v < 0 ? -1 : 1);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
  const easeOut = (t) => 1 - (1 - t) * (1 - t);

  /** Mulberry32: tiny seeded PRNG so the graveyard layout is stable between runs. */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = (rng, a, b) => a + rng() * (b - a);
  const rndInt = (rng, a, b) => Math.floor(rnd(rng, a, b + 1));
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (rng, p) => rng() < p;

  /** Approach `target` from `value` by at most `step` (never overshoots). */
  function approach(value, target, step) {
    if (value < target) return Math.min(value + step, target);
    if (value > target) return Math.max(value - step, target);
    return value;
  }

  /** Converts '#rrggbb' to [r,g,b]. */
  function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }
  function mix(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const c = a.map((v, i) => Math.round(lerp(v, b[i], t)));
    return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  Luna.util = { clamp, lerp, dist, sign, easeInOut, easeOut, makeRng, rnd, rndInt, pick, chance, approach, hexToRgb, rgba, mix };
})(window.Luna);
