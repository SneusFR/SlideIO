// Frame-by-frame recorder for the PC gamer (240 Hz): every game frame with what the main thread
// did, what the GPU did, what the HUD was told, and what the player was doing — to split each
// late frame like the debug panel's "Hitch" line (jeu + navigateur + attente GPU), but for EVERY
// frame of a run and with its context (kill, mort, réapparition, tir).
// Page realm, after probe-autopilot.js (__bz), realplay.js (__rp) and optionally glcensus.js (__gc).
//   __kw.start()              begin recording (frames, HUD commands, GL calls, LoAF, heap)
//   __kw.stop()               stop → window.__kwRes (raw frames)
//   __kw.report({ budget })   → { summary, worst: [late frames with context], kills: [per kill] }
// Per game frame f: t (rAF time), cb0 / cb1 (game callback start / end, performance.now),
// cpu = cb1 - cb0, post = browser main-thread work after the frame (a message posted at cb1 runs
// once style / layout / paint / commit and the queued tasks are done — DebugHUD's measure),
// gpu = GPU execution time of the frame's WebGL (TIME_ELAPSED around the callback, from __bz),
// lat = frames until that GPU result was available (GPU / GPU-process backlog), cmds = HUD
// command names posted during the frame, gl = notable WebGL calls, heap = used JS heap (MB),
// st = [alive, damage taken, kills, deaths], fire = left button held.
(() => {
  if (window.__kw) return "kw already";
  const bz = window.__bz, rp = window.__rp;
  if (!bz || !rp) return "kw needs __bz (probe-autopilot.js) and __rp (realplay.js)";
  const KW = (window.__kw = { on: false, frames: [], loaf: [], err: null, fire: false });
  const byT = new Map();
  let cmds = null;
  let gl = null;
  // ------------------------------------------------------------ HUD batches (game page → HUD)
  const prevPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    if (KW.on && msg && msg.t === "batch" && Array.isArray(msg.cmds)) {
      try {
        if (!cmds) cmds = {};
        for (const c of msg.cmds) {
          const n = c && c[0];
          if (typeof n === "string") cmds[n] = (cmds[n] || 0) + 1;
        }
      } catch (e) { KW.err = String(e); }
    }
    return prevPost.call(this, msg, ...rest);
  };
  // ------------------------------------------------------------ input (what the scripted player does)
  window.addEventListener("mousedown", (e) => { if (e.button === 0) KW.fire = true; }, true);
  window.addEventListener("mouseup", (e) => { if (e.button === 0) KW.fire = false; }, true);
  // ------------------------------------------------------------ notable WebGL calls of the game frame
  const P = WebGL2RenderingContext.prototype;
  const GL_NAMES = ["bufferData", "bufferSubData", "texImage2D", "texSubImage2D", "texStorage2D", "texImage3D", "texSubImage3D",
    "compileShader", "linkProgram", "createProgram", "deleteProgram", "useProgram", "createTexture", "deleteTexture", "createBuffer",
    "deleteBuffer", "createVertexArray", "deleteVertexArray", "createFramebuffer", "deleteFramebuffer", "renderbufferStorageMultisample",
    "readPixels", "getError", "fenceSync", "clientWaitSync", "finish", "generateMipmap", "copyTexSubImage2D", "blitFramebuffer",
    "invalidateFramebuffer", "getParameter", "getProgramParameter", "getShaderParameter", "getUniformLocation", "getActiveUniform",
    "uniformBlockBinding", "bindBufferBase", "bindBufferRange"];
  const bytes = (name, a) => {
    try {
      if (name === "bufferData") return typeof a[1] === "number" ? a[1] : (a[1] && a[1].byteLength) || 0;
      if (name === "bufferSubData") return (a[2] && a[2].byteLength) || 0;
      if (name === "texSubImage2D") return a.length >= 9 ? a[4] * a[5] * 4 : 0;
      if (name === "texImage2D") return a.length >= 9 ? a[3] * a[4] * 4 : 0;
      if (name === "texStorage2D") return a[3] * a[4] * 4;
    } catch (e) {}
    return 0;
  };
  for (const name of GL_NAMES) {
    const f = P[name];
    if (typeof f !== "function") continue;
    P[name] = function () {
      if (gl) {
        const e = gl[name] || (gl[name] = [0, 0]);
        e[0]++;
        const b = bytes(name, arguments);
        if (b) e[1] += b;
      }
      return f.apply(this, arguments);
    };
  }
  // ------------------------------------------------------------ long animation frames
  try {
    new PerformanceObserver((list) => {
      if (!KW.on) return;
      for (const e of list.getEntries()) {
        KW.loaf.push({
          t0: e.startTime, t1: e.startTime + e.duration, dur: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
          render: e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : 0,
          style: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
          scripts: (e.scripts || []).map((s) => `${Math.round(s.duration)}ms ${s.invokerType}:${(s.invoker || "").slice(0, 50)} ${(s.sourceFunctionName || "").slice(0, 30)}@${(s.sourceURL || "").split("/").pop()}:${s.sourceCharPosition} fsl=${Math.round(s.forcedStyleAndLayoutDuration || 0)}`),
        });
        if (KW.loaf.length > 2000) KW.loaf.splice(0, 500);
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch (e) { KW.loafErr = String(e); }
  // ------------------------------------------------------------ the game frame
  const chan = new MessageChannel();
  chan.port1.onmessage = (e) => {
    const f = byT.get(e.data);
    if (f) f.post = +(performance.now() - f.cb1).toFixed(2);
  };
  const mem = performance.memory;
  let idx = 0;
  const prevRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return prevRaf.call(window, function (t) {
      if (!KW.on) return cb(t);
      // GPU results that became available since the previous frame (poll() runs after each callback).
      const bf = bz.frames;
      for (let k = Math.max(0, bf.length - 16); k < bf.length; k++) {
        const x = bf[k];
        if (x.gpu != null && x._av === undefined) x._av = idx;
      }
      const draws0 = bz.cbDraws;
      gl = {};
      const heap0 = mem ? mem.usedJSHeapSize : 0;
      const cb0 = performance.now();
      try { cb(t); } finally {
        const cb1 = performance.now();
        if (bz.cbDraws > draws0) {
          const h = rp.hud;
          const f = {
            i: idx++, t, cb0, cb1, cpu: +(cb1 - cb0).toFixed(2), post: null,
            heap0: mem ? +(heap0 / 1048576).toFixed(2) : 0, heap1: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(2) : 0,
            st: [h.alive ? 1 : 0, h.dmg, h.kill, h.deaths], fire: KW.fire ? 1 : 0, cmds, gl,
          };
          cmds = null;
          KW.frames.push(f);
          byT.set(t, f);
          if (KW.frames.length > 60000) { const old = KW.frames.splice(0, 20000); for (const o of old) byT.delete(o.t); }
          chan.port2.postMessage(t);
        }
        gl = null;
      }
    });
  };
  KW.start = () => { KW.frames = []; KW.loaf = []; byT.clear(); cmds = null; idx = 0; KW.on = true; return "kw on"; };
  KW.stop = () => { KW.on = false; window.__kwRes = { frames: KW.frames, loaf: KW.loaf }; return `kw off: ${KW.frames.length} frames, ${KW.loaf.length} LoAF`; };
  // ------------------------------------------------------------ analysis
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const join = () => {
    const g = new Map();
    for (const x of bz.frames) g.set(x.t, x);
    for (const f of KW.frames) {
      const x = g.get(f.t);
      f.gpu = x && x.gpu != null ? +x.gpu.toFixed(2) : null;
      f.lat = x && x._av !== undefined ? x._av - f.i : null;
      f.draws = x ? x.draws : null;
      f.tris = x ? Math.round(x.tris / 1000) : null;
    }
  };
  const merge = (list) => {
    const o = {};
    for (const m of list) if (m) for (const k in m) o[k] = (o[k] || 0) + (Array.isArray(m[k]) ? m[k][0] : m[k]);
    return o;
  };
  const glText = (list) => {
    const o = {};
    for (const m of list) if (m) for (const k in m) { const e = o[k] || (o[k] = [0, 0]); e[0] += m[k][0]; e[1] += m[k][1]; }
    const skip = { useProgram: 1, bufferSubData: 1, texSubImage2D: 1, bindBufferBase: 1, bindBufferRange: 1, getParameter: 1 };
    const out = [];
    for (const k in o) {
      if (skip[k] && !((k === "bufferSubData" || k === "texSubImage2D") && o[k][1] > 262144)) continue;
      out.push(`${k}×${o[k][0]}${o[k][1] ? ` ${Math.round(o[k][1] / 1024)}K` : ""}`);
    }
    return out.join(" ");
  };
  const evOf = (a, b) => {
    // events between frame a (prev) and frame b (this)
    const e = [];
    if (!a || !b) return e;
    if (b.st[2] > a.st[2]) e.push("KILL");
    if (b.st[3] > a.st[3]) e.push("MORT");
    if (b.st[0] === 1 && a.st[0] === 0) e.push("RESPAWN");
    if (b.st[1] > a.st[1]) e.push("dégâts");
    if (b.fire && !a.fire) e.push("tir↓");
    return e;
  };
  KW.report = (opts = {}) => {
    join();
    const fr = KW.frames;
    const budget = opts.budget || 1000 / 240;
    const lateMs = opts.lateMs || budget * 1.5;
    const n = fr.length;
    const dts = [];
    for (let i = 1; i < n; i++) dts.push(fr[i].t - fr[i - 1].t);
    const sd = dts.slice().sort((a, b) => a - b);
    const cpus = fr.map((f) => f.cpu).sort((a, b) => a - b);
    const posts = fr.filter((f) => f.post != null).map((f) => f.post).sort((a, b) => a - b);
    const gpus = fr.filter((f) => f.gpu != null).map((f) => f.gpu).sort((a, b) => a - b);
    const lats = fr.filter((f) => f.lat != null).map((f) => f.lat).sort((a, b) => a - b);
    const span = n > 1 ? fr[n - 1].t - fr[0].t : 0;
    // missed refreshes: a gap of k budgets = k - 1 missed
    let missed = 0;
    for (const d of dts) missed += Math.max(0, Math.round(d / budget) - 1);
    const summary = {
      frames: n, seconds: r1(span / 1000), fps: span ? r1((1000 * (n - 1)) / span) : 0, missedRefreshes: missed,
      dt: { p50: r1(pct(sd, 0.5)), p90: r1(pct(sd, 0.9)), p99: r1(pct(sd, 0.99)), p999: r1(pct(sd, 0.999)), max: r1(sd[sd.length - 1]) },
      late: { over6: dts.filter((d) => d > 6.25).length, over8: dts.filter((d) => d > 8.4).length, over12: dts.filter((d) => d > 12.5).length, over25: dts.filter((d) => d > 25).length, over50: dts.filter((d) => d > 50).length },
      cpu: { p50: r1(pct(cpus, 0.5)), p90: r1(pct(cpus, 0.9)), p99: r1(pct(cpus, 0.99)), max: r1(cpus[cpus.length - 1]) },
      post: { p50: r1(pct(posts, 0.5)), p90: r1(pct(posts, 0.9)), p99: r1(pct(posts, 0.99)), max: r1(posts[posts.length - 1]) },
      gpu: { p50: r1(pct(gpus, 0.5)), p90: r1(pct(gpus, 0.9)), p99: r1(pct(gpus, 0.99)), max: r1(gpus[gpus.length - 1]) },
      gpuLatencyFrames: { p50: pct(lats, 0.5), p90: pct(lats, 0.9), max: lats[lats.length - 1] },
      kills: n ? fr[n - 1].st[2] - fr[0].st[2] : 0, deaths: n ? fr[n - 1].st[3] - fr[0].st[3] : 0,
      heapMB: n ? [fr[0].heap0, fr[n - 1].heap1] : null, loaf: KW.loaf.length,
    };
    // late frames with context: gap between frame i-1 (its cpu + post) and frame i
    const late = [];
    for (let i = 1; i < n; i++) {
      const d = fr[i].t - fr[i - 1].t;
      if (d < lateMs) continue;
      const a = fr[i - 1];
      const game = a.cpu, browser = a.post == null ? null : a.post;
      // the gap runs from a.t (rAF time ~ vsync) to fr[i].t; the game callback started at a.cb0
      const lead = a.cb0 - a.t; // other rAF callbacks / scheduling before the game's
      const wait = d - lead - game - (browser || 0);
      const ev = [];
      for (let k = Math.max(1, i - 6); k <= i; k++) for (const e of evOf(fr[k - 1], fr[k])) ev.push(`${e}@${k - i}`);
      const loafs = KW.loaf.filter((L) => L.t1 > a.cb0 - 1 && L.t0 < fr[i].t + 1).map((L) => `LoAF ${L.dur}ms block ${L.block} render ${L.render} style ${L.style} [${L.scripts.join(" | ")}]`);
      const heapDrop = r1(a.heap1 - fr[i].heap0);
      late.push({
        i, at: r1((fr[i].t - fr[0].t) / 1000), dt: r1(d), lead: r1(lead), jeu: r1(game), navigateur: r1(browser), attente: r1(wait),
        gpu: [fr[i - 2] && fr[i - 2].gpu, a.gpu, fr[i].gpu], lat: [fr[i - 2] && fr[i - 2].lat, a.lat, fr[i].lat],
        draws: a.draws, ev: ev.join(" "), fire: a.fire,
        cmds: Object.entries(merge([fr[i - 3] && fr[i - 3].cmds, fr[i - 2] && fr[i - 2].cmds, a.cmds])).filter(([k]) => !/^(combat\.update|dash\.update|damage\.update|damage\.follow|crosshair\.flush|hitmarker\.flush|combo\.update|plate\.paintball)$/.test(k)).map(([k, v]) => `${k}${v > 1 ? "×" + v : ""}`).join(" "),
        gl: glText([fr[i - 2] && fr[i - 2].gl, a.gl]),
        heapDropMB: heapDrop > 1 ? heapDrop : 0, loaf: loafs,
      });
    }
    late.sort((x, y) => y.dt - x.dt);
    // per event: frames around it
    const around = (pred, label) => {
      const out = [];
      for (let i = 1; i < n; i++) {
        if (!pred(fr[i - 1], fr[i])) continue;
        let worst = 0, worstAt = 0, lost = 0;
        for (let k = i; k < Math.min(n, i + 240); k++) {
          const d = fr[k].t - fr[k - 1].t;
          lost += Math.max(0, Math.round(d / budget) - 1);
          if (d > worst) { worst = d; worstAt = k - i; }
        }
        const seq = [];
        for (let k = Math.max(1, i - 2); k < Math.min(n, i + 24); k++) seq.push(Math.round(fr[k].t - fr[k - 1].t));
        out.push({ label, at: r1((fr[i].t - fr[0].t) / 1000), i, worstDt: r1(worst), worstAt, lostIn1s: lost, dts: seq.join(" "), cpu: fr.slice(i, i + 6).map((f) => f.cpu.toFixed(1)).join(" "), gpu: fr.slice(i - 1, i + 6).map((f) => (f.gpu == null ? "-" : f.gpu.toFixed(1))).join(" ") });
      }
      return out;
    };
    const kills = around((a, b) => b.st[2] > a.st[2], "KILL");
    const deaths = around((a, b) => b.st[3] > a.st[3], "MORT");
    const respawns = around((a, b) => b.st[0] === 1 && a.st[0] === 0, "RESPAWN");
    const top = late.slice(0, opts.top || 25);
    return { summary, worst: top, kills, deaths, respawns };
  };
  return "kw ready";
})();
