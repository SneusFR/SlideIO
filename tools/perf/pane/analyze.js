// Analysis of a killwatch.js run, joined with segprobe.js (GPU per pass) and firsts.js (first-time
// draw combinations). Page realm, after the run: (0, eval)(<this file>)({ budget, top })
// → { summary, late: [...], kills: [...], deaths: [...], respawns: [...], firsts: [...] }
((opts = {}) => {
  const kw = window.__kw, sp = window.__sp, fd = window.__fd, bz = window.__bz;
  const fr = kw.frames;
  const budget = opts.budget || 1000 / 240;
  const lateMs = opts.lateMs || budget * 1.5;
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  // GPU per frame: segprobe segments (sum) or the probe's whole-frame query
  const segBy = new Map();
  if (sp) for (const s of sp.frames) segBy.set(s.t, s.segs);
  const gpuBy = new Map();
  if (bz) for (const x of bz.frames) if (x.gpu != null) gpuBy.set(x.t, x.gpu);
  for (const f of fr) {
    const segs = segBy.get(f.t);
    if (segs && segs.every((s) => s[1] != null)) {
      f.gpu = segs.reduce((a, s) => a + s[1], 0);
      let m = null;
      for (const s of segs) if (!m || s[1] > m[1]) m = s;
      f.gmax = m;
      f.segs = segs;
    } else f.gpu = gpuBy.has(f.t) ? gpuBy.get(f.t) : null;
  }
  // first-time draws per frame
  const names = fd ? fd.names() : new Map();
  const firstsBy = new Map();
  if (fd) for (const x of fd.firsts) { if (x.i < 0) continue; const a = firstsBy.get(x.i) || []; a.push(x); firstsBy.set(x.i, a); }
  const fdText = (from, to) => {
    const out = [];
    for (let k = from; k <= to; k++) for (const x of firstsBy.get(k) || []) out.push(`[${k}] prog${x.prog} ${(names.get(x.prog) || "?").split(" ")[0]} fb${x.fb} ${x.mode.replace("draw", "")}(${x.n}) {${x.attrs}}`);
    return out;
  };
  const QUIET = /^(combat\.update|dash\.update|damage\.update|damage\.follow|crosshair\.flush|hitmarker\.flush|combo\.update|plate\.paintball|clock\.set|plate\.visible|spear\.update)$/;
  const cmdText = (from, to) => {
    const o = [];
    for (let k = Math.max(0, from); k <= to; k++) { const c = fr[k] && fr[k].cmds; if (!c) continue; for (const n in c) if (!QUIET.test(n)) o.push(`${n}@${k}`); }
    return o.join(" ");
  };
  const glText = (from, to) => {
    const o = {};
    for (let k = Math.max(0, from); k <= to; k++) { const g = fr[k] && fr[k].gl; if (!g) continue; for (const n in g) { if (n === "bufferSubData" || n === "texSubImage2D") continue; const e = o[n] || (o[n] = [0, 0]); e[0] += g[n][0]; e[1] += g[n][1]; } }
    return Object.entries(o).map(([n, v]) => `${n}×${v[0]}${v[1] ? " " + Math.round(v[1] / 1024) + "K" : ""}`).join(" ");
  };
  const ev = (a, b) => {
    const e = [];
    if (b.st[2] > a.st[2]) e.push("KILL");
    if (b.st[3] > a.st[3]) e.push("MORT");
    if (b.st[0] === 1 && a.st[0] === 0) e.push("RESPAWN");
    if (b.st[1] > a.st[1]) e.push("dégâts");
    if (b.fire && !a.fire) e.push("tir↓");
    return e;
  };
  const n = fr.length;
  const dts = [];
  for (let i = 1; i < n; i++) dts.push(fr[i].t - fr[i - 1].t);
  const sd = dts.slice().sort((a, b) => a - b);
  const sorted = (key) => fr.map((f) => f[key]).filter((x) => x != null).sort((a, b) => a - b);
  const cpus = sorted("cpu"), posts = sorted("post"), gpus = sorted("gpu");
  let missed = 0;
  for (const d of dts) missed += Math.max(0, Math.round(d / budget) - 1);
  const span = n > 1 ? fr[n - 1].t - fr[0].t : 0;
  const stat = (a) => ({ p50: r1(pct(a, 0.5)), p90: r1(pct(a, 0.9)), p99: r1(pct(a, 0.99)), max: r1(a[a.length - 1]) });
  const summary = {
    frames: n, seconds: r1(span / 1000), fps: span ? r1((1000 * (n - 1)) / span) : 0, missedRefreshes: missed,
    dt: { ...stat(sd), p999: r1(pct(sd, 0.999)) },
    late: { over6: dts.filter((d) => d > 6.25).length, over8: dts.filter((d) => d > 8.4).length, over12: dts.filter((d) => d > 12.5).length, over25: dts.filter((d) => d > 25).length, over50: dts.filter((d) => d > 50).length },
    cpu: stat(cpus), post: stat(posts), gpu: stat(gpus),
    kills: n ? fr[n - 1].st[2] - fr[0].st[2] : 0, deaths: n ? fr[n - 1].st[3] - fr[0].st[3] : 0, loaf: kw.loaf.length,
    firsts: fd ? fd.firsts.length : null, heapMB: n ? [fr[0].heap0, fr[n - 1].heap1] : null,
  };
  const late = [];
  for (let i = 1; i < n; i++) {
    const d = fr[i].t - fr[i - 1].t;
    if (d < lateMs) continue;
    const a = fr[i - 1];
    const lead = a.cb0 - a.t;
    const wait = d - lead - a.cpu - (a.post || 0);
    const evs = [];
    for (let k = Math.max(1, i - 8); k <= i; k++) for (const e of ev(fr[k - 1], fr[k])) evs.push(`${e}@${k - i}`);
    const g = [];
    for (let k = Math.max(0, i - 4); k <= i; k++) { const f = fr[k]; g.push(f.gpu == null ? "-" : `${f.gpu.toFixed(1)}${f.gmax && f.gmax[1] > 1.5 ? `(fb${f.gmax[0]}:${f.gmax[1].toFixed(1)})` : ""}`); }
    late.push({
      i, at: r1((fr[i].t - fr[0].t) / 1000), dt: r1(d), lead: r1(lead), jeu: r1(a.cpu), nav: r1(a.post), att: r1(wait),
      gpu: g.join(" "), ev: evs.join(" "), fire: a.fire, cmds: cmdText(i - 6, i - 1), gl: glText(i - 4, i - 1), firsts: fdText(i - 6, i),
      heapDrop: r1(Math.max(0, a.heap1 - fr[i].heap0)),
      loaf: kw.loaf.filter((L) => L.t1 > a.cb0 - 1 && L.t0 < fr[i].t + 1).map((L) => `LoAF ${L.dur}ms block ${L.block} [${L.scripts.join(" | ")}]`),
    });
  }
  late.sort((x, y) => y.dt - x.dt);
  const around = (pred, label) => {
    const out = [];
    for (let i = 1; i < n; i++) {
      if (!pred(fr[i - 1], fr[i])) continue;
      let worst = 0, worstAt = 0, lost = 0;
      for (let k = i; k < Math.min(n, i + 240); k++) { const d = fr[k].t - fr[k - 1].t; lost += Math.max(0, Math.round(d / budget) - 1); if (d > worst) { worst = d; worstAt = k - i; } }
      const row = (key, from, to, fmt) => fr.slice(Math.max(0, from), Math.min(n, to)).map(fmt).join(" ");
      out.push({
        label, at: r1((fr[i].t - fr[0].t) / 1000), i, worstDt: r1(worst), worstAt, lostIn1s: lost,
        dt: row("dt", i - 1, i + 14, (f) => { const p = fr[f.i - 1]; return p ? Math.round(f.t - p.t) : "-"; }),
        cpu: row("cpu", i - 1, i + 8, (f) => f.cpu.toFixed(1)),
        gpu: row("gpu", i - 1, i + 10, (f) => (f.gpu == null ? "-" : f.gpu.toFixed(1))),
        cmds: cmdText(i - 1, i + 3), gl: glText(i - 1, i + 3), firsts: fdText(i - 1, i + 12),
      });
    }
    return out;
  };
  return {
    summary, late: late.slice(0, opts.top || 30),
    kills: around((a, b) => b.st[2] > a.st[2], "KILL"), deaths: around((a, b) => b.st[3] > a.st[3], "MORT"), respawns: around((a, b) => b.st[0] === 1 && a.st[0] === 0, "RESPAWN"),
    fbInfo: sp ? [...sp.fbInfo.entries()].map(([k, v]) => `fb${k} ${v}`) : null,
  };
});
