// Light CPU profile of the game's hot spots (page realm, in a match, after tools that bind
// window.__g = { scene, bots, player, pb } — e.g. the test-11 tools). Unlike cpuprof.js (every
// method of ~100 classes: 2-3 ms of overhead per frame at 240 Hz), it wraps a FEW named methods,
// so their times are close to the real ones: the bots' weapons (and their shared weapon world:
// raycasts, popcorn pellets), the player's paintball rifle and its effects, the corpses, the
// physics step, three's raycaster / mixer / render.
//   __lp.start() / __lp.stop()
//   __lp.report() → { frames, avg: per method ms/frame and ms/call, late: frames over the 240 Hz
//        budget with their top methods, perCall: max and p99 of each method's single calls }
(() => {
  if (window.__lp) return "lp already";
  const g = window.__g, obs = window.__obs, bz = window.__bz;
  if (!g || !g.scene || !g.bots || !g.bots.length) return "lp needs __g bound (bots, scene)";
  const LP = (window.__lp = { on: false });
  const names = [], acc = new Float64Array(256), cnt = new Uint32Array(256);
  const calls = []; // per method: single-call durations (ring of 4096)
  const protoOf = (o) => (o && typeof o === "object" ? Object.getPrototypeOf(o) : null);
  const done = new Set();
  const wrap = (label, proto, list) => {
    if (!proto) return 0;
    let n = 0;
    for (const name of list === "*" ? Object.getOwnPropertyNames(proto) : list) {
      if (name === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== "function" || !d.writable) continue;
      const key = `${label}.${name}`;
      if (done.has(proto[name])) continue;
      const i = names.length; names.push(key); calls.push({ ring: new Float32Array(4096), n: 0 });
      const f = d.value;
      const w = function () {
        if (!LP.on) return f.apply(this, arguments);
        const t0 = performance.now();
        try { return f.apply(this, arguments); } finally { const dt = performance.now() - t0; acc[i] += dt; cnt[i]++; const c = calls[i]; c.ring[c.n++ & 4095] = dt; }
      };
      done.add(w);
      proto[name] = w;
      n++;
    }
    return n;
  };
  const bot = g.bots[0];
  const ww = bot.weaponWorld, deps = ww && ww.deps;
  const counts = {
    bot: wrap("bot", protoOf(bot), ["update", "postStep", "updateWeapon", "onDeath"]),
    botWeapon: wrap("botWeapon", protoOf(bot.weapon), "*"),
    weaponWorld: wrap("weaponWorld", protoOf(ww), "*"),
    popcorn: deps && wrap("popcorn", protoOf(deps.popcorn), ["update", "postCameraUpdate", "fire"]),
    popcornPellets: deps && deps.popcorn && wrap("popcornPellets", protoOf(deps.popcorn.projectiles), ["update", "spawn"]),
    paintball: wrap("paintball", protoOf(g.pb), ["update", "fire", "applyLocalDamage", "postCameraUpdate"]),
    paintFx: g.pb && wrap("paintFx", protoOf(g.pb.fx), ["update", "characterHit", "surfaceHit", "spawn", "clearPaintUnder"]),
    raycaster: ww && wrap("raycaster", protoOf(ww.ray), ["intersectObjects", "intersectObject"]),
    corpses: wrap("corpses", protoOf(bot.corpses), ["spawn", "update"]),
    physics: wrap("physics", protoOf(bot.physics), ["step"]),
    mixer: obs.mixers[0] && wrap("mixer", protoOf(obs.mixers[0]), ["update"]),
    render: wrap("three", protoOf(obs.renderers[0]), ["render"]),
  };
  const RING = 240;
  const ring = new Float32Array(RING * 256), ringCpu = new Float32Array(RING);
  let head = 0, frames = 0;
  const totals = new Float64Array(256), totalN = new Float64Array(256);
  const late = [];
  const B = 1000 / 240;
  const prevRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return prevRaf.call(window, function (t) {
      if (!LP.on) return cb(t);
      const t0 = performance.now();
      try { cb(t); } finally {
        const cpu = performance.now() - t0;
        if (!bz || bz.cbDraws > 0) {
          for (let k = 0; k < names.length; k++) { totals[k] += acc[k]; totalN[k] += cnt[k]; }
          if (cpu > B && late.length < 400) {
            const top = [];
            for (let k = 0; k < names.length; k++) if (acc[k] >= 0.1) top.push(`${names[k]} ${acc[k].toFixed(2)}×${cnt[k]}`);
            top.sort((a, b) => parseFloat(b.split(" ")[1]) - parseFloat(a.split(" ")[1]));
            late.push({ f: frames, cpu: +cpu.toFixed(2), top: top.slice(0, 8).join(", ") });
          }
          acc.fill(0); cnt.fill(0);
          frames++;
        }
      }
    });
  };
  LP.start = () => { totals.fill(0); totalN.fill(0); acc.fill(0); cnt.fill(0); late.length = 0; frames = 0; for (const c of calls) c.n = 0; LP.on = true; return `lp on: ${names.length} methods ${JSON.stringify(counts)}`; };
  LP.stop = () => { LP.on = false; return `lp off: ${frames} frames, ${late.length} late`; };
  LP.report = () => {
    const avg = [];
    for (let k = 0; k < names.length; k++) if (totalN[k]) avg.push([names[k], totals[k] / Math.max(1, frames), totals[k] / totalN[k], totalN[k] / Math.max(1, frames)]);
    avg.sort((a, b) => b[1] - a[1]);
    const perCall = [];
    for (let k = 0; k < names.length; k++) {
      const c = calls[k]; const n = Math.min(c.n, 4096); if (!n) continue;
      const a = Array.from(c.ring.subarray(0, n)).sort((x, y) => x - y);
      perCall.push([names[k], a[a.length - 1], a[Math.floor(0.99 * (a.length - 1))], a[a.length >> 1], c.n]);
    }
    perCall.sort((a, b) => b[1] - a[1]);
    return {
      frames,
      avg: avg.slice(0, 30).map(([n, pf, pc, cf]) => `${n} ${pf.toFixed(3)} ms/image (${pc.toFixed(3)} ms × ${cf.toFixed(2)})`),
      perCall: perCall.slice(0, 25).map(([n, mx, p99, p50, nc]) => `${n} max ${mx.toFixed(2)} p99 ${p99.toFixed(2)} p50 ${p50.toFixed(3)} (${nc} appels)`),
      late: late.length, lateTop: late.slice(0, 60),
    };
  };
  LP.names = names;
  return `lp ready: ${names.length} methods ${JSON.stringify(counts)}`;
})();
