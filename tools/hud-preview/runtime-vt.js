// Virtual time for the HUD runtime harness (runtime-harness.mjs), injected as
// the FIRST script of every harness HUD document — the host page in inline /
// old mode, the HUD iframe (hud.html) in frame mode — so the HUD runs on a
// clock the harness steps by exact 1/60 s frames and every screenshot is
// reproducible across modes:
//   - requestAnimationFrame / performance.now / document.timeline.currentTime
//     → the virtual clock (paint layers, frisbee springs, FramePulse,
//     hitmarker kill window, warm-up holds);
//   - CSS animations: paused by a stylesheet (animation-play-state), stepped
//     by setting their currentTime. NOT paused through the API: Chrome keeps a
//     CSS animation paused / played / finished by script alive after its
//     class is gone (HudWarmup's endTouchedAnimations exists for that), which
//     would leave stale animations the real game never has;
//   - CSS transitions and Web Animations: paused through the API when they
//     appear, stepped, finished at their end (a newer transition still
//     replaces an older one); the Web Animations' `finish` listeners
//     (leaderboard cleanups) run synchronously at that point;
//   - what the page itself does to an animation (the warm-up's play / pause /
//     finish) keeps its meaning: play = "virtually running", pause = left
//     where the code put it;
//   - Math.random → a fixed-seed generator (damage-number offsets / tilts).
// In the HUD iframe, the port's messages also carry the clock: `{t:"__vt",ms}`
// advances it (in order with the batches), `{t:"__vt-rendered"}` is answered
// once two real frames have been drawn. Not loaded with `?vt=0`.
(() => {
  if (window.__vt) return;
  const realRaf = window.requestAnimationFrame.bind(window);

  let seed = 0x5eed1234;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let vnow = 1000;
  let queue = [];
  let nextId = 0;
  window.requestAnimationFrame = (cb) => {
    const id = ++nextId;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue = queue.filter((q) => q.id !== id);
  };
  performance.now = () => vnow;
  try {
    Object.defineProperty(document.timeline, "currentTime", { get: () => vnow, configurable: true });
  } catch {
    /* frameStamp() falls back to performance.now() */
  }

  const pausedByCss = document.createElement("style");
  pausedByCss.textContent = "*,*::before,*::after{animation-play-state:paused!important}";
  (document.head ?? document.documentElement).appendChild(pausedByCss);

  /** Animations already met. */
  const seen = new WeakSet();
  /** Animations whose time runs (stepped by advance). */
  const stepped = new Set();
  /** Animations paused / played / finished through the API (by the page or here). */
  const scripted = new WeakSet();
  /** Web Animations' "finish" listeners, called synchronously by finishNow(). */
  const finishListeners = new WeakMap();
  const P = Animation.prototype;
  const realPlay = P.play;
  const realPause = P.pause;
  const realFinish = P.finish;
  const realAdd = EventTarget.prototype.addEventListener;
  const isCss = (a) => typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation;

  function finishNow(a) {
    stepped.delete(a);
    scripted.add(a);
    realFinish.call(a);
    for (const cb of finishListeners.get(a) ?? []) cb.call(a, { type: "finish", target: a });
  }

  P.addEventListener = function addEventListener(type, cb, opts) {
    if (type === "finish" && typeof cb === "function") {
      const list = finishListeners.get(this) ?? [];
      list.push(cb);
      finishListeners.set(this, list);
      return;
    }
    return realAdd.call(this, type, cb, opts);
  };
  P.play = function play() {
    seen.add(this);
    scripted.add(this);
    realPlay.call(this);
    realPause.call(this);
    stepped.add(this);
  };
  P.pause = function pause() {
    seen.add(this);
    scripted.add(this);
    realPause.call(this);
    stepped.delete(this);
  };
  P.finish = function finish() {
    seen.add(this);
    finishNow(this);
  };
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function animate(...args) {
    const a = realAnimate.apply(this, args);
    seen.add(a);
    scripted.add(a);
    realPause.call(a);
    a.currentTime = 0;
    stepped.add(a);
    return a;
  };

  /** New animations: CSS ones start paused at 0 (stylesheet); transitions are paused at 0. */
  function freeze() {
    for (const a of document.getAnimations()) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (isCss(a)) {
        stepped.add(a);
      } else if (a.playState === "running") {
        scripted.add(a);
        realPause.call(a);
        a.currentTime = 0;
        stepped.add(a);
      }
    }
  }

  function advance(ms) {
    freeze();
    for (const a of [...stepped]) {
      if (a.playState !== "paused") {
        stepped.delete(a);
        continue;
      }
      const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      const t = Number(a.currentTime ?? 0) + ms;
      if (typeof end === "number" && Number.isFinite(end) && t >= end) {
        if (isCss(a) && !scripted.has(a)) {
          // As a CSS animation that ran to its end: its fill holds, the class decides.
          a.currentTime = end;
          stepped.delete(a);
        } else {
          finishNow(a);
        }
      } else {
        a.currentTime = t;
      }
    }
    vnow += ms;
    const run = queue;
    queue = [];
    for (const q of run) {
      try {
        q.cb(vnow);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
    freeze();
  }

  /** `frames` real frames drawn (2: the current state committed; more: rasterized and drawn too). */
  const rendered = (frames = 2) =>
    new Promise((resolve) => {
      const step = () => (--frames > 0 ? realRaf(step) : resolve());
      realRaf(step);
    });

  window.__vt = { freeze, advance, rendered, now: () => vnow };

  if (window.parent === window) return;
  // HUD document: the clock rides on the protocol port, in order with the batches.
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      return desc.get.call(this);
    },
    set(fn) {
      const port = this;
      if (typeof fn !== "function") {
        desc.set.call(this, fn);
        return;
      }
      desc.set.call(this, function onmessage(e) {
        const d = e.data;
        if (d && d.t === "__vt") {
          advance(d.ms);
          return;
        }
        if (d && d.t === "__vt-rendered") {
          void rendered(d.frames).then(() => port.postMessage({ t: "__vt-rendered" }));
          return;
        }
        fn.call(this, e);
        freeze();
      });
    },
  });
})();
