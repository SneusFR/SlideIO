// Where the game's CPU goes, per frame and around each kill / death / respawn (page realm, in a
// match — production build, no source map needed). The game is minified, but METHOD names
// survive, and the game objects are reachable from the scene: a bot's scene node carries the bot
// (Bot.ts: `model.group.userData.combatant = this`), the bot carries the shared weapon world
// (`weaponWorld.deps`: the PLAYER's paintball / FAMAS / popcorn… with their FX, the audio), and the
// player's paintball rifle carries the player (`owner`), its hit feedback, its viewmodel…
// From those roots the objects reachable within a few properties are explored and every own
// method of their class prototypes is wrapped (three.js classes and built-ins excepted), plus
// three's renderer.render, mixer.update, skeleton.update, raycaster, scene.updateMatrixWorld and the
// HUD batch postMessage: inclusive time per frame (nested calls count in both — read `bot.update`
// as a total, `bot.ai.update` inside it).
// Needs either tools-11 (window.__g: bound scene / bots / player, window.__K: kills from the
// game's Health callbacks) or realplay.js (window.__rp with a picked scene and its HUD tap).
//   __cp.start() / __cp.stop()
//   __cp.report() → { frames, perFrameAvg: top methods (ms / frame, calls / frame), events:
//        [{ label, frame, frames: [{ k, cpu, other, top: "name ms×calls, …" }] }] }
//        (cpu = the game's callback; other = the page's other rAF callbacks since the previous
//        game frame, e.g. a scripted player's aim loop — their methods are in `top` too)
(() => {
  if (window.__cp) return "cp already";
  const g = window.__g, rp = window.__rp, obs = window.__obs;
  const scene = (g && g.scene) || (rp && rp.scene);
  if (!scene) return "cp needs __g.scene (tools-11) or __rp.scene (realplay.js)";
  const CP = (window.__cp = { on: false, err: null });
  const names = [];
  const index = new Map();
  const slot = (key) => { let i = index.get(key); if (i === undefined) { i = names.length; names.push(key); index.set(key, i); } return i; };
  const MAX = 2048;
  const acc = new Float64Array(MAX), cnt = new Uint32Array(MAX);
  const wrappedProtos = new Set();
  const wrapFn = (i, f) => function () {
    if (!CP.on) return f.apply(this, arguments);
    const t0 = performance.now();
    try { return f.apply(this, arguments); } finally { acc[i] += performance.now() - t0; cnt[i]++; }
  };
  const wrapProto = (label, proto, only) => {
    if (!proto || proto === Object.prototype || proto === Function.prototype || wrappedProtos.has(proto)) return 0;
    wrappedProtos.add(proto);
    let n = 0;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || (only && !only.includes(name))) continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== "function" || !d.writable) continue;
      if (names.length >= MAX) break;
      proto[name] = wrapFn(slot(`${label}.${name}`), d.value);
      n++;
    }
    return n;
  };
  const protoOf = (o) => (o && typeof o === "object" ? Object.getPrototypeOf(o) : null);
  // ---- three.js / built-ins are never wrapped (hot leaf methods: the wrapper would cost more than them)
  const isThree = (o) => !!(o.isObject3D || o.isMaterial || o.isBufferGeometry || o.isBufferAttribute || o.isInterleavedBuffer || o.isInterleavedBufferAttribute || o.isTexture || o.isVector2 || o.isVector3 || o.isVector4 || o.isMatrix3 || o.isMatrix4 || o.isQuaternion || o.isEuler || o.isColor || o.isBox3 || o.isSphere || o.isPlane || o.isRay || o.isFrustum || o.isCamera || o.isWebGLRenderer || o.isWebGLRenderTarget || o.isRenderTarget || o.isSkeleton || o.isAnimationMixer || o.isAnimationAction || o.isRaycaster || o.isLine3 || o.isTriangle || o.isUniformsGroup || o.isFog || o.isScene || o.isLayers || o.isClock || o.isEventDispatcher || o.isPropertyBinding || o.isAnimationClip || o.isKeyframeTrack);
  const builtin = new Set([Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype, Array.prototype, Promise.prototype, Date.prototype, RegExp.prototype, Error.prototype, ArrayBuffer.prototype, DataView.prototype, Object.getPrototypeOf(Int8Array.prototype), EventTarget.prototype]);
  const isDom = (o) => (typeof Node !== "undefined" && o instanceof Node) || (typeof Window !== "undefined" && o instanceof Window) || (typeof CanvasRenderingContext2D !== "undefined" && o instanceof CanvasRenderingContext2D) || (typeof WebGL2RenderingContext !== "undefined" && o instanceof WebGL2RenderingContext) || (typeof AudioNode !== "undefined" && o instanceof AudioNode) || (typeof AudioContext !== "undefined" && o instanceof BaseAudioContext) || (typeof MessagePort !== "undefined" && o instanceof MessagePort);
  // ---- roots
  let bot = null;
  scene.traverse((o) => { const c = o.userData && o.userData.combatant; if (!bot && c && c.ai && c.model) bot = c; });
  if (g && g.bots && g.bots.length) bot = g.bots[0];
  if (!bot) return "no bot found under the scene (userData.combatant)";
  const deps = bot.weaponWorld && bot.weaponWorld.deps;
  const pb = (g && g.pb) || (deps && deps.paintball);
  const player = (g && g.player) || (pb && pb.owner);
  const roots = [["bot", bot], ["wworld", bot.weaponWorld], ["player", player], ["pb", pb]];
  if (deps) for (const k of ["famas", "popcorn", "basket", "frisbee", "audio"]) if (deps[k]) roots.push([k, deps[k]]);
  // ---- explore: BFS over properties, depth ≤ 3, wrap each class prototype once (label = first path)
  const counts = {};
  const seen = new Set();
  const queue = roots.filter(([, o]) => o).map(([label, o]) => [label, o, 0]);
  let protosWrapped = 0;
  while (queue.length && protosWrapped < 160) {
    const [label, o, depth] = queue.shift();
    if (!o || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (ArrayBuffer.isView(o) || isDom(o)) continue;
    if (Array.isArray(o)) { for (let i = 0; i < Math.min(o.length, 4); i++) queue.push([label + "[]", o[i], depth]); continue; }
    if (isThree(o)) continue;
    const proto = protoOf(o);
    if (!proto || builtin.has(proto)) continue;
    if (proto !== Object.prototype && !wrappedProtos.has(proto)) {
      const n = wrapProto(label, proto);
      if (n) { counts[label] = n; protosWrapped++; }
      // its parent class too (shared behaviour), one level
      const parent = Object.getPrototypeOf(proto);
      if (parent && parent !== Object.prototype && !builtin.has(parent) && !wrappedProtos.has(parent)) { const m = wrapProto(label + "^", parent); if (m) counts[label + "^"] = m; }
    }
    if (depth >= 3) continue;
    for (const key of Object.keys(o)) {
      let v;
      try { v = o[key]; } catch (e) { continue; }
      if (v && typeof v === "object") queue.push([`${label}.${key}`, v, depth + 1]);
    }
  }
  // ---- three.js entry points (top level only)
  const r = obs.renderers[0];
  counts.render = wrapProto("three", protoOf(r), ["render"]);
  if (obs.mixers[0]) counts.mixer = wrapProto("mixer", protoOf(obs.mixers[0]), ["update"]);
  let skel = null;
  scene.traverse((o) => { if (!skel && o.isSkinnedMesh && o.skeleton) skel = o.skeleton; });
  if (skel) counts.skeleton = wrapProto("skeleton", protoOf(skel), ["update"]);
  if (bot.weaponWorld && bot.weaponWorld.ray) counts.ray = wrapProto("raycaster", protoOf(bot.weaponWorld.ray), ["intersectObject", "intersectObjects"]);
  {
    const sceneProto = protoOf(scene);
    const base = sceneProto.updateMatrixWorld;
    Object.defineProperty(sceneProto, "updateMatrixWorld", { configurable: true, writable: true, value: wrapFn(slot("scene.updateMatrixWorld"), base) });
  }
  {
    const prev = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = wrapFn(slot("hud.postMessage"), prev);
  }
  // ---- per frame: ring of the last RING frames, snapshots around events
  const RING = 720;
  const ring = new Float32Array(RING * MAX), ringN = new Uint16Array(RING * MAX), ringCpu = new Float32Array(RING), ringOther = new Float32Array(RING);
  let head = 0, frameNo = 0;
  const totals = new Float64Array(MAX), totalN = new Float64Array(MAX);
  const events = [];
  const pendingSnap = [];
  const state = () => (window.__K ? { kill: window.__K.kills, deaths: window.__K.deaths, alive: window.__hud ? window.__hud.alive : true } : rp.hud);
  let last = state();
  const bz = window.__bz;
  // Other rAF callbacks of the page (a scripted player's aim loop, which may make a kill) count in
  // the NEXT game frame: their methods in its top list, their time in `other`. (probe-lite resets
  // bz.cbDraws at the start of every callback: a callback with draws is the game's.)
  let otherCpu = 0;
  const prevRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return prevRaf.call(window, function (t) {
      if (!CP.on) return cb(t);
      const t0 = performance.now();
      try { cb(t); } finally {
        const cpu = performance.now() - t0;
        if (!bz || bz.cbDraws > 0) {
          const h = head % RING;
          ring.set(acc.subarray(0, MAX), h * MAX);
          for (let k = 0; k < names.length; k++) ringN[h * MAX + k] = Math.min(65535, cnt[k]);
          ringCpu[h] = cpu; ringOther[h] = otherCpu;
          for (let k = 0; k < names.length; k++) { totals[k] += acc[k]; totalN[k] += cnt[k]; }
          acc.fill(0); cnt.fill(0); otherCpu = 0;
          const s = state();
          const ev = [];
          if (s.kill > last.kill) ev.push("KILL");
          if (s.deaths > last.deaths) ev.push("MORT");
          if (s.alive && !last.alive) ev.push("RESPAWN");
          last = { kill: s.kill, deaths: s.deaths, alive: s.alive };
          if (ev.length) pendingSnap.push({ label: ev.join("+"), at: head, due: head + 14 });
          for (let q = pendingSnap.length - 1; q >= 0; q--) {
            const p = pendingSnap[q];
            if (head < p.due) continue;
            pendingSnap.splice(q, 1);
            const fr = [];
            for (let k = p.at - 2; k <= p.due; k++) {
              if (k < 0 || head - k >= RING) continue;
              const hh = k % RING;
              const top = [];
              for (let m = 0; m < names.length; m++) { const v = ring[hh * MAX + m]; if (v >= 0.1) top.push([names[m], v, ringN[hh * MAX + m]]); }
              top.sort((a, b) => b[1] - a[1]);
              fr.push({ k: k - p.at, cpu: +ringCpu[hh].toFixed(2), other: +ringOther[hh].toFixed(2), top: top.slice(0, 14).map(([n, v, c]) => `${n} ${v.toFixed(2)}×${c}`).join(", ") });
            }
            events.push({ label: p.label, frame: p.at, frames: fr });
          }
          head++;
          frameNo++;
        } else otherCpu += cpu;
      }
    });
  };
  CP.start = () => { totals.fill(0); totalN.fill(0); acc.fill(0); cnt.fill(0); otherCpu = 0; events.length = 0; pendingSnap.length = 0; head = 0; frameNo = 0; last = state(); CP.on = true; return `cp on: ${names.length} methods`; };
  CP.stop = () => { CP.on = false; return `cp off: ${frameNo} frames, ${events.length} events`; };
  CP.report = (minMs = 0.02) => {
    const avg = [];
    const n = Math.max(1, frameNo);
    for (let k = 0; k < names.length; k++) if (totals[k] / n >= minMs) avg.push([names[k], totals[k] / n, totalN[k] / n]);
    avg.sort((a, b) => b[1] - a[1]);
    return { frames: frameNo, perFrameAvg: avg.slice(0, 40).map(([nm, v, c]) => `${nm} ${v.toFixed(3)}×${c.toFixed(1)}`), events };
  };
  CP.names = names;
  CP.counts = counts;
  return `cp ready: ${names.length} methods wrapped on ${Object.keys(counts).length} classes`;
})();
