// "Plays like the owner" — evaluated in the GAME iframe's realm (host page + three devtools
// hook: window.__obs = { renderers, scenes, mixers }), after __abScript (window.__bz).
//   __rp.calibrate()            → mouse units per radian (yaw / pitch), sign included
//   __rp.start() / __rp.stop()  → aims at the nearest live bot (long range too), fires the
//                                 paintball rifle on target, moves fast (W, strafes, jumps,
//                                 dashes, slides), reloads when empty, and after each
//                                 respawn switches weapon and back (the owner's habit)
//   __rp.measure(seconds)       → window.__rpRes: per-second rows (frame rate, GPU of the
//                                 game's WebGL, CPU, draws, kills / deaths), alive / dead split,
//                                 debug-panel snapshots
(() => {
  if (window.__rp) return "rp already";
  const obs = window.__obs;
  if (!obs) return "no __obs (devtools hook missing)";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RP = (window.__rp = { on: false, stats: { kills: 0, deaths: 0, respawns: 0, switches: 0, fireOnMs: 0, reloads: 0, targetChanges: 0, noTargetMs: 0 }, k: null });

  // ---------------------------------------------------------------- HUD tap (local player's state)
  const hud = (RP.hud = { alive: true, dmg: 0, kill: 0, deaths: 0, msgs: 0, ammo: null, reloading: false, lastAliveChange: 0 });
  const origPost = MessagePort.prototype.postMessage;
  const scan = (m, depth) => {
    if (!m || depth > 4) return;
    if (Array.isArray(m)) {
      if (typeof m[0] === "string") {
        const k = m[0];
        if (k === "combat.update") {
          const h = m[2];
          if (h && typeof h.alive === "boolean" && h.alive !== hud.alive) {
            if (!h.alive) hud.deaths++;
            hud.alive = h.alive;
            hud.lastAliveChange = performance.now();
            onAliveChange(h.alive);
          }
        } else if (k === "combat.damage") hud.dmg++;
        else if (k === "combat.kill") hud.kill++;
        else if (k === "plate.paintball" && m[1]) { hud.ammo = m[1].ammo; hud.reloading = !!m[1].isReloading; }
        return;
      }
      for (let i = 0; i < m.length; i++) scan(m[i], depth + 1);
      return;
    }
    if (typeof m === "object") for (const key in m) { const v = m[key]; if (v && typeof v === "object") scan(v, depth + 1); }
  };
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    try { hud.msgs++; scan(msg, 0); } catch (e) { hud.err = String(e); }
    return origPost.call(this, msg, ...rest);
  };

  // ---------------------------------------------------------------- scene / camera
  const rendered = new Map(); // scene → last camera
  for (const r of obs.renderers) {
    if (r.__rpWrapped) continue;
    r.__rpWrapped = true;
    const orig = r.render;
    r.render = function (scene, camera) {
      if (scene && camera) rendered.set(scene, camera);
      return orig.call(this, scene, camera);
    };
  }
  const count = (s) => { let n = 0; s.traverse(() => n++); return n; };
  RP.pickScene = () => {
    let best = null, bestN = 0;
    for (const [s] of rendered) { const n = count(s); if (n > bestN) { best = s; bestN = n; } }
    RP.scene = best;
    RP.sceneSize = bestN;
    return bestN;
  };
  const topOf = (o) => { while (o.parent) o = o.parent; return o; };
  const visibleChain = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const camPos = () => { const e = rendered.get(RP.scene).matrixWorld.elements; return [e[12], e[13], e[14]]; };
  const camFwd = () => { const e = rendered.get(RP.scene).matrixWorld.elements; return [-e[8], -e[9], -e[10]]; };
  const yawOf = (d) => Math.atan2(d[0], d[2]);
  const pitchOf = (d) => Math.atan2(d[1], Math.hypot(d[0], d[2]));
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  // Live characters: animation mixers whose root is in the world scene, visible, not us.
  const bodyCenter = (root) => {
    if (!root.__rpBody) {
      let body = null;
      root.traverse((o) => { if (!body && o.isSkinnedMesh && o.name === "Potato") body = o; });
      root.__rpBody = body || root;
      if (body && !body.geometry.boundingSphere) body.geometry.computeBoundingSphere();
    }
    const b = root.__rpBody;
    const e = b.matrixWorld.elements;
    const c = b.geometry && b.geometry.boundingSphere ? b.geometry.boundingSphere.center : { x: 0, y: 0, z: 0 };
    return [e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14]];
  };
  RP.targets = () => {
    const out = [];
    if (!RP.scene) return out;
    const p = camPos();
    for (const m of obs.mixers) {
      const root = m.getRoot && m.getRoot();
      if (!root || !root.isObject3D || topOf(root) !== RP.scene || !visibleChain(root)) continue;
      const c = bodyCenter(root);
      const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      if (dist < 2.5 || c[1] < -100) continue; // ourselves / parked dead bots
      out.push({ root, c, d, dist });
    }
    return out;
  };

  // ---------------------------------------------------------------- input
  const keyName = (code) => (code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code === "Space" ? " " : code.startsWith("Shift") ? "Shift" : code);
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, key: keyName(code), bubbles: true, cancelable: true }));
  const timers = [];
  const tap = (code, ms = 80) => { key(code, true); timers.push(setTimeout(() => key(code, false), ms)); };
  let firing = false;
  const fire = (on) => {
    if (on === firing) return;
    firing = on;
    window.dispatchEvent(new MouseEvent(on ? "mousedown" : "mouseup", { button: 0, buttons: on ? 1 : 0, bubbles: true }));
  };
  const look = (dx, dy) => document.dispatchEvent(new MouseEvent("mousemove", { movementX: dx, movementY: dy, bubbles: true }));
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });

  RP.calibrate = async () => {
    if (!RP.scene) RP.pickScene();
    const read = () => { const f = camFwd(); return [yawOf(f), pitchOf(f)]; };
    const res = {};
    for (const [axis, dx, dy] of [["x", 40, 0], ["y", 0, 20]]) {
      await frames(3);
      const a = read();
      look(dx, dy);
      await frames(4);
      const b = read();
      look(-dx, -dy);
      await frames(4);
      const delta = axis === "x" ? wrap(b[0] - a[0]) : b[1] - a[1];
      res[axis] = delta / (axis === "x" ? dx : dy); // radians per unit (signed)
    }
    RP.k = res;
    return res;
  };

  function onAliveChange(alive) {
    if (!RP.on) return;
    if (!alive) {
      RP.stats.deaths++;
      fire(false);
    } else {
      RP.stats.respawns++;
      // The owner's habit when the weapon is missing after a death: switch and back.
      timers.push(setTimeout(() => { tap("Digit2", 70); RP.stats.switches++; }, 250));
      timers.push(setTimeout(() => { tap("Digit1", 70); }, 650));
    }
  }

  let target = null, lastPick = 0, strafe = "KeyA", lastFireT = 0, lastT = 0;
  const aimLoop = (t) => {
    if (!RP.on) return;
    const dtMs = lastT ? Math.min(100, t - lastT) : 16;
    lastT = t;
    try {
      if (hud.alive && RP.scene && RP.k) {
        if (t - lastPick > 150 || !target || !visibleChain(target.root)) {
          lastPick = t;
          const list = RP.targets();
          const f = camFwd();
          const fy = yawOf(f);
          // Prefer what is in front (cheap turn), then the nearest.
          let best = null, bestScore = Infinity;
          for (const c of list) {
            const turn = Math.abs(wrap(yawOf(c.d) - fy));
            const score = c.dist + turn * 25;
            if (score < bestScore) { bestScore = score; best = c; }
          }
          if ((best && best.root) !== (target && target.root)) RP.stats.targetChanges++;
          target = best;
        }
        if (target) {
          const c = bodyCenter(target.root);
          const p = camPos();
          const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
          const f = camFwd();
          const ey = wrap(yawOf(d) - yawOf(f));
          const ep = pitchOf(d) - pitchOf(f);
          // A fast player: most of the error each frame, capped flicks.
          const gain = 0.45;
          let mx = (ey * gain) / RP.k.x, my = (ep * gain) / RP.k.y;
          mx = Math.max(-120, Math.min(120, mx));
          my = Math.max(-60, Math.min(60, my));
          if (Math.abs(mx) >= 0.5 || Math.abs(my) >= 0.5) look(Math.round(mx), Math.round(my));
          const onTarget = Math.abs(ey) < 0.05 && Math.abs(ep) < 0.05;
          if (onTarget && !hud.reloading && hud.ammo !== 0) { fire(true); lastFireT = t; }
          else if (t - lastFireT > 250) fire(false);
          if (firing) RP.stats.fireOnMs += dtMs;
        } else {
          fire(false);
          RP.stats.noTargetMs += dtMs;
          look(8, 0); // scan around
        }
        if (hud.ammo === 0 && !hud.reloading) { tap("KeyR", 70); RP.stats.reloads++; hud.reloading = true; }
      }
    } catch (e) { RP.err = String(e && e.stack || e); }
    requestAnimationFrame(aimLoop);
  };
  const every = (ms, fn) => timers.push(setInterval(() => { if (RP.on && hud.alive) fn(); }, ms));
  RP.start = () => {
    if (RP.on) return "on";
    if (!RP.scene) RP.pickScene();
    RP.on = true;
    key("KeyW", true);
    key(strafe, true);
    requestAnimationFrame(aimLoop);
    every(900, () => { key(strafe, false); strafe = strafe === "KeyA" ? "KeyD" : "KeyA"; key(strafe, true); });
    every(1900, () => tap("Space", 90));
    every(3300, () => tap("KeyE", 90));
    every(5300, () => tap("ShiftLeft", 600));
    return "started";
  };
  RP.stop = () => {
    RP.on = false;
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    timers.length = 0;
    ["KeyW", "KeyA", "KeyD", "Space", "KeyE", "ShiftLeft"].forEach((c) => key(c, false));
    fire(false);
    return "stopped";
  };

  // ---------------------------------------------------------------- measurement
  const states = new Map();
  let recording = false;
  const rec = (t) => {
    if (recording) states.set(t, [hud.alive ? 1 : 0, hud.dmg, hud.kill, hud.deaths]);
    requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
  const dbg = () => (document.getElementById("debug")?.textContent || "").replace(/\n+/g, " | ");
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  RP.measure = async (seconds = 60, mode = "frame") => {
    window.__rpRes = null;
    const snaps = [];
    const snapTimer = setInterval(() => snaps.push([performance.now(), dbg(), hud.alive ? 1 : 0, hud.kill, hud.deaths]), 1000);
    recording = true;
    const r = await window.__bz.run(mode, seconds * 1000);
    recording = false;
    clearInterval(snapTimer);
    const fr = window.__bz.frames.slice();
    for (const f of fr) f.s = states.get(f.t) || null;
    const t0 = fr.length ? fr[0].t : 0;
    const rows = [];
    for (let sec = 0; sec < seconds; sec++) {
      const a = fr.filter((f) => f.t >= t0 + sec * 1000 && f.t < t0 + (sec + 1) * 1000);
      if (a.length < 2) { rows.push({ sec, n: a.length }); continue; }
      const g = a.filter((f) => f.gpu != null).map((f) => f.gpu).sort((x, y) => x - y);
      const dts = [];
      for (let i = 1; i < a.length; i++) dts.push(a[i].t - a[i - 1].t);
      const s0 = a[0].s, s1 = a[a.length - 1].s;
      rows.push({
        sec, n: a.length, maxDt: +Math.max(...dts).toFixed(1),
        gpu50: g.length ? +pct(g, 0.5).toFixed(1) : null, gpuMax: g.length ? +g[g.length - 1].toFixed(1) : null,
        cpu: +(a.reduce((s, f) => s + f.cpu, 0) / a.length).toFixed(1),
        draws: Math.round(a.reduce((s, f) => s + f.draws, 0) / a.length), ktris: Math.round(a.reduce((s, f) => s + f.tris, 0) / a.length / 1000),
        dead: a.filter((f) => f.s && f.s[0] === 0).length,
        dmg: s0 && s1 ? s1[1] - s0[1] : null, kills: s0 && s1 ? s1[2] - s0[2] : null,
      });
    }
    const split = (pred) => {
      const a = fr.filter(pred);
      const g = a.filter((f) => f.gpu != null).map((f) => f.gpu).sort((x, y) => x - y);
      const dts = [];
      for (let i = 1; i < fr.length; i++) if (pred(fr[i])) dts.push(fr[i].t - fr[i - 1].t);
      dts.sort((x, y) => x - y);
      return {
        frames: a.length, gpu50: g.length ? +pct(g, 0.5).toFixed(2) : null, gpu90: g.length ? +pct(g, 0.9).toFixed(2) : null,
        gpuMax: g.length ? +g[g.length - 1].toFixed(2) : null, cpu: a.length ? +(a.reduce((s, f) => s + f.cpu, 0) / a.length).toFixed(2) : null,
        dt50: dts.length ? +pct(dts, 0.5).toFixed(1) : null, dt95: dts.length ? +pct(dts, 0.95).toFixed(1) : null, late25: dts.filter((d) => d > 25).length,
      };
    };
    window.__rpRes = {
      summary: r, rp: { ...RP.stats }, hud: { kill: hud.kill, deaths: hud.deaths, dmg: hud.dmg, msgs: hud.msgs },
      alive: split((f) => f.s && f.s[0] === 1), dead: split((f) => f.s && f.s[0] === 0),
      rows, snaps: snaps.map(([t, text, alive, kills, deaths]) => ({ sec: Math.round((t - t0) / 1000), alive, kills, deaths, text })),
    };
    return "measured";
  };
  return `rp ready: ${obs.renderers.length} renderers, ${obs.scenes.length} scenes, ${obs.mixers.length} mixers`;
})();
