// Petites briques d'animation : easings, tweens pilotés par l'horloge de l'écran de fin,
// et un mode "finir tout" pour passer l'intro sans casser l'état final.

export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const smoothstep = (a, b, v) => { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); };

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  outElastic: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
};

export class Tweens {
  constructor() {
    this.items = [];
    this.now = 0;
    this.waapi = new Set();
  }

  // t0 implicite = maintenant ; delay et duration en secondes
  add({ delay = 0, duration = 0, ease: e = ease.linear, onStart, onUpdate, onComplete }) {
    const item = {
      start: this.now + delay,
      duration: Math.max(0, duration),
      ease: e,
      onStart,
      onUpdate,
      onComplete,
      started: false,
      done: false,
    };
    this.items.push(item);
    return {
      cancel: () => { item.done = true; },
      finish: () => this._finishItem(item),
    };
  }

  at(delay, fn) { return this.add({ delay, duration: 0, onComplete: fn }); }

  // Lance une animation WAAPI suivie (pour pouvoir la terminer d'un coup)
  animate(el, keyframes, opts) {
    if (!el || !el.animate) return null;
    const a = el.animate(keyframes, { fill: 'both', ...opts });
    this.waapi.add(a);
    a.addEventListener('finish', () => this.waapi.delete(a));
    a.addEventListener('cancel', () => this.waapi.delete(a));
    return a;
  }

  update(now) {
    this.now = now;
    // copie : des callbacks peuvent ajouter des tweens
    const list = this.items;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.done || now < it.start) continue;
      if (!it.started) { it.started = true; it.onStart?.(); }
      const t = it.duration === 0 ? 1 : Math.min(1, (now - it.start) / it.duration);
      it.onUpdate?.(it.ease(t), t);
      if (t >= 1) { it.done = true; it.onComplete?.(); }
    }
    if (list.length > 64) this.items = list.filter((it) => !it.done);
  }

  _finishItem(item) {
    if (item.done) return;
    if (!item.started) { item.started = true; item.onStart?.(); }
    item.onUpdate?.(item.ease(1), 1);
    item.done = true;
    item.onComplete?.();
  }

  // Termine tout ce qui est en cours ou planifié, dans l'ordre chronologique.
  finishAll() {
    for (let guard = 0; guard < 20; guard++) {
      const pending = this.items.filter((it) => !it.done).sort((a, b) => a.start - b.start);
      if (!pending.length) break;
      for (const it of pending) this._finishItem(it);
    }
    this.items = [];
    for (const a of [...this.waapi]) {
      try { a.finish(); } catch { /* animation infinie : on l'ignore */ }
    }
  }

  clear() {
    this.items = [];
    for (const a of [...this.waapi]) { try { a.cancel(); } catch { /* */ } }
    this.waapi.clear();
  }
}

// Pseudo-bruit 1D lisse (somme de sinus) pour les tremblements de caméra
export function shakeNoise(t, seed) {
  return (
    Math.sin(t * 37.1 + seed * 11.3) * 0.5 +
    Math.sin(t * 59.7 + seed * 3.7) * 0.3 +
    Math.sin(t * 91.3 + seed * 7.9) * 0.2
  );
}

// PRNG déterministe (mulberry32)
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
