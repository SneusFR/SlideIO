// First-time draw combinations (page realm, any time after the game's WebGL context exists).
// ANGLE's Direct3D 11 backend finishes a program LAZILY: the HLSL it links at linkProgram is for
// the default input / output layouts only; the first draw with another vertex-attribute layout
// (an integer skinIndex, an instanced matrix…) or into another kind of render target compiles a
// new D3D shader variant INSIDE the GPU process, during the frame — 5 to 50 ms on Windows that
// no JS call shows (no linkProgram, no compileShader). This tracks, per draw call, the triple
// (program, attribute formats of the bound VAO, bound draw framebuffer) and records the first
// occurrence of each, with the frame it happened in (__kw frame index when killwatch.js runs).
//   __fd.start() / __fd.stop() → window.__fdRes = [{ i, t, prog, attrs, fb, mode, n }]
//   __fd.names()               → GL program → three.js program name / cacheKey head
(() => {
  if (window.__fd) return "fd already";
  const P = WebGL2RenderingContext.prototype;
  const FD = (window.__fd = { on: false, firsts: [], seen: new Set(), err: null });
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o) return 0; let v = ids.get(o); if (!v) { v = nextId++; ids.set(o, v); } return v; };
  const vaoAttrs = new WeakMap(); // VAO (or the context's default VAO key) → Map(loc → fmt)
  const sigCache = new WeakMap();
  const DEFAULT_VAO = {};
  const state = new WeakMap(); // gl → { prog, vao, fb }
  const st = (gl) => { let s = state.get(gl); if (!s) { s = { prog: null, vao: DEFAULT_VAO, fb: null }; state.set(gl, s); } return s; };
  const attrsOf = (vao) => { let m = vaoAttrs.get(vao); if (!m) { m = new Map(); vaoAttrs.set(vao, m); } return m; };
  const TYPE = { 5120: "b", 5121: "B", 5122: "s", 5123: "S", 5124: "i", 5125: "I", 5126: "f", 5131: "h", 36255: "2", 33640: "u" };
  const wrap = (name, fn) => { const f = P[name]; if (typeof f === "function") P[name] = function () { try { fn(this, arguments); } catch (e) { FD.err = String(e); } return f.apply(this, arguments); }; };
  wrap("useProgram", (gl, a) => { st(gl).prog = a[0]; });
  wrap("bindVertexArray", (gl, a) => { st(gl).vao = a[0] || DEFAULT_VAO; });
  wrap("bindFramebuffer", (gl, a) => { if (a[0] === 36160 || a[0] === 36009) st(gl).fb = a[1]; });
  const setFmt = (gl, loc, fmt) => { const s = st(gl); const m = attrsOf(s.vao); if (m.get(loc) !== fmt) { m.set(loc, fmt); sigCache.delete(s.vao); } };
  wrap("vertexAttribPointer", (gl, a) => setFmt(gl, a[0], `${a[1]}${TYPE[a[2]] || a[2]}${a[3] ? "n" : ""}`));
  wrap("vertexAttribIPointer", (gl, a) => setFmt(gl, a[0], `${a[1]}${TYPE[a[2]] || a[2]}I`));
  wrap("enableVertexAttribArray", (gl, a) => { const s = st(gl); const m = attrsOf(s.vao); const k = "e" + a[0]; if (!m.get(k)) { m.set(k, 1); sigCache.delete(s.vao); } });
  wrap("disableVertexAttribArray", (gl, a) => { const s = st(gl); const m = attrsOf(s.vao); const k = "e" + a[0]; if (m.get(k)) { m.delete(k); sigCache.delete(s.vao); } });
  wrap("vertexAttribDivisor", (gl, a) => setFmt(gl, "d" + a[0], a[1]));
  const sigOf = (vao) => {
    let s = sigCache.get(vao);
    if (s === undefined) {
      const m = attrsOf(vao);
      const locs = [];
      for (const [k, v] of m) if (typeof k === "number" && m.get("e" + k)) locs.push(`${k}:${v}${m.get("d" + k) ? "/" + m.get("d" + k) : ""}`);
      locs.sort();
      s = locs.join(",");
      sigCache.set(vao, s);
    }
    return s;
  };
  const DRAWS = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"];
  for (const name of DRAWS) {
    wrap(name, (gl, a) => {
      if (!FD.on) return;
      const s = st(gl);
      const key = `${idOf(s.prog)}|${sigOf(s.vao)}|${idOf(s.fb)}`;
      if (FD.seen.has(key)) return;
      FD.seen.add(key);
      const kw = window.__kw;
      FD.firsts.push({ i: kw && kw.on ? kw.frames.length : -1, t: performance.now(), prog: idOf(s.prog), progObj: s.prog, attrs: sigOf(s.vao), fb: idOf(s.fb), mode: name, n: name.startsWith("drawArrays") ? a[2] : a[1] });
    });
  }
  // Learn what exists before the run (the warm-up's draws): call prime() for a few seconds, then start().
  FD.prime = () => { FD.on = true; FD.priming = true; return "fd priming (keys seen so far are not reported)"; };
  FD.start = () => { FD.firsts = []; FD.on = true; FD.priming = false; return `fd on (${FD.seen.size} keys known)`; };
  FD.stop = () => { window.__fdRes = FD.firsts.map(({ progObj, ...r }) => r); return `fd: ${FD.firsts.length} first draws`; };
  FD.names = () => {
    const out = new Map();
    const r = window.__obs && window.__obs.renderers[0];
    const progs = r && r.info && r.info.programs ? r.info.programs : [];
    for (const p of progs) out.set(idOf(p.program), `${p.name}${p.type ? "/" + p.type : ""} ${String(p.cacheKey || "").slice(0, 60)}`);
    return out;
  };
  FD.describe = () => {
    const names = FD.names();
    return FD.firsts.map((f) => ({ i: f.i, prog: f.prog, name: names.get(f.prog) || "?", attrs: f.attrs, fb: f.fb, mode: f.mode, n: f.n }));
  };
  return "fd ready";
})();
