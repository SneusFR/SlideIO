// Bruitages synthétisés en WebAudio (aucun fichier). Pour brancher vos propres sons,
// passez `sfx: (name, opts) => monAudio.play(name)` à EndScreen : ce module est alors ignoré.
// Noms émis : crack, shatter, whoosh, slam, thud, pop, tick, fanfare, defeat, stamp, vote, reveal, countdown, tink

// PERF (EndScreen `warmIntro`) — ONE audio context for every end screen of the session,
// opened before the match ends (prewarmSfx: an idle slot of the menu once the page has had a
// user gesture, at the latest the click on PLAY) instead of in the frame where it ends — and
// not one more per replay (they were never closed). Same graph, same sounds.
let shared = null;

function openAudio(volume) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  const master = ctx.createGain();
  master.gain.value = volume;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 6;
  master.connect(comp).connect(ctx.destination);
  const len = ctx.sampleRate;
  const noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return { ctx, master, noise };
}

// Opens the shared context now, unless the page has had no user gesture yet (it would start
// suspended, with a console warning): then the end screen opens it, as before.
export function prewarmSfx() {
  if (shared && shared.ctx.state !== 'closed') return;
  if (typeof window === 'undefined' || navigator.userActivation?.hasBeenActive === false) return;
  shared = openAudio(0.55);
}

export class Sfx {
  constructor(option = true, volume = 0.55) {
    this.handler = typeof option === 'function' ? option : null;
    this.enabled = option !== false;
    this.volume = volume;
    this.ctx = null;
    this.shared = false; // (EndScreen warmIntro: the session's context, see prewarmSfx)
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    if (on) this.ctx.resume?.().catch(() => {}); else this.ctx.suspend?.();
  }

  // Crée / réveille le contexte audio (à appeler pendant un geste utilisateur si possible)
  warmup() { if (!this.handler && this.enabled) this._ensure(); }

