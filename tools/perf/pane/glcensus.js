// GL census per frame (page realm, after __abScript + __rpScript): heavy / synchronous WebGL
// calls counted per rAF frame and tied to the local player's kills / deaths (__rp.hud), plus
// long animation frames (LoAF) with their scripts and big heap drops (garbage collections).
//   __gc.start() / __gc.stop() → window.__gcRes { frames: [{i, t, dt, ev, calls}], loaf: [...], gcs: [...] }
(() => {
  if (window.__gc) return "gc already";
  const P = WebGL2RenderingContext.prototype;
  const G = (window.__gc = { on: false, cur: null, frames: [], loaf: [], gcs: [], totals: {} });
  const sizeOf = (name, a) => {
    try {
      if (name === "bufferData") return typeof a[1] === "number" ? a[1] : a[1] && a[1].byteLength || 0;
      if (name === "bufferSubData") return a[2] && a[2].byteLength || 0;
      if (name === "texImage2D") return a.length >= 9 ? (a[3] * a[4]) : (a[5] && (a[5].width * a[5].height || a[5].videoWidth * a[5].videoHeight)) || 0;
      if (name === "texSubImage2D") return a.length >= 9 ? (a[4] * a[5]) : (a[6] && (a[6].width * a[6].height)) || 0;
      if (name === "texStorage2D") return a[3] * a[4];
      if (name === "texImage3D" || name === "texSubImage3D") return a[3] * a[4] * a[5];
      if (name === "renderbufferStorageMultisample") return a[3] * a[4];
      if (name === "readPixels") return a[2] * a[3];
    } catch (e) {}
    return 0;
  };
  const NAMES = ["linkProgram", "compileShader", "getProgramParameter", "getShaderParameter", "getProgramInfoLog", "getShaderInfoLog",
    "texImage2D", "texSubImage2D", "texStorage2D", "texImage3D", "texSubImage3D", "generateMipmap", "createTexture", "deleteTexture",
    "bufferData", "bufferSubData", "createBuffer", "deleteBuffer", "readPixels", "getError", "fenceSync", "clientWaitSync", "getSyncParameter",
    "finish", "flush", "getParameter", "renderbufferStorageMultisample", "renderbufferStorage", "blitFramebuffer", "checkFramebufferStatus",
    "createProgram", "deleteProgram", "getQueryParameter", "getUniformLocation", "getAttribLocation", "getActiveUniform", "copyTexSubImage2D"];
  for (const name of NAMES) {
    const f = P[name];
    if (typeof f !== "function") continue;
    P[name] = function () {
      if (G.on && G.cur) {
        const c = G.cur.calls;
        const s = sizeOf(name, arguments);
        const e = c[name] || (c[name] = [0, 0]);
        e[0]++;
        e[1] += s;
        if (name === "linkProgram" || name === "compileShader" || name === "readPixels" || name === "clientWaitSync" || name === "finish") {
          const t0 = performance.now();
          const r = f.apply(this, arguments);
          e[2] = (e[2] || 0) + (performance.now() - t0);
          return r;
        }
        if (name === "getProgramParameter" || name === "getShaderParameter" || name === "getError") {
          const t0 = performance.now();
          const r = f.apply(this, arguments);
          const dt = performance.now() - t0;
          e[2] = (e[2] || 0) + dt;
          return r;
        }
      }
      return f.apply(this, arguments);
    };
  }
  let idx = 0, lastT = 0, lastHeap = 0;
  const hud = window.__rp && window.__rp.hud;
  let lastKill = 0, lastDeath = 0, lastAlive = true;
  const tick = (t) => {
    if (G.on) {
      if (G.cur) {
        const f = G.cur;
        f.dt = lastT ? +(t - lastT).toFixed(1) : 0;
        const ev = [];
        if (hud) {
          if (hud.kill > lastKill) ev.push("KILL");
          if (hud.deaths > lastDeath) ev.push("DEATH");
          if (hud.alive && !lastAlive) ev.push("RESPAWN");
          lastKill = hud.kill; lastDeath = hud.deaths; lastAlive = hud.alive;
        }
        f.ev = ev.join("+");
        const keys = Object.keys(f.calls);
        const heavy = f.ev || f.dt > 25 || keys.some((k) => /link|compile|texImage|texStorage|generateMipmap|readPixels|clientWait|finish|renderbuffer|getError|getProgramParameter|getShaderParameter/.test(k)) ||
          (f.calls.bufferData && f.calls.bufferData[1] > 65536) || (f.calls.texSubImage2D && f.calls.texSubImage2D[1] > 65536);
        for (const k of keys) { const tt = G.totals[k] || (G.totals[k] = [0, 0, 0]); tt[0] += f.calls[k][0]; tt[1] += f.calls[k][1]; tt[2] += f.calls[k][2] || 0; }
        if (heavy) G.frames.push(f);
        if (G.frames.length > 3000) G.frames.splice(0, 1000);
      }
      if (performance.memory) {
        const h = performance.memory.usedJSHeapSize;
        if (lastHeap && h < lastHeap - 2 * 1048576) G.gcs.push({ i: idx, t: Math.round(t), dropMB: +((lastHeap - h) / 1048576).toFixed(1), heapMB: +(h / 1048576).toFixed(1) });
        lastHeap = h;
      }
      lastT = t;
      G.cur = { i: ++idx, t: Math.round(t), calls: {} };
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      if (!G.on) return;
      for (const e of list.getEntries()) {
        G.loaf.push({
          t: Math.round(e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
          render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
          scripts: (e.scripts || []).map((s) => `${Math.round(s.duration)}ms ${s.invokerType}:${(s.invoker || "").slice(0, 60)} @${(s.sourceURL || "").split("/").pop()}:${s.sourceCharPosition} ${(s.sourceFunctionName || "").slice(0, 40)} fsl=${Math.round(s.forcedStyleAndLayoutDuration || 0)}`),
        });
        if (G.loaf.length > 300) G.loaf.splice(0, 100);
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch (e) { G.loafErr = String(e); }
  G.start = () => { G.frames = []; G.loaf = []; G.gcs = []; G.totals = {}; G.cur = null; lastT = 0; G.on = true; return "census on"; };
  G.stop = () => { G.on = false; window.__gcRes = { frames: G.frames, loaf: G.loaf, gcs: G.gcs, totals: G.totals }; return `census off: ${G.frames.length} notable frames, ${G.loaf.length} LoAF, ${G.gcs.length} heap drops`; };
  return "gl census ready";
})();
