// Écran de fin de partie — point d'entrée public.
//
//   import { EndScreen } from './endscreen/EndScreen.js';
//   const endScreen = new EndScreen({ onVote: (id) => ..., onVoteEnd: (id) => ..., onQuit: () => ... });
//   const snapshot = EndScreen.captureFrame(renderer, scene, camera); // dernière image du jeu
//   endScreen.show(matchData, { snapshot });
//
// Voir README.md pour le format de matchData et toutes les options.

import { Intro3D, prewarmIntro3D, flushIntro3DWarmUp, takeIntro3D, releaseIntro3D } from './Intro3D.js';
import { UI, DEFAULT_STRINGS } from './UI.js';
import { Sfx, prewarmSfx } from './sfx.js';
import { Tweens } from './anim.js';
import { computeMatch } from './stats.js';
import { injectStyles } from './styles.js';

// Polices : true = celles fournies dans ./fonts, false = déjà chargées par le jeu,
// ou { display: url, body: url } (pratique avec Vite : import url from '...ttf?url')
function fontUrlsOf(fonts) {
  if (fonts === true) {
    return {
      display: new URL('./fonts/LilitaOne-Regular.ttf', import.meta.url).href,
      body: new URL('./fonts/Nunito-Variable.woff', import.meta.url).href,
    };
  }
  return fonts && typeof fonts === 'object' ? fonts : null;
}

// Warm-up step still to run (styles + fonts), see EndScreen.prewarm.
let pendingStyles = null;