  _ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume?.().catch(() => {});
      return this.ctx;
    }
    if (!this.shared) {
      const audio = openAudio(this.volume);
      if (!audio) return null;
      this.ctx = audio.ctx;
      this.master = audio.master;
      this.noise = audio.noise;
      return this.ctx;
    }
    if (!shared || shared.ctx.state === 'closed') shared = openAudio(this.volume);
    if (!shared) return null;
    this.ctx = shared.ctx;
    this.master = shared.master;
    this.master.gain.value = this.volume;
    this.noise = shared.noise;
    // (opened earlier — maybe before any gesture, or suspended by a previous end screen)
    if (this.ctx.state === 'suspended') this.ctx.resume?.().catch(() => {});
    return this.ctx;
  }

  play(name, opts = {}) {
    if (this.handler) { try { this.handler(name, opts); } catch { /* */ } return; }
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx || ctx.state !== 'running') return;
    const fn = this[`_${name}`];
    if (fn) fn.call(this, ctx.currentTime + 0.005, opts);
  }

  _env(gainNode, t, attack, dur, peak) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.002, attack));
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _noise(t, { dur = 0.3, type = 'highpass', f0 = 1000, f1 = f0, q = 0.8, gain = 0.4, attack = 0.004 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this._env(g, t, attack, dur, gain);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  _tone(t, { type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.3, attack = 0.004, filter = 0, vibrato = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    let node = o;
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 5.5;
      lg.gain.value = vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      node.connect(f);
      node = f;
    }
    const g = ctx.createGain();
    this._env(g, t, attack, dur, gain);
    node.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _crack(t, { strength = 1 } = {}) {
    this._noise(t, { dur: 0.11, type: 'highpass', f0: 2600, f1: 1800, gain: 0.55 * strength });
    this._tone(t, { type: 'square', f0: 240, f1: 70, dur: 0.06, gain: 0.12 * strength });
    for (let i = 0; i < 4; i++) this._tone(t + Math.random() * 0.05, { f0: 3000 + Math.random() * 3500, dur: 0.06, gain: 0.05 });
  }

  _shatter(t, { dark = false } = {}) {
    this._noise(t, { dur: 0.75, type: 'highpass', f0: dark ? 900 : 1600, f1: dark ? 400 : 5200, gain: 0.5, q: 0.5 });
    this._noise(t, { dur: 0.25, type: 'lowpass', f0: 1200, f1: 200, gain: 0.45 });
    for (let i = 0; i < 18; i++) {
      const d = Math.random() * (dark ? 0.7 : 0.45);
      this._tone(t + d, { f0: (dark ? 1800 : 2600) + Math.random() * 4400, dur: 0.05 + Math.random() * 0.2, gain: 0.03 + Math.random() * 0.06 });
    }
  }

  _whoosh(t, { dur = 0.45 } = {}) {
    this._noise(t, { dur, type: 'bandpass', f0: 280, f1: 2600, q: 0.9, gain: 0.32, attack: dur * 0.55 });
  }

  _slam(t) {
    this._tone(t, { f0: 110, f1: 36, dur: 0.55, gain: 0.9 });
    this._noise(t, { dur: 0.32, type: 'lowpass', f0: 1400, f1: 160, gain: 0.55 });
    this._noise(t, { dur: 0.08, type: 'highpass', f0: 3000, gain: 0.25 });
  }

  _thud(t, { pitch = 1 } = {}) {
    this._tone(t, { f0: 82 * pitch, f1: 34, dur: 0.38, gain: 0.85 });
    this._noise(t, { dur: 0.22, type: 'lowpass', f0: 700, f1: 120, gain: 0.4 });
  }

  _pop(t, { pitch = 1 } = {}) {
    this._tone(t, { f0: 480 * pitch, f1: 880 * pitch, dur: 0.09, gain: 0.16 });
  }

  _tick(t, { pitch = 1 } = {}) {
    this._tone(t, { type: 'square', f0: 1500 * pitch, dur: 0.028, gain: 0.05, filter: 4000 });
  }

  _countdown(t, { last = false } = {}) {
    this._tone(t, { type: 'triangle', f0: last ? 1320 : 990, dur: last ? 0.3 : 0.09, gain: 0.16 });
  }

  _stamp(t) {
    this._tone(t, { f0: 160, f1: 60, dur: 0.18, gain: 0.5 });
    this._noise(t, { dur: 0.12, type: 'bandpass', f0: 900, f1: 500, q: 1.2, gain: 0.35 });
  }

  _tink(t) {
    this._tone(t, { f0: 2400, dur: 0.18, gain: 0.08 });
    this._tone(t + 0.12, { f0: 2000, dur: 0.14, gain: 0.05 });
  }

  _fanfare(t) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      this._tone(t + i * 0.1, { type: 'triangle', f0: f, dur: last ? 0.7 : 0.16, gain: 0.2, vibrato: last ? 6 : 0 });
      this._tone(t + i * 0.1, { type: 'square', f0: f * 2, dur: last ? 0.5 : 0.12, gain: 0.035, filter: 3500 });
    });
    this._tone(t + 0.3, { type: 'triangle', f0: 659.25, dur: 0.6, gain: 0.1 });
    this._tone(t + 0.3, { type: 'triangle', f0: 783.99, dur: 0.6, gain: 0.08 });
  }

  _defeat(t) {
    const notes = [392, 349.23, 311.13, 261.63];
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      this._tone(t + i * 0.26, { type: 'sawtooth', f0: f, f1: last ? f * 0.97 : f, dur: last ? 1.1 : 0.3, gain: 0.12, filter: 1100, vibrato: last ? 5 : 0, attack: 0.03 });
    });
  }

  _vote(t) {
    this._tone(t, { f0: 660, f1: 990, dur: 0.1, gain: 0.18 });
    this._tone(t + 0.07, { f0: 1320, dur: 0.16, gain: 0.1 });
  }

  _reveal(t) {
    [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => this._tone(t + i * 0.07, { type: 'triangle', f0: f, dur: 0.35, gain: 0.15 }));
  }
}
