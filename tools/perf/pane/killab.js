// Kills on demand, in a real match, and the HUD's share of their cost (page realm, in the menu,
// after boot.js — production build). Used on the PC gamer on 23/10 (tests 11-15, PERFORMANCE.md
// « Les chutes au kill : l'empilement des effets du HUD »).
//   - a scripted player (__rp): aims at the live bot most in front, fires the paintball rifle on
//     target, reloads, moves (W, strafes, jumps, dash, slide), switches weapons after a respawn;
//     reads its ammo from the weapon itself (never from the HUD commands, which may be filtered);
//   - deterministic REAL kills (__kl): on a frame where the player is on target and firing, the
//     targeted bot gets 1 HP and the rifle's own hit path runs on it (applyLocalDamage: ragdoll
//     impact, damage, hit feedback → the game's whole death path); __kl.seq = [[zone, delay to the
//     next kill (ms)], …] cycled — singles, doubles, headshots by default;
//   - kills / deaths from the game's Health callbacks (__K), not from the HUD;
//   - the player takes the bots' hits but never dies (__pg.on: a lethal hit refills HP first);
//   - a filter of the HUD batches (__filt.mode): "all" · "nokill" (no kill-only effect) · "noplate"
//     (no paintball plate update: no per-shot paint) · "groups" (__filt.drop = Set of medal, combo,
//     ks, lb, hit, ck) · "stagger" (the kill effects over a few frames: __filt.delay, the
//     prototype of hud/host/killCascade.ts);
//   - one record per game frame (__kw.frames: t, cb0, cb1, cpu, post, fire, ammo, k, d, a, m, c, kc).
// Then a test script: start a match (see match.js), __g.bind(), __pg.on = true,
// await __rp.calibrate(), __kw.on = true, __rp.start(), __kl.on = true, blocks of __filt.mode with
// __kw.mark set; a late frame = a gap of k budgets (k − 1 missed refreshes), "cpu" when the
// previous frame's lead + game + browser work fills it, "att" (GPU wait) otherwise.
await (async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 84; i++) { await sleep(500); if (document.querySelector("#menu-cta") && performance.getEntriesByType("mark").some((m) => /boot:menu/.test(m.name))) break; } })();
(() => {
  // ------------------------------------------------------------ probe-lite: game frames = frames with draws
  const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const gl = canvas.getContext("webgl2"); const P = Object.getPrototypeOf(gl);
  const bz = (window.__bz = { gl, cbDraws: 0 });
  for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"]) { const f = P[name]; P[name] = function () { if (this === gl) bz.cbDraws++; return f.apply(this, arguments); }; }
  const origRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { return origRaf.call(window, function (t) { bz.cbDraws = 0; cb(t); }); };
  // ------------------------------------------------------------ scene + camera actually rendered
  const obs = window.__obs;
  const rendered = new Map();
  for (const r of obs.renderers) { const o = r.render; r.render = function (s, c) { if (s && c) { rendered.set(s, c); if (c.isPerspectiveCamera) window.__cam = c; } return o.call(this, s, c); }; }
  // ------------------------------------------------------------ HUD tap (alive only) — inner wrapper
  const hud = (window.__hud = { alive: true, port: null });
  const nativePost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    if (msg && msg.t === "batch" && Array.isArray(msg.cmds)) {
      if (!hud.port) { hud.port = this; hookStats(this); }
      for (const c of msg.cmds) { if (c && c[0] === "combat.update" && c[2] && typeof c[2].alive === "boolean" && c[2].alive !== hud.alive) { hud.alive = c[2].alive; onAliveChange(hud.alive); } }
    }
    return nativePost.call(this, msg, ...rest);
  };
  // HUD document stats (every 500 ms: frames drawn, JS per batch, browser work per frame drawn)
  const HS = (window.__hs = []);
  function hookStats(port) { port.addEventListener("message", (e) => { const d = e.data; if (d && d.t === "stats") HS.push({ t: performance.now(), fps: +d.fps.toFixed(1), apply: +d.applyMs.toFixed(2), render: +d.renderMs.toFixed(2), m: window.__kw ? window.__kw.mark : "" }); }); }
  // ------------------------------------------------------------ input
  const keyName = (code) => (code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code === "Space" ? " " : code.startsWith("Shift") ? "Shift" : code);
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, key: keyName(code), bubbles: true, cancelable: true }));
  window.__key = key;
  const look = (dx, dy) => document.dispatchEvent(new MouseEvent("mousemove", { movementX: dx, movementY: dy, bubbles: true }));
  let firing = false;
  const fire = (on) => { if (on === firing) return; firing = on; window.dispatchEvent(new MouseEvent(on ? "mousedown" : "mouseup", { button: 0, buttons: on ? 1 : 0, bubbles: true })); };
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // ------------------------------------------------------------ game objects (after the match started)
  const G = (window.__g = { bots: [], player: null, pb: null, scene: null });
  G.bind = () => {
    let best = null, bestN = 0;
    for (const [s] of rendered) { let n = 0; s.traverse(() => n++); if (n > bestN) { best = s; bestN = n; } }
    G.scene = best;
    const bots = new Set();
    best.traverse((o) => { const c = o.userData && o.userData.combatant; if (c && c.ai && c.model) bots.add(c); });
    G.bots = [...bots];
    const deps = G.bots[0] && G.bots[0].weaponWorld && G.bots[0].weaponWorld.deps;
    G.pb = deps ? deps.paintball : null;
    G.player = G.pb ? G.pb.owner : null;
    if (G.bots.length && G.player) { hookDeaths(); guardPlayer(); }
    return { bots: G.bots.length, player: !!G.player, pb: !!G.pb, ammo: G.pb && G.pb.ammo, sceneSize: bestN };
  };
  // ------------------------------------------------------------ kills / deaths from the game (exact frame)
  const K = (window.__K = { kills: 0, deaths: 0, otherKills: 0, armed: null, armedAt: 0, armLog: [], killLog: [] });
  // The player takes the bots' hits (damage HUD) but never dies: a hit that would kill refills HP first.
  const PG = (window.__pg = { on: false, saves: 0 });
  function guardPlayer() {
    const h = G.player.health;
    if (h.__pgHooked) return;
    h.__pgHooked = true;
    const orig = h.applyDamage;
    h.applyDamage = function (amount) { if (PG.on && this.alive && this.current - amount <= 1) { this.current = this.max; PG.saves++; } return orig.apply(this, arguments); };
  }
  function hookDeaths() {
    for (const b of G.bots) {
      if (b.health.__kHooked) continue;
      b.health.__kHooked = true;
      const orig = b.health.onDeath;
      b.health.onDeath = function (killer, method, zone) {
        if (killer === G.player) { K.kills++; K.killLog.push({ t: performance.now(), armed: K.armed === b, zone, f: window.__kw ? window.__kw.frames.length : -1 }); if (K.armed === b) K.armed = null; }
        else K.otherKills++;
        return orig.apply(this, arguments);
      };
    }
    const ph = G.player.health;
    if (!ph.__kHooked) {
      ph.__kHooked = true;
      const origP = ph.onDeath;
      ph.onDeath = function () { K.deaths++; return origP.apply(this, arguments); };
    }
  }
  // ------------------------------------------------------------ rp-lite: aim at the nearest bot in front, fire on target
  const RP = (window.__rp = { on: false, k: null, stats: { reloads: 0, respawns: 0, deaths: 0 }, targetBot: null });
  // Deterministic real kill: on a frame where the scripted player is on target and firing, the
  // targeted bot gets 1 HP and the paintball rifle's own hit path runs on it (applyLocalDamage:
  // impact for the ragdoll, damage, hit feedback → kill → the game's whole death path).
  // KL.seq: [[zone, delay to the NEXT kill (ms)], …], cycled — singles, doubles, headshots.
  const KL = (window.__kl = { on: false, seq: [["BODY", 5600], ["BODY", 1000], ["BODY", 5600], ["HEAD", 5600], ["BODY", 1000], ["HEAD", 5600]], idx: 0, next: 0, log: [], err: null });
  KL.tryKill = (bot, c, t) => {
    try {
      if (!bot.health.alive || bot.health.protectionTimer > 0 || !bot.model.group.visible) return;
      const [zone, delay] = KL.seq[KL.idx % KL.seq.length];
      let obj = null;
      if (zone === "HEAD") obj = bot.model.headHitbox || null;
      if (!obj) bot.model.group.traverse((o) => { if (!obj && o.isSkinnedMesh && o.name === "Potato") obj = o; });
      const pb = G.pb; const point = pb.ballDir.clone().set(c[0], c[1], c[2]);
      const before = K.kills;
      bot.health.current = Math.min(bot.health.current, 1);
      pb.applyLocalDamage({ object: obj || bot.model.group, point, distance: 10 }, bot);
      KL.log.push({ t, zone, ok: K.kills > before ? 1 : 0, f: window.__kw ? window.__kw.frames.length : -1 });
      KL.idx++; KL.next = t + delay;
    } catch (e) { KL.err = String(e && e.stack || e); KL.on = false; }
  };
  const camM = () => rendered.get(G.scene).matrixWorld.elements;
  const camPos = () => { const e = camM(); return [e[12], e[13], e[14]]; };
  const camFwd = () => { const e = camM(); return [-e[8], -e[9], -e[10]]; };
  const yawOf = (d) => Math.atan2(d[0], d[2]); const pitchOf = (d) => Math.atan2(d[1], Math.hypot(d[0], d[2]));
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const visibleChain = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const topOf = (o) => { while (o.parent) o = o.parent; return o; };
  const bodyCenter = (root) => { if (!root.__rpBody) { let body = null; root.traverse((o) => { if (!body && o.isSkinnedMesh && o.name === "Potato") body = o; }); root.__rpBody = body || root; if (body && !body.geometry.boundingSphere) body.geometry.computeBoundingSphere(); } const b = root.__rpBody; const e = b.matrixWorld.elements; const c = b.geometry && b.geometry.boundingSphere ? b.geometry.boundingSphere.center : { x: 0, y: 0, z: 0 }; return [e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14]]; };
  // Live bots only (the map's animated creatures, corpses and the viewmodel have mixers too).
  const botOf = (root) => { if (root.__bot === undefined) { let o = root, cb = null; while (o && !cb) { cb = o.userData && o.userData.combatant; o = o.parent; } root.__bot = cb && cb.ai ? cb : null; } return root.__bot; };
  RP.targets = () => { const out = []; if (!G.scene) return out; const p = camPos(); for (const m of obs.mixers) { const root = m.getRoot && m.getRoot(); if (!root || !root.isObject3D || topOf(root) !== G.scene || !visibleChain(root)) continue; const bot = botOf(root); if (!bot || !bot.health.alive) continue; const c = bodyCenter(root); const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]]; const dist = Math.hypot(d[0], d[1], d[2]); if (dist < 2.5 || c[1] < -100) continue; out.push({ root, c, d, dist }); } return out; };
  RP.calibrate = async () => { const read = () => { const f = camFwd(); return [yawOf(f), pitchOf(f)]; }; const res = {}; for (const [axis, dx, dy] of [["x", 40, 0], ["y", 0, 20]]) { await frames(3); const a = read(); look(dx, dy); await frames(4); const b = read(); look(-dx, -dy); await frames(4); const delta = axis === "x" ? wrap(b[0] - a[0]) : b[1] - a[1]; res[axis] = delta / (axis === "x" ? dx : dy); } RP.k = res; return res; };
  const timers = []; const tap = (code, ms = 80) => { key(code, true); timers.push(setTimeout(() => key(code, false), ms)); };
  function onAliveChange(alive) { if (!RP.on) return; if (!alive) { RP.stats.deaths++; fire(false); } else { RP.stats.respawns++; timers.push(setTimeout(() => tap("Digit2", 70), 250)); timers.push(setTimeout(() => tap("Digit1", 70), 650)); } }
  let target = null, lastPick = 0, strafe = "KeyA", lastFireT = 0, reloadAt = 0;
  const aimLoop = (t) => {
    if (!RP.on) return;
    try {
      const pb = G.pb; const ammo = pb ? pb.ammo : null; const reloading = pb ? !!pb.isReloading : false;
      if (hud.alive && G.scene && RP.k) {
        if (t - lastPick > 150 || !target || !visibleChain(target.root)) { lastPick = t; const list = RP.targets(); const f = camFwd(); const fy = yawOf(f); let best = null, bestScore = Infinity; for (const c of list) { const turn = Math.abs(wrap(yawOf(c.d) - fy)); const score = c.dist + turn * 25; if (score < bestScore) { bestScore = score; best = c; } } target = best; }
        if (target) { if (target.root.__bot === undefined) { let o = target.root, cb = null; while (o && !cb) { cb = o.userData && o.userData.combatant; o = o.parent; } target.root.__bot = cb && cb.ai ? cb : null; } RP.targetBot = target.root.__bot; const c = bodyCenter(target.root); const p = camPos(); const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]]; const f = camFwd(); const ey = wrap(yawOf(d) - yawOf(f)); const ep = pitchOf(d) - pitchOf(f); let mx = (ey * 0.45) / RP.k.x, my = (ep * 0.45) / RP.k.y; mx = Math.max(-120, Math.min(120, mx)); my = Math.max(-60, Math.min(60, my)); if (Math.abs(mx) >= 0.5 || Math.abs(my) >= 0.5) look(Math.round(mx), Math.round(my)); const onTarget = Math.abs(ey) < 0.05 && Math.abs(ep) < 0.05; if (onTarget && !reloading && ammo !== 0) { fire(true); lastFireT = t; } else if (t - lastFireT > 250) fire(false); if (KL.on && onTarget && firing && t >= KL.next && RP.targetBot) KL.tryKill(RP.targetBot, c, t); }
        else { fire(false); look(8, 0); }
        if (ammo === 0 && !reloading && t - reloadAt > 600) { fire(false); tap("KeyR", 70); RP.stats.reloads++; reloadAt = t; }
      }
    } catch (e) { RP.err = String(e && e.stack || e); }
    requestAnimationFrame(aimLoop);
  };
  const every = (ms, fn) => timers.push(setInterval(() => { if (RP.on && hud.alive) fn(); }, ms));
  RP.start = () => { if (RP.on) return "on"; RP.on = true; key("KeyW", true); key(strafe, true); requestAnimationFrame(aimLoop); every(900, () => { key(strafe, false); strafe = strafe === "KeyA" ? "KeyD" : "KeyA"; key(strafe, true); }); every(1900, () => tap("Space", 90)); every(3300, () => tap("KeyE", 90)); every(5300, () => tap("ShiftLeft", 600)); return "started"; };
  RP.stop = () => { RP.on = false; for (const t of timers) { clearInterval(t); clearTimeout(t); } timers.length = 0; ["KeyW", "KeyA", "KeyD", "Space", "KeyE", "ShiftLeft"].forEach((c) => key(c, false)); fire(false); return "stopped"; };
  // ------------------------------------------------------------ HUD filter (outer wrapper: runs before the tap)
  const F = (window.__filt = { mode: "all", sent: 0, dropped: 0, drop: new Set() });
  const KILL_ONLY = new Set(["combat.kill", "combo.kill", "combo.update", "medal.show", "medal.exit", "medal.hide", "killstreak.render", "killstreak.ready", "leaderboard.refresh"]);
  const GROUP = { "medal.show": "medal", "medal.exit": "medal", "medal.hide": "medal", "combo.kill": "combo", "combo.update": "combo", "killstreak.render": "ks", "killstreak.ready": "ks", "leaderboard.refresh": "lb", "combat.kill": "ck" };
  const groupOf = (c) => { const n = c && c[0]; if (GROUP[n]) return GROUP[n]; if ((n === "hitmarker.show" && c[3] === true) || (n === "damage.hit" && c[6] === true) || (n === "damage.orphan" && c[3] === true)) return "hit"; return null; };
  F.groupOf = groupOf;
  let frameCmds = 0;
  let frameKillCmds = "";
  // Stagger (prototype of a fix): the kill's HUD effects start over a few frames instead of one —
  // per group, a delay in game frames (batches); a group with queued commands queues its next ones
  // too (order kept within a group). hit = 0 (the kill hitmarker / number stay immediate).
  F.delay = { medal: 2, ck: 4, combo: 4, ks: 6, lb: 8 };
  const Q = { list: [], batch: 0 };
  F.q = Q;
  const innerPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    if (msg && msg.t === "batch" && Array.isArray(msg.cmds) && F.mode === "stagger") {
      Q.batch++;
      frameCmds += msg.cmds.length;
      const keep = [];
      for (const c of msg.cmds) {
        const gr = groupOf(c);
        if (!gr) { keep.push(c); continue; }
        let lastAt = -1;
        for (const x of Q.list) if (x.gr === gr && x.at > lastAt) lastAt = x.at;
        const d = F.delay[gr] || 0;
        const trigger = c[0] !== "combo.update" && c[0] !== "medal.exit" && c[0] !== "medal.hide";
        if (lastAt >= 0) Q.list.push({ gr, c, at: lastAt }); // same group already waiting: keep the order
        else if (d > 0 && trigger) Q.list.push({ gr, c, at: Q.batch + d });
        else keep.push(c);
      }
      // release what is due, in arrival order
      for (let i = 0; i < Q.list.length; ) { if (Q.list[i].at <= Q.batch) { const x = Q.list.splice(i, 1)[0]; keep.push(x.c); } else i++; }
      F.sent += keep.length;
      for (const c of keep) { if (c[0] !== "combo.update" && groupOf(c)) frameKillCmds += (frameKillCmds ? "," : "") + (c[0] === "medal.show" ? `medal:${c[1]}/${c[2]}` : c[0]); }
      if (!keep.length) return;
      return innerPost.call(this, { ...msg, cmds: keep }, ...rest);
    }
    if (msg && msg.t === "batch" && Array.isArray(msg.cmds) && Q.list.length) {
      // left the stagger mode with commands still waiting: they go now, before this frame's
      msg = { ...msg, cmds: Q.list.splice(0).map((x) => x.c).concat(msg.cmds) };
    }
    if (msg && msg.t === "batch" && Array.isArray(msg.cmds)) {
      frameCmds += msg.cmds.length;
      if (F.mode !== "all") {
        const keep = [];
        for (const c of msg.cmds) {
          const n = c && c[0];
          let drop = false;
          if (F.mode === "nokill") drop = KILL_ONLY.has(n) || (n === "hitmarker.show" && c[3] === true) || (n === "damage.hit" && c[6] === true) || (n === "damage.orphan" && c[3] === true);
          else if (F.mode === "noplate") drop = n === "plate.paintball";
          else if (F.mode === "groups") { const gr = groupOf(c); drop = gr !== null && F.drop.has(gr); }
          if (drop) F.dropped++; else keep.push(c);
        }
        F.sent += keep.length;
        for (const c of keep) { if (c[0] !== "combo.update" && groupOf(c)) frameKillCmds += (frameKillCmds ? "," : "") + (c[0] === "medal.show" ? `medal:${c[1]}/${c[2]}` : c[0]); }
        if (!keep.length) return; // nothing left this frame
        msg = { ...msg, cmds: keep };
      } else { F.sent += msg.cmds.length; for (const c of msg.cmds) { if (c[0] !== "combo.update" && groupOf(c)) frameKillCmds += (frameKillCmds ? "," : "") + (c[0] === "medal.show" ? `medal:${c[1]}/${c[2]}` : c[0]); } }
    }
    return innerPost.call(this, msg, ...rest);
  };
  // ------------------------------------------------------------ recorder (one entry per game frame)
  const KW = (window.__kw = { on: false, frames: [], mark: "" });
  const byT = new Map(); const chan = new MessageChannel(); chan.port1.onmessage = (e) => { const f = byT.get(e.data); if (f) { f.post = performance.now() - f.cb1; byT.delete(e.data); } };
  const prevRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { return prevRaf.call(window, function (t) { if (!KW.on) return cb(t); const d0 = bz.cbDraws; const c0 = frameCmds; const cb0 = performance.now(); try { cb(t); } finally { const cb1 = performance.now(); if (bz.cbDraws > d0) { const pb = G.pb; const f = { t, cb0, cb1, cpu: cb1 - cb0, post: null, fire: firing ? 1 : 0, ammo: pb ? pb.ammo : -1, k: K.kills, d: K.deaths, a: hud.alive ? 1 : 0, m: KW.mark, c: frameCmds - c0, kc: frameKillCmds }; frameKillCmds = ""; KW.frames.push(f); byT.set(t, f); chan.port2.postMessage(t); } } }); };
  return "killab ready";
})()