export class EndScreen {
  // PERF — everything the end screen would otherwise do for the first time AT THE END OF A
  // MATCH: its style sheet (a whole-page restyle), its two fonts (loaded, then the text laid
  // out again), its audio context, its WebGL context, programs, buffers and extruded title
  // (Intro3D warm-up). Done in idle slots; the end screens built with `warmIntro: true` take
  // that instance (and that audio context).
  static prewarm({ fonts = true, strings = {}, quality = 'high', pixelRatio = Math.min(window.devicePixelRatio || 1, 2) } = {}) {
    const fontUrls = fontUrlsOf(fonts);
    pendingStyles = () => {
      pendingStyles = null;
      injectStyles(fontUrls);
      if (fontUrls && document.fonts?.load) {
        // Nunito is a variable face (600-1000): one load covers every weight of the screen.
        document.fonts.load("16px 'Lilita One'").catch(() => {});
        document.fonts.load("900 16px 'Nunito'").catch(() => {});
      }
    };
    // (the audio context: once the page has had a gesture — retried by flushPrewarm, at PLAY)
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => prewarmSfx(), { timeout: 3000 });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => pendingStyles?.(), { timeout: 1500 });
    else setTimeout(() => pendingStyles?.(), 30);
    const s = { ...DEFAULT_STRINGS, ...strings };
    return prewarmIntro3D({ pixelRatio, quality, titles: [s.victory, s.defeat] });
  }

  // Finishes the warm-up at once (the match is about to start: nothing left for it).
  static flushPrewarm() {
    pendingStyles?.();
    prewarmSfx();
    flushIntro3DWarmUp();
  }

  constructor(options = {}) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.opts = {
      container: document.body,
      locale: 'fr-FR',
      strings: {},
      sfx: true,
      volume: 0.55,
      voteDuration: 20,
      autoEndVote: true,
      quality: 'high',
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      reducedMotion: reduced,
      fonts: true,
      zIndex: 1000,
      releasePointerLock: true,
      onVote: null,
      onVoteEnd: null,
      onQuit: null,
      onIntroEnd: null,
      // PERF: take the instance prepared by EndScreen.prewarm() (and give it back on
      // dispose) instead of building a WebGL context, programs and title now.
      warmIntro: false,
      // PERF: leave out of each 3D frame the draws that cannot change a pixel (Intro3D).
      skipEmptyDraws: false,
      // PERF: the snapshot is not copied whole to test 64 of its pixels, and its glass is
      // built straight into typed arrays (same values).
      fastSnapshot: false,
      // PERF: the results' unit (--u) set before their content is built (UI.build): their
      // style and layout computed once, at the final size, not twice.
      earlyLayout: false,
      // PERF: called once the game's last frame (the snapshot behind the overlay) is known to
      // be opaque everywhere — read in bands over the first frames of the intro: nothing
      // behind the overlay can show through any more (the game may stop drawing its world).
      onBackdropOpaque: null,
      ...options,
    };
    const o = this.opts;
    this.strings = {
      ...DEFAULT_STRINGS,
      ...o.strings,
      accolades: { ...DEFAULT_STRINGS.accolades, ...(o.strings?.accolades ?? {}) },
    };

    injectStyles(fontUrlsOf(o.fonts));
    // (taken now, adopted below where a new one used to be built: same order of events)
    const warm = o.warmIntro ? takeIntro3D(o.quality) : null;

    const root = document.createElement('div');
    root.className = 'es-root';
    if (o.container === document.body) root.classList.add('es-fixed');
    root.style.zIndex = String(o.zIndex);
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.lang = String(o.locale).split('-')[0];
    // Keep the last game frame behind the results after the glass animation.
    // Without a snapshot, the transparent overlay reveals the live game instead.
    this.gameBackdrop = document.createElement('div');
    this.gameBackdrop.className = 'es-game-backdrop';
    this.gameBackdrop.setAttribute('aria-hidden', 'true');
    this.canvas = warm ? warm.canvas : document.createElement('canvas');
    this.canvas.className = 'es-canvas';
    const vignette = document.createElement('div');
    vignette.className = 'es-vignette';
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'es-flash';
    root.append(this.gameBackdrop, this.canvas, vignette, this.flashEl);
    o.container.appendChild(root);
    this.root = root;

    this.tweens = new Tweens();
    this.sfx = new Sfx(o.sfx, o.volume);
    this.sfx.shared = !!o.warmIntro; // (the session's audio context, opened by prewarm)
    const introOptions = {
      pixelRatio: o.pixelRatio,
      quality: o.quality,
      reducedMotion: o.reducedMotion,
      onCue: (name, arg) => this._cue(name, arg),
    };
    this.intro = warm ? warm.adopt(introOptions) : new Intro3D(this.canvas, introOptions);
    this.intro.keepWarm = !!o.warmIntro;
    this.intro.skipEmpty = !!o.skipEmptyDraws;
    this.intro.fastGlass = !!o.fastSnapshot;
    this.ui = new UI(root, this);
    this.intro.setSlotProvider(() => this.ui.titleSlotRect());

    this.introPlaying = false;
    this.uiStarted = false;
    this._scan = null; // (onBackdropOpaque, see _scanBackdrop)
    this._raf = null;
    this._frame = this._frame.bind(this);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(root);
  }

  // Copie la dernière image d'un rendu Three.js. À appeler juste après renderer.render(),
  // ou en lui passant scene + camera pour qu'il fasse un rendu frais lui-même.
  static captureFrame(rendererOrCanvas, scene, camera) {
    const src = rendererOrCanvas?.domElement ?? rendererOrCanvas;
    if (scene && camera && rendererOrCanvas?.render) rendererOrCanvas.render(scene, camera);
    if (!src || !src.width) return null;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // ------------------------------------------------------------ API

  show(data, { snapshot = null } = {}) {
    const match = computeMatch(data);
    this.match = match;
    this.mode = match.outcome;
    const V = this.mode === 'victory';
    this.root.getAnimations?.().forEach((a) => a.cancel());
    this.root.hidden = false;
    this.root.classList.toggle('es-victory', V);
    this.root.classList.toggle('es-defeat', !V);
    this.tweens.clear();
    this.tweens.now = performance.now() / 1000;
    this.ui.build(match);
    this._resize();

    // dans un FPS la souris est capturée : on la libère pour pouvoir voter
    if (this.opts.releasePointerLock && document.pointerLockElement) document.exitPointerLock?.();
    const snap = snapshot ? this._fitSnapshot(snapshot) : null;
    this.gameBackdrop.replaceChildren(...(snap ? [snap] : []));
    // (onBackdropOpaque: is the snapshot opaque everywhere? read from the intro's 2nd frame on)
    this._scan = snap && this.opts.onBackdropOpaque ? { g: snap.getContext('2d'), w: snap.width, h: snap.height, y: 0, wait: 1 } : null;
    const plan = this.intro.start(this.mode, snap, { titleText: V ? this.strings.victory : this.strings.defeat });
    this.introPlaying = true;
    this.uiStarted = false;
    this.ui.skipBtn.hidden = false;
    this.plan = plan;
    this.sfx.warmup();
    this._last = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame(this._frame);
    return new Promise((resolve) => { this._resolveIntro = resolve; });
  }

  // Passe directement aux résultats (Espace / Entrée / bouton "Passer")
  skip() {
    if (!this.introPlaying) return;
    this.intro.skip();
    this._startUI();
  }

  // Votes reçus du serveur : { mapId: [playerId, ...] } ou { mapId: nombre }
  setVotes(votes) { this.ui.setVotes(votes); }

  // Clôt le vote (mapId imposé par le serveur, sinon la map la plus votée)
  endVote(mapId) { this.ui.endVote(mapId); }

  // Vote local par programme (manette, etc.)
  vote(mapId) { this.ui.vote(mapId); }

  setSfxEnabled(on) { this.sfx.setEnabled(on); }

  hide() {
    return new Promise((resolve) => {
      if (this.root.hidden) { resolve(); return; }
      const done = () => {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        this.intro.clear();
        this.gameBackdrop.replaceChildren();
        this._scan = null;
        this.tweens.clear();
        this.ui.destroy();
        this.root.hidden = true;
        this.introPlaying = false;
        resolve();
      };
      if (this.opts.reducedMotion || !this.root.animate) { done(); return; }
      const a = this.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-in', fill: 'forwards' });
      a.onfinish = () => { done(); a.cancel(); };
    });
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._scan = null;
    this._ro.disconnect();
    this.ui.destroy();
    if (this.opts.warmIntro) releaseIntro3D(this.intro); // kept warm for the next end screen
    else this.intro.dispose();
    this.gameBackdrop.replaceChildren();
    this.tweens.clear();
    this.root.remove();
  }

  // ------------------------------------------------------------ interne

  _startUI() {
    if (this.uiStarted) return;
    this.uiStarted = true;
    this.introPlaying = false;
    this.intro.dockTitle(this.opts.reducedMotion ? 0.4 : 0.75);
    this.ui.enter();
    this.opts.onIntroEnd?.();
    this._resolveIntro?.();
  }

  onVoteResolved(mapId) {
    this.tweens.at(0.9, () => this.opts.onVoteEnd?.(mapId));
  }

  _cue(name, arg) {
    if (name === 'flash') {
      const a = (typeof arg === 'number' ? arg : 0.5) * (this.opts.reducedMotion ? 0.3 : 1);
      this.flashEl.animate?.([{ opacity: a }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
      return;
    }
    this.sfx.play(name, arg && typeof arg === 'object' ? arg : {});
  }

  _frame(now) {
    this._raf = requestAnimationFrame(this._frame);
    const dt = Math.min(0.25, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    const t = now / 1000;
    this.tweens.update(t);
    this.intro.update(dt);
    if (this.introPlaying && this.intro.t >= this.plan.uiAt) this._startUI();
    this.ui.frame(t);
    if (this._scan) this._scanBackdrop();
  }

  // PERF (onBackdropOpaque) — one band of the snapshot (~128 k pixels) per frame: opaque
  // everywhere (every alpha 255: three.js creates every context with an alpha channel, the
  // game cannot promise it) → onBackdropOpaque; a single translucent pixel → the scan stops,
  // the game keeps drawing its world under the overlay, as before.
  _scanBackdrop() {
    const s = this._scan;
    if (s.wait > 0) { s.wait--; return; } // (not in the intro's first frame)
    const n = Math.min(s.h - s.y, Math.max(1, Math.floor(131072 / s.w)));
    const d = s.g.getImageData(0, s.y, s.w, n).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] !== 255) { this._scan = null; return; }
    }
    s.y += n;
    if (s.y < s.h) return;
    this._scan = null;
    this.opts.onBackdropOpaque?.();
  }

  _resize() {
    const r = this.root.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.intro.resize(r.width, r.height);
    this.ui.layout();
  }

  // Ajuste l'image du jeu au format de l'écran ("cover") et vérifie qu'elle n'est pas vide
  _fitSnapshot(src) {
    const r = this.root.getBoundingClientRect();
    const sw = src.videoWidth || src.naturalWidth || src.width;
    const sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh || r.width < 2) return null;
    const dpr = Math.min(this.opts.pixelRatio, 2);
    let w = Math.round(r.width * dpr);
    let h = Math.round(r.height * dpr);
    const k = Math.min(1, 2048 / Math.max(w, h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    const s = Math.max(w / sw, h / sh);
    try {
      g.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
      let seen = false;
      if (this.opts.fastSnapshot) {
        // PERF: the same 64 samples, read one by one — not a copy (and conversion) of the
        // whole frame, 8 MB at 1080p, in the frame where the match ends.
        for (let i = 0; i < 64 && !seen; i++) {
          const x = Math.floor(((i % 8) + 0.5) / 8 * w);
          const y = Math.floor((Math.floor(i / 8) + 0.5) / 8 * h);
          if (g.getImageData(x, y, 1, 1).data[3] > 0) seen = true;
        }
      } else {
        const px = g.getImageData(0, 0, w, h).data;
        for (let i = 0; i < 64 && !seen; i++) {
          const x = Math.floor(((i % 8) + 0.5) / 8 * w);
          const y = Math.floor((Math.floor(i / 8) + 0.5) / 8 * h);
          if (px[(y * w + x) * 4 + 3] > 0) seen = true;
        }
      }
      if (!seen) {
        console.warn('[EndScreen] La capture du jeu est vide : appelez EndScreen.captureFrame(renderer, scene, camera) juste après le rendu. Intro sans vitre.');
        return null;
      }
    } catch (e) {
      console.warn('[EndScreen] Capture impossible (image d\'une autre origine ?) : intro sans vitre.', e);
      return null;
    }
    return c;
  }
}

export { DEFAULT_STRINGS };
