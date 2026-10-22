// Real-GPU probe v2 (paste into a page in play). window.__bz.
//   await __bz.run(mode, ms)   mode "off" (pacing only) | "frame" (+ GPU time of each frame)
//   __bz.pose = { p:[x,y,z], yaw, pitch } | null     (needs window.__S / window.__R: devtools hook)
//   __bz.sweep(points, yaws, pitches, frames)        background: results in window.__sweep
(() => {
  if (window.__bz) return "already";
  const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  const isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const T = isGL2 ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : gl.getExtension("EXT_disjoint_timer_query");
  const P = Object.getPrototypeOf(gl);
  const O = Object.create(null);
  for (const k of Object.getOwnPropertyNames(P)) { if (k === "constructor") continue; const d = Object.getOwnPropertyDescriptor(P, k); if (d && typeof d.value === "function") O[k] = d.value; }
  const bz = { gl, T, canvas, isGL2, mode: "off", frames: [], pending: [], cbDraws: 0, cbTris: 0, cbClears: 0, cbBinds: 0, cbCalls: 0, countCalls: false, disjoint: 0, pose: null, fbSeen: new Set() };
  window.__bz = bz;
  const DRAWS = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements", "drawElementsInstancedANGLE", "drawArraysInstancedANGLE"];
  for (const name of DRAWS) {
    const f = O[name]; if (!f) continue;
    const inst = name.includes("Instanced");
    P[name] = function () {
      if (this === gl) {
        bz.cbDraws++;
        const a = arguments;
        let n = name.startsWith("drawArrays") ? a[2] : name === "drawRangeElements" ? a[3] : a[1];
        if (inst) n *= name.startsWith("drawArrays") ? a[3] : a[4];
        if (a[0] === 4) bz.cbTris += n / 3;
      }
      return f.apply(this, arguments);
    };
  }
  const clr = O.clear;
  P.clear = function (m) { if (this === gl) bz.cbClears++; return clr.call(this, m); };
  const bfb = O.bindFramebuffer;
  P.bindFramebuffer = function (t, fb) { if (this === gl) { bz.cbBinds++; bz.fbSeen.add(fb); } return bfb.call(this, t, fb); };
  // every call (only while counting)
  bz.countAll = (on) => {
    for (const k of Object.keys(O)) {
      if (DRAWS.includes(k) || k === "clear" || k === "bindFramebuffer") continue;
      if (on) { const f = O[k]; P[k] = function () { if (this === gl) bz.cbCalls++; return f.apply(this, arguments); }; }
      else P[k] = O[k];
    }
    bz.countCalls = on;
  };
  function poll() {
    if (!bz.pending.length || !T) return;
    const disj = isGL2 ? O.getParameter.call(gl, T.GPU_DISJOINT_EXT) : O.getParameter.call(gl, T.GPU_DISJOINT_EXT);
    if (disj) { bz.disjoint++; for (const p of bz.pending) del(p.q); bz.pending.length = 0; return; }
    let i = 0;
    for (; i < bz.pending.length; i++) {
      const p = bz.pending[i];
      const avail = isGL2 ? O.getQueryParameter.call(gl, p.q, gl.QUERY_RESULT_AVAILABLE) : T.getQueryObjectEXT(p.q, T.QUERY_RESULT_AVAILABLE_EXT);
      if (!avail) break;
      const ns = isGL2 ? O.getQueryParameter.call(gl, p.q, gl.QUERY_RESULT) : T.getQueryObjectEXT(p.q, T.QUERY_RESULT_EXT);
      del(p.q);
      p.f.gpu = ns / 1e6;
    }
    if (i) bz.pending.splice(0, i);
  }
  const mk = () => (isGL2 ? O.createQuery.call(gl) : T.createQueryEXT());
  const begin = (q) => (isGL2 ? O.beginQuery.call(gl, T.TIME_ELAPSED_EXT, q) : T.beginQueryEXT(T.TIME_ELAPSED_EXT, q));
  const end = () => (isGL2 ? O.endQuery.call(gl, T.TIME_ELAPSED_EXT) : T.endQueryEXT(T.TIME_ELAPSED_EXT));
  const del = (q) => (isGL2 ? O.deleteQuery.call(gl, q) : T.deleteQueryEXT(q));
  const origRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return origRaf.call(window, function (t) {
      const s = performance.now();
      bz.cbDraws = 0; bz.cbTris = 0; bz.cbClears = 0; bz.cbBinds = 0; bz.cbCalls = 0;
      let q = null;
      if (bz.mode === "frame" && T) { q = mk(); begin(q); }
      try { cb(t); } finally {
        if (q) end();
        const e = performance.now();
        if (bz.cbDraws > 0) {
          const f = { t, cpu: e - s, draws: bz.cbDraws, tris: bz.cbTris, clears: bz.cbClears, binds: bz.cbBinds, calls: bz.cbCalls, tag: bz.tag };
          bz.frames.push(f);
          if (q) bz.pending.push({ q, f });
          if (bz.frames.length > 20000) bz.frames.splice(0, 10000);
        } else if (q) del(q);
        try { poll(); } catch (err) { bz.pollErr = String(err); }
      }
    });
  };
  // camera override (devtools hook pages only)
  if (window.__S && window.__R && window.__S[0]) {
    const sc = window.__S[0];
    const prevBefore = sc.onBeforeRender;
    sc.onBeforeRender = function (renderer, scene, camera, rt) {
      if (bz.pose && camera && camera.isPerspectiveCamera) {
        const p = bz.pose.p, yaw = bz.pose.yaw, pitch = bz.pose.pitch;
        const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), spp = Math.sin(pitch / 2);
        // YXZ euler (yaw about Y, then pitch about X) → quaternion
        const qx = spp * cy, qy = cp * sy, qz = -spp * sy, qw = cp * cy;
        camera.matrixWorld.compose({ x: p[0], y: p[1], z: p[2] }, { _x: qx, _y: qy, _z: qz, _w: qw }, { x: 1, y: 1, z: 1 });
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      }
      return prevBefore && prevBefore.call(this, renderer, scene, camera, rt);
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  bz.sleep = sleep;
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  bz.stats = (fr) => {
    const n = fr.length; const dts = [];
    for (let i = 1; i < n; i++) dts.push(fr[i].t - fr[i - 1].t);
    const sd = dts.slice().sort((a, b) => a - b);
    const cpus = fr.map((f) => f.cpu).sort((a, b) => a - b);
    const g = fr.filter((f) => f.gpu != null).map((f) => f.gpu).sort((a, b) => a - b);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    return {
      frames: n,
      fps: n > 1 ? +((1000 * (n - 1)) / (fr[n - 1].t - fr[0].t)).toFixed(1) : 0,
      dt: { p50: +(pct(sd, 0.5) || 0).toFixed(1), p95: +(pct(sd, 0.95) || 0).toFixed(1), p99: +(pct(sd, 0.99) || 0).toFixed(1), max: +(sd[sd.length - 1] || 0).toFixed(1) },
      late25: dts.filter((d) => d > 25).length, late50: dts.filter((d) => d > 50).length,
      cpu: { avg: +avg(cpus).toFixed(2), p95: +(pct(cpus, 0.95) || 0).toFixed(2) },
      gpu: g.length ? { p50: +pct(g, 0.5).toFixed(2), p90: +pct(g, 0.9).toFixed(2), max: +g[g.length - 1].toFixed(2) } : null,
      draws: +avg(fr.map((f) => f.draws)).toFixed(1), tris: Math.round(avg(fr.map((f) => f.tris))), clears: +avg(fr.map((f) => f.clears)).toFixed(1), binds: +avg(fr.map((f) => f.binds)).toFixed(1),
      calls: bz.countCalls ? Math.round(avg(fr.map((f) => f.calls + f.draws + f.clears + f.binds))) : undefined,
    };
  };
  bz.run = async (mode = "off", ms = 4000) => {
    for (const p of bz.pending) del(p.q);
    bz.pending = []; bz.frames = []; bz.disjoint = 0; bz.mode = mode;
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    await sleep(ms); bz.mode = "off"; await sleep(300);
    const r = bz.stats(bz.frames);
    r.disjoint = bz.disjoint; r.focus = document.hasFocus(); r.vis = document.visibilityState;
    if (performance.memory) r.heapMB = { start: Math.round(heap0 / 1048576), end: Math.round(performance.memory.usedJSHeapSize / 1048576) };
    r.size = [bz.canvas.width, bz.canvas.height];
    return r;
  };
  bz.sweep = (points, yaws, pitches, framesPer = 24) => {
    window.__sweep = { done: false, rows: [] };
    (async () => {
      bz.mode = "frame"; bz.frames = []; bz.pending = [];
      for (const p of points) for (const yaw of yaws) for (const pitch of pitches) {
        bz.pose = { p, yaw, pitch };
        const tag = `${p.join(",")}|${(yaw * 180 / Math.PI).toFixed(0)}|${(pitch * 180 / Math.PI).toFixed(0)}`;
        bz.tag = "skip"; await sleep(80);
        bz.tag = tag;
        const start = bz.frames.length;
        while (bz.frames.length - start < framesPer) await sleep(30);
        bz.tag = "skip";
      }
      await sleep(500);
      bz.mode = "off"; bz.pose = null;
      const by = new Map();
      for (const f of bz.frames) { if (!f.tag || f.tag === "skip" || f.gpu == null) continue; if (!by.has(f.tag)) by.set(f.tag, []); by.get(f.tag).push(f); }
      for (const [tag, fr] of by) {
        const g = fr.map((f) => f.gpu).sort((a, b) => a - b);
        window.__sweep.rows.push({ tag, gpu: +g[g.length >> 1].toFixed(2), draws: Math.round(fr.reduce((s, f) => s + f.draws, 0) / fr.length), tris: Math.round(fr.reduce((s, f) => s + f.tris, 0) / fr.length) });
      }
      window.__sweep.rows.sort((a, b) => b.gpu - a.gpu);
      window.__sweep.done = true;
    })();
    return "sweep started";
  };
  return `probe2 on ${canvas.width}x${canvas.height} gl2=${isGL2} timer=${!!T} cam=${!!(window.__S && window.__S[0])}`;
})()
;
// Scripted player for real-GPU stress runs (solo match, fake pointer lock).
// Synthetic input through the same DOM events InputManager listens to:
// W held + alternating A/D strafes, jumps (Space), dash (E), slides (Shift),
// continuous camera sweep (mousemove movementX/Y), fire bursts (mouse 0),
// reload (R), hammer swings (Digit2 → clicks → Digit1).
//   __auto.start() / __auto.stop()   counters in __auto.stats
(() => {
  if (window.__auto) return "already";
  const A = { on: false, stats: { bursts: 0, jumps: 0, dashes: 0, slides: 0, melee: 0, reloads: 0 }, timers: [] };
  window.__auto = A;
  const keyName = (code) => (code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code === "Space" ? " " : code.startsWith("Shift") ? "Shift" : code);
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, key: keyName(code), bubbles: true, cancelable: true }));
  const tap = (code, ms = 80) => { key(code, true); A.timers.push(setTimeout(() => key(code, false), ms)); };
  const mouse = (type) => window.dispatchEvent(new MouseEvent(type, { button: 0, buttons: type === "mousedown" ? 1 : 0, bubbles: true }));
  const look = (dx, dy) => document.dispatchEvent(new MouseEvent("mousemove", { movementX: dx, movementY: dy, bubbles: true }));
  const every = (ms, fn) => A.timers.push(setInterval(() => { if (A.on) fn(); }, ms));
  let phase = 0, strafe = "KeyA", meleeMode = false;
  const lookLoop = () => {
    if (!A.on) return;
    phase += 0.02;
    // a sweeping turn with direction changes + gentle pitch oscillation
    const dx = Math.round(7 * Math.sin(phase * 0.7) + 3);
    const dy = Math.round(2 * Math.sin(phase * 1.3));
    look(dx, dy);
    requestAnimationFrame(lookLoop);
  };
  A.start = () => {
    if (A.on) return "on";
    A.on = true;
    key("KeyW", true);
    key(strafe, true);
    requestAnimationFrame(lookLoop);
    every(1400, () => { key(strafe, false); strafe = strafe === "KeyA" ? "KeyD" : "KeyA"; key(strafe, true); });
    every(2300, () => { tap("Space", 90); A.stats.jumps++; });
    every(4100, () => { tap("KeyE", 90); A.stats.dashes++; });
    every(6700, () => { tap("ShiftLeft", 650); A.stats.slides++; });
    // fire bursts: 1.1 s held, 0.5 s released (automatic rifle)
    every(1600, () => { if (meleeMode) return; mouse("mousedown"); A.stats.bursts++; A.timers.push(setTimeout(() => mouse("mouseup"), 1100)); });
    every(9000, () => { if (!meleeMode) { tap("KeyR", 80); A.stats.reloads++; } });
    // hammer: switch, 3 swings, back to the rifle
    every(21000, () => {
      meleeMode = true; mouse("mouseup"); tap("Digit2", 80);
      [500, 1200, 1900].forEach((t) => A.timers.push(setTimeout(() => { mouse("mousedown"); A.timers.push(setTimeout(() => mouse("mouseup"), 120)); A.stats.melee++; }, t)));
      A.timers.push(setTimeout(() => { tap("Digit1", 80); meleeMode = false; }, 2600));
    });
    return "started";
  };
  A.stop = () => {
    A.on = false;
    for (const t of A.timers) { clearInterval(t); clearTimeout(t); }
    A.timers = [];
    ["KeyW", "KeyA", "KeyD", "Space", "KeyE", "ShiftLeft"].forEach((c) => key(c, false));
    mouse("mouseup");
    return "stopped";
  };
  return "autopilot ready";
})()
;
// A/B runner for the pane (production page, probe2 + autopilot already injected).
//   __ab.start(seconds) → plays a solo match with 8 bots and measures; __ab.result when done.
(() => {
  if (window.__ab) return "ab already";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A = (window.__ab = { phase: "idle", result: null, log: [] });
  A.start = async (seconds = 30) => {
    A.phase = "setup"; A.result = null;
    try {
      Object.defineProperty(document, "pointerLockElement", { configurable: true, get() { return window.__fakeLock || null; } });
      const plus = document.getElementById("bots-plus");
      for (let i = 0; i < 6 && plus; i++) { plus.click(); await sleep(120); }
      A.bots = document.getElementById("bots-value")?.textContent ?? document.querySelector("#bots-plus")?.parentElement?.textContent?.replace(/\s+/g, " ").trim();
      document.getElementById("menu-cta")?.click();
      A.phase = "flight";
      await sleep(7000);
      const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      window.__fakeLock = canvas;
      document.dispatchEvent(new Event("pointerlockchange"));
      await sleep(500);
      window.__auto.start();
      A.phase = "settle";
      await sleep(4000);
      A.phase = "measure";
      const r = await window.__bz.run("frame", seconds * 1000);
      r.auto = { ...window.__auto.stats };
      r.batt = navigator.getBattery ? await navigator.getBattery().then((b) => ({ charging: b.charging, level: b.level })) : null;
      r.diag = new URLSearchParams(location.search).get("diag") ?? "";
      A.result = r;
      A.phase = "done";
      window.__auto.stop();
    } catch (e) {
      A.phase = "error: " + (e && e.message);
    }
    return A.phase;
  };
  return "ab runner ready";
})()
;
"injected: " + typeof window.__bz + " " + typeof window.__auto + " " + typeof window.__ab
