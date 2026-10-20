// HUD HOST + FACADES (game side of the HUD iframe) — headless checks of src/hud/host/*: what every
// facade sends (plain copies, never live objects), the order of the commands, the damage-number
// follow window, the "Hitch" labels moved from the widgets, the mode choice, the iframe handshake,
// the isolation check, the buffering + replay, every fallback to the HUD in the page, the warm-up,
// the per-frame batches and the stats. The browser is faked (timers, iframe, port, runtime): the
// real browser path is covered by the integrator's end-to-end check.
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-host.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });

// Controlled clock (the Hitch labels are timestamped with performance.now()).
let now = 10_000;
const realPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
/** Lets the host's promise chains run (ping / import / warm-up continuations). */
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

try {
  const P = await server.ssrLoadModule("/src/hud/host/HudProxies.ts");
  const H = await server.ssrLoadModule("/src/hud/host/HudHost.ts");
  const { HUD_HELLO, HUD_CONNECT } = await server.ssrLoadModule("/src/hud/protocol.ts");
  const { frameEventsBetween } = await server.ssrLoadModule("/src/ui/frameEvents.ts");
  const HFC = (await server.ssrLoadModule("/src/combat/HitFeedbackConfig.ts")).HitFeedbackConfig as Record<string, number>;
  const { HitZone } = await server.ssrLoadModule("/src/combat/HitZone.ts");
  const { Health } = await server.ssrLoadModule("/src/combat/Combatant.ts");
  const { KillMethod } = await server.ssrLoadModule("/src/combat/KillMethod.ts");
  const { HitFeedbackManager } = await server.ssrLoadModule("/src/combat/HitFeedbackManager.ts");
  const { KillstreakManager } = await server.ssrLoadModule("/src/killstreaks/KillstreakManager.ts");
  const { KillstreakState } = await server.ssrLoadModule("/src/killstreaks/KillstreakState.ts");

  type Cmd = [string, ...unknown[]];
  const recorder = () => {
    const cmds: Cmd[] = [];
    const mirror: boolean[] = [];
    const api = P.createHudProxies((c: Cmd) => cmds.push(c), { mirrorMenuActive: (on: boolean) => mirror.push(on) });
    return { api, cmds, mirror };
  };
  /** Labels noted by `fn` (each step on its own time slot: no 50 ms merge across steps). */
  const labelsOf = (fn: () => void): string[] => {
    now += 1000;
    const from = now;
    fn();
    return frameEventsBetween(from, now + 1);
  };
  const bot = (id: number, eye = new THREE.Vector3(1, 2, 3)) => {
    let reads = 0;
    const c = {
      id,
      name: `bot${id}`,
      health: new Health(100),
      velocity: new THREE.Vector3(),
      getPosition: (o: THREE.Vector3) => o.copy(eye),
      getEyePosition: (o: THREE.Vector3) => {
        reads++;
        return o.copy(eye);
      },
      applyImpulse() {},
      get eyeReads() {
        return reads;
      },
      eye,
    };
    c.health.onDamaged = () => {}; // function-valued property: a structured clone of the live Health throws
    return c;
  };

  console.log("Facades (HudApi):");

  await test("combat.update: a plain copy of Health (getter ratio read, nothing live), clonable, frozen at the call", () => {
    const { api, cmds } = recorder();
    const h = new Health(200);
    h.onDamaged = () => {};
    h.current = 150;
    assert.throws(() => structuredClone(h), "the live Health is not clonable (sanity)");
    api.combat.update(0.016, h, 2.5);
    const [name, dt, view, timer] = cmds[0];
    assert.equal(name, "combat.update");
    assert.equal(dt, 0.016);
    assert.equal(timer, 2.5);
    assert.deepEqual(view, { current: 150, max: 200, ratio: 0.75, alive: true });
    assert.equal(Object.getPrototypeOf(view), Object.prototype, "plain object");
    h.current = 10;
    assert.equal((view as { current: number }).current, 150, "copy taken at the call");
    assert.deepEqual(structuredClone(cmds[0]), cmds[0]);
  });

  await test("every facade emits its command with plain views, in call order (one batch = the frame's order)", () => {
    const { api, cmds } = recorder();
    const movement = { dashCooldownRemaining: 0.4, isDashing: false, extra: () => 1 };
    const spear = { rushCooldownRemaining: 1.5, isRushing: true, owner: { f: () => 0 } };
    const popcorn = { ammo: 2, isReloading: false, shotSerial: 7, sfx: { onShot() {} } };
    const ammo = { ammo: 24, isReloading: true, fx: { clearAll() {} } };
    const frisbee = { deckLoaded: true, cageCount: 4, discInHand: false, isReloading: false, shotSerial: 3, sfx: {} };
    const combo = new (class {
      onComboEnd = () => {};
      get active() { return true; }
      get comboCount() { return 3; }
      get ratio() { return 0.5; }
      get timeRemaining() { return 1.25; }
    })();
    api.dash.update(0.01, movement);
    api.spear.setVisible(true);
    api.spear.update(spear);
    api.popcorn.setVisible(true);
    api.popcorn.update(popcorn);
    api.paintball.setVisible(false);
    api.paintball.update(ammo);
    api.famas.update(ammo);
    api.frisbee.update(frisbee);
    api.combo.notifyKill();
    api.combo.update(combo);
    api.medal.show("DOUBLE_KILL", 2);
    api.medal.beginExit();
    api.medal.hide();
    api.clock.set(93.5);
    api.clock.set(null);
    api.interact.setPrompt("TERMINAL");
    api.interact.setPrompt(null);
    api.crosshair.fire();
    api.crosshair.fire("heavy");
    api.crosshair.setAiming(true);
    api.crosshair.flush();
    api.hitmarker.show(HitZone.HEAD);
    api.hitmarker.show(HitZone.BODY, 0.07, true);
    api.hitmarker.flush();
    api.combat.setKnockdown(true, false);
    api.combat.notifyDamage(12, 1.2);
    api.combat.notifyDamage(5);
    api.combat.notifyHeal(30);
    api.combat.notifyKill();
    api.combat.setPlayerName("Valentin");
    api.setDocClass("body", "game-paused", true);
    api.applyCrosshairSettings({ shape: "DOT", scale: 1.5, color: "#ff0000", highContrast: true, reducedMotion: false });
    assert.deepEqual(cmds, [
      ["dash.update", 0.01, { dashCooldownRemaining: 0.4, isDashing: false }],
      ["spear.visible", true],
      ["spear.update", { rushCooldownRemaining: 1.5, isRushing: true }],
      ["plate.visible", "popcorn", true],
      ["plate.popcorn", { ammo: 2, isReloading: false, shotSerial: 7 }],
      ["plate.visible", "paintball", false],
      ["plate.paintball", { ammo: 24, isReloading: true }],
      ["plate.famas", { ammo: 24, isReloading: true }],
      ["plate.frisbee", { deckLoaded: true, cageCount: 4, discInHand: false, isReloading: false, shotSerial: 3 }],
      ["combo.kill"],
      ["combo.update", { active: true, comboCount: 3, ratio: 0.5, timeRemaining: 1.25 }],
      ["medal.show", "DOUBLE_KILL", 2],
      ["medal.exit"],
      ["medal.hide"],
      ["clock.set", 93.5],
      ["clock.set", null],
      ["interact.prompt", "TERMINAL"],
      ["interact.prompt", null],
      ["crosshair.fire", "medium"],
      ["crosshair.fire", "heavy"],
      ["crosshair.aim", true],
      ["crosshair.flush"],
      ["hitmarker.show", HitZone.HEAD, null, false],
      ["hitmarker.show", HitZone.BODY, 0.07, true],
      ["hitmarker.flush"],
      ["combat.knockdown", true, false],
      ["combat.damage", 12, 1.2],
      ["combat.damage", 5, null],
      ["combat.heal", 30],
      ["combat.kill"],
      ["combat.name", "Valentin"],
      ["doc.class", "body", "game-paused", true],
      ["crosshair.settings", { shape: "DOT", scale: 1.5, color: "#ff0000", highContrast: true, reducedMotion: false }],
    ]);
    for (const c of cmds) assert.deepEqual(structuredClone(c), c, `${c[0]} is plain data`);
  });

  await test("leaderboard rows and crosshair settings are copied at the call (the stats records are mutated by the next kill)", () => {
    const { api, cmds } = recorder();
    const rows = [
      { combatantId: -1, displayName: "VALENTIN", isLocalPlayer: true, kills: 2, deaths: 0, assists: 1 },
      { combatantId: 3, displayName: "BOT 4", isLocalPlayer: false, kills: 1, deaths: 2, assists: 0, pingMs: 40 },
    ];
    api.leaderboard.refresh(rows);
    rows[0].kills = 3;
    const sent = cmds[0][1] as typeof rows;
    assert.equal(sent[0].kills, 2);
    assert.notEqual(sent[0], rows[0]);
    assert.equal(sent[1].pingMs, 40);
    const settings = { shape: "CROSS", scale: 1, color: "#fbf1da", highContrast: false, reducedMotion: true };
    api.applyCrosshairSettings(settings);
    settings.scale = 2;
    assert.equal((cmds[1][1] as typeof settings).scale, 1);
  });

  await test("killstreak: bind renders the manager once (the widget did on construction), render copies the slots, ready by index", () => {
    const { api, cmds } = recorder();
    const ks = new KillstreakManager();
    api.killstreak.bind(ks);
    ks.onChanged = () => api.killstreak.render();
    ks.onReady = (i: number) => api.killstreak.notifyReady(i);
    ks.setEquipped(["MOLE_STRIKE", "NONE", "NONE"]);
    const req = ks.slots[0].def.requiredKills as number;
    for (let i = 0; i < req; i++) ks.onPlayerKill();
    assert.deepEqual(cmds[0], ["killstreak.render", [
      { def: null, state: KillstreakState.LOCKED, kills: 0 },
      { def: null, state: KillstreakState.LOCKED, kills: 0 },
      { def: null, state: KillstreakState.LOCKED, kills: 0 },
    ]]);
    assert.deepEqual(cmds[1][1], [
      { def: { id: "MOLE_STRIKE", requiredKills: req }, state: KillstreakState.LOCKED, kills: 0 },
      { def: null, state: KillstreakState.LOCKED, kills: 0 },
      { def: null, state: KillstreakState.LOCKED, kills: 0 },
    ]);
    const tail = cmds.slice(-2);
    assert.deepEqual(tail[0], ["killstreak.ready", 0], "onReady fires before onChanged (manager order kept)");
    assert.deepEqual((tail[1][1] as { state: string }[])[0].state, KillstreakState.READY);
    for (const c of cmds) assert.deepEqual(structuredClone(c), c);
  });

  await test("phase / mole overlay opacity: sent only when it changes (Game writes the phase overlay every frame)", () => {
    const { api, cmds } = recorder();
    for (const o of [0, 0, 0, 0.37, 0.37, 0.12, 0, 0]) api.setPhaseOpacity(o);
    for (const o of [0, 0.5, 0.5, 0.92, 0.92, 0]) api.setMoleOpacity(o);
    assert.deepEqual(cmds, [
      ["phase.opacity", 0], ["phase.opacity", 0.37], ["phase.opacity", 0.12], ["phase.opacity", 0],
      ["mole.opacity", 0], ["mole.opacity", 0.5], ["mole.opacity", 0.92], ["mole.opacity", 0],
    ]);
  });

  await test("#hud.menu-active is mirrored on the game page's <html> (hud-menu-active) — that exact class only", () => {
    const { api, cmds, mirror } = recorder();
    api.setDocClass("hud", "menu-active", false);
    api.setDocClass("hud", "player-dead", true);
    api.setDocClass("body", "menu-active", true);
    api.setDocClass("hud", "menu-active", true);
    assert.deepEqual(mirror, [false, true]);
    assert.equal(cmds.length, 4, "every class still goes to the HUD document");
  });

  console.log("Hitch labels (moved from the widgets):");

  await test("dégâts (amount > 0 only), kill, soin, tir — noted at the call", () => {
    const { api } = recorder();
    assert.deepEqual(labelsOf(() => api.combat.notifyDamage(10, null)), ["dégâts"]);
    assert.deepEqual(labelsOf(() => api.combat.notifyDamage(0, null)), []);
    assert.deepEqual(labelsOf(() => api.combat.notifyKill()), ["kill"]);
    assert.deepEqual(labelsOf(() => api.combat.notifyHeal(25)), ["soin"]);
    assert.deepEqual(labelsOf(() => api.crosshair.fire("light")), ["tir"]);
    assert.deepEqual(labelsOf(() => api.hitmarker.show(HitZone.BODY)), [], "a hitmarker never noted anything");
  });

  await test("mort / réapparition: only when alive flips, never on the first update (CombatHUD rule)", () => {
    const { api } = recorder();
    const h = { current: 0, max: 100, ratio: 0, alive: false };
    assert.deepEqual(labelsOf(() => api.combat.update(0.016, h, 3)), [], "first update: no previous state");
    assert.deepEqual(labelsOf(() => api.combat.update(0.016, h, 2.9)), []);
    h.alive = true;
    assert.deepEqual(labelsOf(() => api.combat.update(0.016, h, 0)), ["réapparition"]);
    assert.deepEqual(labelsOf(() => api.combat.update(0.016, h, 0)), []);
    h.alive = false;
    assert.deepEqual(labelsOf(() => api.combat.update(0.016, h, 3)), ["mort"]);
  });

  await test("recharge: isReloading false → true on a plate that is not hidden; per plate; hidden plates ignored", () => {
    const { api } = recorder();
    const w = { ammo: 9, isReloading: false };
    const step = (reloading: boolean) => {
      w.isReloading = reloading;
      return labelsOf(() => api.famas.update(w));
    };
    api.famas.setVisible(true);
    assert.deepEqual(step(true), [], "first update shown: no previous state on the plate");
    assert.deepEqual(step(false), []);
    assert.deepEqual(step(false), []);
    assert.deepEqual(step(true), ["recharge"]);
    assert.deepEqual(step(true), [], "still reloading");
    assert.deepEqual(step(false), []);
    api.famas.setVisible(false);
    assert.deepEqual(step(true), [], "hidden plate: its updates are ignored by the widget");
    assert.deepEqual(step(false), []);
    api.famas.setVisible(true);
    assert.deepEqual(step(true), ["recharge"], "shown again: the plate last showed a non-reload state");
    // Another plate keeps its own history.
    const p = { ammo: 1, isReloading: true, shotSerial: 0 };
    api.popcorn.setVisible(true);
    assert.deepEqual(labelsOf(() => api.popcorn.update(p)), []);
    p.isReloading = false;
    api.popcorn.update(p);
    api.popcorn.setVisible(false);
    api.popcorn.setVisible(true); // a weapon switch resets the widget's change detection, not the plate's state
    p.isReloading = true;
    assert.deepEqual(labelsOf(() => api.popcorn.update(p)), ["recharge"]);
    const f = { deckLoaded: true, cageCount: 0, discInHand: false, isReloading: false, shotSerial: 0 };
    api.frisbee.setVisible(true);
    api.frisbee.update(f);
    f.isReloading = true;
    assert.deepEqual(labelsOf(() => api.frisbee.update(f)), ["recharge"]);
    const pb = { ammo: 0, isReloading: false };
    api.paintball.setVisible(true);
    api.paintball.update(pb);
    pb.isReloading = true;
    assert.deepEqual(labelsOf(() => api.paintball.update(pb)), ["recharge"]);
  });

  console.log("Damage numbers:");

  await test("keys: Combatant → \"#c<id>\", network sessionId as is; anchor copied at the call; follow key of the target", () => {
    const { api, cmds } = recorder();
    const b = bot(7);
    const anchor = new THREE.Vector3(4, 5, 6);
    api.damageNumbers.addHit(b, 23, HitZone.HEAD, anchor, b, false);
    anchor.set(0, 0, 0); // HitFeedbackManager reuses its scratch anchor at the next hit
    api.damageNumbers.addHit("sess-abc", 40, HitZone.BODY, new THREE.Vector3(1, 1, 1), null, true);
    api.damageNumbers.addOrphanHit(b, 5);
    api.damageNumbers.addOrphanHit("sess-abc", 6, true);
    assert.deepEqual(cmds, [
      ["damage.hit", "#c7", 23, HitZone.HEAD, [4, 5, 6], "#c7", false],
      ["damage.hit", "sess-abc", 40, HitZone.BODY, [1, 1, 1], null, true],
      ["damage.orphan", "#c7", 5, false],
      ["damage.orphan", "sess-abc", 6, true],
    ]);
    assert.equal(P.damageKey(bot(-1)), "#c-1");
  });

  await test("update: nothing before the first hit; then follow snapshot + camera snapshot (48 floats), a new array per call", () => {
    const { api, cmds } = recorder();
    const cam = new THREE.PerspectiveCamera(80, 16 / 9, 0.1, 400);
    cam.position.set(1, 2, 3);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    api.damageNumbers.update(1 / 60, cam);
    assert.equal(cmds.length, 0, "no number can exist: no traffic");
    const b = bot(1, new THREE.Vector3(9, 1, -4));
    api.damageNumbers.addHit(b, 10, HitZone.BODY, new THREE.Vector3(), b);
    cmds.length = 0;
    api.damageNumbers.update(1 / 60, cam);
    assert.deepEqual(cmds.map((c) => c[0]), ["damage.follow", "damage.update"], "follow BEFORE the projection");
    assert.deepEqual(cmds[0][1], [{ key: "#c1", alive: true, eye: [9, 1, -4] }]);
    const snap = cmds[1][2] as number[];
    assert.equal(cmds[1][1], 1 / 60);
    assert.equal(snap.length, 48);
    assert.deepEqual(snap.slice(0, 16), cam.matrixWorld.elements);
    assert.deepEqual(snap.slice(16, 32), cam.matrixWorldInverse.elements);
    assert.deepEqual(snap.slice(32), cam.projectionMatrix.elements);
    // Second projection of the frame (whirlwind spin): its own camera, dt 0.
    const spun = cam.clone();
    spun.rotation.y = 1;
    spun.updateMatrixWorld(true);
    spun.matrixWorldInverse.copy(spun.matrixWorld).invert();
    api.damageNumbers.update(0, spun);
    assert.notEqual(cmds[3][2], snap, "a new array per projection");
    assert.deepEqual((cmds[3][2] as number[]).slice(0, 16), spun.matrixWorld.elements);
    assert.deepEqual(snap.slice(0, 16), cam.matrixWorld.elements, "the first snapshot is untouched");
    // A copy from the projection reproduces Vector3.project(camera) exactly.
    const rebuilt = new THREE.PerspectiveCamera();
    rebuilt.matrixWorld.fromArray(snap, 0);
    rebuilt.matrixWorldInverse.fromArray(snap, 16);
    rebuilt.projectionMatrix.fromArray(snap, 32);
    const p = new THREE.Vector3(3, 1, -10);
    assert.deepEqual(p.clone().project(rebuilt).toArray(), p.clone().project(cam).toArray());
  });

  await test("dead target: alive=false and its eye position is never read (a dead bot is parked far away)", () => {
    const { api, cmds } = recorder();
    const b = bot(2);
    api.damageNumbers.addHit(b, 10, HitZone.BODY, new THREE.Vector3(), b);
    b.health.alive = false;
    const before = b.eyeReads;
    cmds.length = 0;
    api.damageNumbers.update(1 / 60, new THREE.PerspectiveCamera());
    assert.deepEqual(cmds[0][1], [{ key: "#c2", alive: false, eye: [0, 0, 0] }]);
    assert.equal(b.eyeReads, before);
  });

  await test("follow window = max(number lifetime, kill lifetime) + 0.5 s of the SAME deltas the HUD ages with; hits / orphans restart it", () => {
    const { api, cmds } = recorder();
    const cam = new THREE.PerspectiveCamera();
    const life = Math.max(HFC.damageNumberLifetime, HFC.damageNumberKillLifetime);
    const b = bot(3);
    api.damageNumbers.addHit(b, 10, HitZone.BODY, new THREE.Vector3(), b, true);
    const dt = 1 / 30; // the game clamps dt to 1/30
    let aged = 0;
    let lastEmitAt = -1;
    for (let i = 0; i < 200; i++) {
      cmds.length = 0;
      api.damageNumbers.update(dt, cam);
      aged += dt;
      if (cmds.length) lastEmitAt = aged;
    }
    assert.ok(lastEmitAt >= life + dt, `still projected after the kill number's last frame (${lastEmitAt.toFixed(3)} s ≥ ${life} s + dt)`);
    assert.ok(lastEmitAt <= life + 0.5 + 1e-9, "then silent");
    // Paused game (Escape menu): update is not called — the window does not run out on the wall clock.
    api.damageNumbers.addOrphanHit(b, 5);
    cmds.length = 0;
    now += 60_000;
    api.damageNumbers.update(dt, cam);
    assert.equal(cmds.length, 2, "an orphan hit restarts the window, measured in game time");
    // The followed target expires on its own: a target hit long ago leaves the snapshot.
    const other = bot(4);
    api.damageNumbers.addHit(other, 10, HitZone.BODY, new THREE.Vector3(), other);
    for (let i = 0; i < 60; i++) api.damageNumbers.update(dt, cam); // 2 s
    api.damageNumbers.addHit("sess", 10, HitZone.BODY, new THREE.Vector3(), null);
    cmds.length = 0;
    api.damageNumbers.update(dt, cam);
    assert.deepEqual(cmds[0][1], [], "#c3 / #c4 dropped once their numbers can no longer live");
  });

  await test("HitFeedbackManager on the facades: hitmarker + damage number (key #c<id>, follows its target, anchor above the eye)", () => {
    const { api, cmds } = recorder();
    const player = { id: -1 };
    const fb = new HitFeedbackManager(api.hitmarker, { burst() {} }, player);
    fb.damageNumbers = api.damageNumbers;
    const target = bot(5, new THREE.Vector3(0, 1, -12));
    fb.registerHit({ attacker: player, target, hitZone: HitZone.HEAD, damage: 34.5, position: new THREE.Vector3(0, 1.4, -12), weapon: KillMethod.PAINTBALL_RIFLE, isKill: false });
    assert.deepEqual(cmds, [
      ["hitmarker.show", HitZone.HEAD, HFC.paintballHeadHitmarkerDuration, false],
      ["damage.hit", "#c5", 34.5, HitZone.HEAD, [0, 1.45, -12], "#c5", false],
    ]);
  });

  console.log("Mode choice:");

  await test("?hud / ?hudUrl / production / DEV / loopback alias", () => {
    const loc = (hostname: string, port = "5173", protocol = "http:") => ({ protocol, hostname, port });
    const c = (prod: boolean, search: string, location = loc("slideio.vercel.app", "", "https:")) =>
      H.chooseHudMode({ prod, search, location });
    assert.deepEqual(c(true, ""), { mode: "frame", url: "/hud.html", sandboxed: true, forced: false });
    assert.deepEqual(c(false, ""), { mode: "inline", reason: "dev" });
    assert.deepEqual(c(true, "?hud=inline"), { mode: "inline", reason: "?hud=inline" });
    assert.deepEqual(c(true, "?hud=frame"), { mode: "frame", url: "/hud.html", sandboxed: true, forced: true });
    assert.deepEqual(c(false, "?hud=frame", loc("localhost")), { mode: "frame", url: "http://127.0.0.1:5173/hud.html", sandboxed: false, forced: true });
    assert.deepEqual(c(false, "?hud=frame", loc("127.0.0.1")), { mode: "frame", url: "http://localhost:5173/hud.html", sandboxed: false, forced: true });
    assert.deepEqual(c(false, "?hud=frame", loc("192.168.1.20")), { mode: "inline", reason: "pas d'alias local" });
    assert.deepEqual(c(false, "?hud=frame&hudUrl=sandbox", loc("192.168.1.20")), { mode: "frame", url: "/hud.html", sandboxed: true, forced: true });
    assert.deepEqual(c(true, "?hudUrl=alias", loc("localhost", "4173")), { mode: "frame", url: "http://127.0.0.1:4173/hud.html", sandboxed: false, forced: false });
    assert.deepEqual(c(true, "?hudUrl=alias", loc("localhost", "")), { mode: "frame", url: "http://127.0.0.1/hud.html", sandboxed: false, forced: false });
    assert.deepEqual(c(true, "?join=1&hud=bogus"), { mode: "frame", url: "/hud.html", sandboxed: true, forced: false });
  });

  // ---- A fake browser for the host: timers, rAF, iframe, port, runtime ----
  type Down = { t: string; [k: string]: unknown };
  function browser(opts: { prod?: boolean; search?: string; hidden?: boolean; isolated?: boolean; runtimeFails?: boolean; host?: string } = {}) {
    let clock = 0;
    let nextId = 1;
    let hidden = opts.hidden ?? false;
    let rafFrames = 100; // the HUD document's rAF counter
    const timers: { id: number; at: number; fn: () => void }[] = [];
    const rafs: (() => void)[] = [];
    const windowListeners = new Set<(e: { source: unknown; data: unknown }) => void>();
    const visibility = new Set<() => void>();
    const root: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    const frameWindow = { posted: [] as { msg: unknown; target: string; transfer?: unknown[] }[], postMessage(msg: unknown, target: string, transfer?: unknown[]) { this.posted.push({ msg, target, transfer }); } };
    let frame: { url: string; sandboxed: boolean; removed: boolean; contentWindow: typeof frameWindow; remove(): void } | null = null;
    const port = {
      sent: [] as Down[],
      listener: null as ((data: unknown) => void) | null,
      closed: false,
      autoPong: true,
      postMessage(m: Down) {
        assert.ok(!this.closed, "never posts on a closed port");
        this.sent.push(structuredClone(m)); // what the iframe receives: a structured clone
        if (m.t === "ping" && this.autoPong) queueMicrotask(() => this.listener?.({ t: "pong", frames: rafFrames }));
      },
      listen(fn: (data: unknown) => void) { this.listener = fn; },
      close() { this.closed = true; },
    };
    const runtime = {
      calls: [] as unknown[],
      paint: 1.5 as number | null,
      init(init: unknown) { this.calls.push(["init", init]); },
      apply(cmds: unknown[]) { for (const c of cmds) this.run(c); },
      run(cmd: unknown) { this.calls.push(cmd); },
      async warmUp(gpu: unknown) { this.calls.push(["warmUp", gpu === null ? null : "promise"]); },
      takePaintGpuMs() { return this.paint; },
    };
    let imports = 0;
    const env = {
      prod: opts.prod ?? true,
      search: opts.search ?? "",
      location: { protocol: "https:", hostname: opts.host ?? "slideio.vercel.app", port: "" },
      now: () => clock,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ id, at: clock + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      requestAnimationFrame: (fn: () => void) => { rafs.push(fn); },
      busyWait: (ms: number) => {
        clock += ms;
        if (opts.isolated !== false) rafFrames += Math.floor(ms / (1000 / 60)); // its own thread kept drawing
      },
      hidden: () => hidden,
      onVisibilityChange: (fn: () => void) => {
        visibility.add(fn);
        return () => visibility.delete(fn);
      },
      createFrame: (url: string, sandboxed: boolean) => {
        frame = { url, sandboxed, removed: false, contentWindow: frameWindow, remove() { this.removed = true; } };
        return frame;
      },
      onWindowMessage: (fn: (e: { source: unknown; data: unknown }) => void) => {
        windowListeners.add(fn);
        return () => windowListeners.delete(fn);
      },
      createChannel: () => ({ port1: port, port2: { name: "port2" } }),
      viewport: () => ({ width: 2844, height: 1600, dpr: 0.9 }),
      setRootClass: (name: string, on: boolean) => root.push(`${on ? "+" : "-"}${name}`),
      importRuntime: () => {
        imports++;
        return opts.runtimeFails ? Promise.reject(new Error("chunk failed")) : Promise.resolve({ createHudRuntime: () => runtime });
      },
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    };
    return {
      env, port, runtime, root, warns, errors, frameWindow,
      get frame() { return frame; },
      get imports() { return imports; },
      get rafCount() { return rafs.length; },
      /** The HUD document's main thread ran `n` more frames. */
      frames(n: number) { rafFrames += n; },
      /** Runs the timers due within `ms` (in time order, nested ones included). */
      async advance(ms: number) {
        const end = clock + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at || a.id - b.id);
          const t = timers[0];
          if (!t || t.at > end) break;
          timers.shift();
          clock = t.at;
          t.fn();
          await settle();
        }
        clock = end;
        await settle();
      },
      runRaf() {
        const list = rafs.splice(0);
        for (const fn of list) fn();
      },
      hello(source: unknown = frameWindow) {
        for (const fn of [...windowListeners]) fn({ source, data: { [HUD_HELLO]: 1 } });
      },
      up(msg: unknown) { port.listener?.(msg); },
      setHidden(h: boolean) {
        hidden = h;
        for (const fn of [...visibility]) fn();
      },
      downTypes() { return port.sent.map((m) => m.t); },
      batches() { return port.sent.filter((m) => m.t === "batch").map((m) => m.cmds as Cmd[]); },
    };
  }
  const INIT = { popcornShots: 2, paintballCapacity: 32, famasCapacity: 9, frisbeeCageCapacity: 5, interact: false, crosshair: { shape: "STICKER", scale: 1, color: "#fbf1da", highContrast: false, reducedMotion: false } };
  const VIEWPORT = { width: 2844, height: 1600, dpr: 0.9 };

  /** Frame mode up to `ready` (isolated iframe, init given by Game during the check). */
  async function readyFrame(b: ReturnType<typeof browser>, host: InstanceType<typeof H.HudHost>) {
    host.start(b.env);
    b.hello();
    host.init(INIT);
    await settle();
    b.up({ t: "ready" });
    await settle();
    assert.equal(host.mode, "frame");
  }

  console.log("Host — frame mode:");

  await test("handshake: sandboxed /hud.html, hello only from the iframe, port transferred, isolation check, init with the viewport", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    assert.deepEqual({ url: b.frame!.url, sandboxed: b.frame!.sandboxed }, { url: "/hud.html", sandboxed: true });
    host.api.combat.setPlayerName("A"); // before anything: kept
    b.hello({ some: "other window" });
    b.hello(b.frameWindow);
    assert.deepEqual(b.frameWindow.posted.map((p) => [p.msg, p.target, p.transfer]), [[{ [HUD_CONNECT]: 1 }, "*", [{ name: "port2" }]]]);
    b.hello(b.frameWindow); // a second hello is ignored
    assert.equal(b.frameWindow.posted.length, 1);
    await settle();
    assert.deepEqual(b.downTypes(), ["ping", "ping"], "ping → 80 ms block → ping");
    assert.equal(host.mode, null, "not final before ready");
    host.api.combat.setPlayerName("B");
    host.init(INIT);
    assert.deepEqual(b.port.sent[2], { t: "init", init: { ...INIT, viewport: VIEWPORT } });
    host.api.combat.setPlayerName("C");
    host.flush(); // nothing is posted before ready
    assert.deepEqual(b.downTypes(), ["ping", "ping", "init"]);
    b.up({ t: "ready" });
    assert.equal(host.mode, "frame");
    assert.deepEqual(b.batches(), [[["combat.name", "A"], ["combat.name", "B"], ["combat.name", "C"]]], "everything kept, in order, as the first batch");
    assert.equal(b.imports, 0, "the runtime module is never loaded in frame mode");
    assert.equal(b.warns.length, 0);
  });

  await test("one batch per flush, in call order; nothing posted for an empty frame; inline-only work stays off the port", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    const sentBefore = b.port.sent.length;
    host.api.clock.set(10);
    host.api.combat.notifyKill();
    host.api.combo.notifyKill();
    assert.equal(b.port.sent.length, sentBefore, "batched until the end of the frame");
    host.flush();
    host.flush();
    assert.equal(b.port.sent.length, sentBefore + 1);
    assert.deepEqual(b.batches().at(-1), [["clock.set", 10], ["combat.kill"], ["combo.kill"]]);
    host.api.clock.set(9);
    host.flush();
    assert.deepEqual(b.batches().at(-1), [["clock.set", 9]]);
  });

  await test("commands outside any frame loop: posted at the next display frame (idle flush); none armed while frames flush", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    await b.advance(200); // no flush for 200 ms (loading, menu without a frame loop)
    host.api.applyCrosshairSettings(INIT.crosshair);
    host.api.combat.setPlayerName("Z");
    assert.equal(b.rafCount, 1, "one rAF armed for the burst");
    b.runRaf();
    assert.deepEqual(b.batches().at(-1), [["crosshair.settings", INIT.crosshair], ["combat.name", "Z"]]);
    // Game frames: a flush every frame, no rAF ever armed.
    for (let i = 0; i < 5; i++) {
      await b.advance(4);
      host.api.clock.set(i);
      host.flush();
    }
    assert.equal(b.rafCount, 0);
  });

  await test("warm-up: html.hud-warm while it runs, warmup then gpu-idle once the compile is over, done on warmup-done", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    let compileDone!: () => void;
    const gpuBusy = new Promise<void>((r) => (compileDone = r));
    let finished = false;
    const warm = host.warmUp(gpuBusy).then(() => (finished = true));
    await settle();
    assert.deepEqual(b.root, ["+hud-warm"]);
    assert.equal(b.downTypes().at(-1), "warmup");
    assert.ok(!b.downTypes().includes("gpu-idle"));
    compileDone();
    await settle();
    assert.equal(b.downTypes().at(-1), "gpu-idle");
    assert.ok(!finished);
    b.up({ t: "warmup-done", ms: 1800 });
    await warm;
    assert.deepEqual(b.root, ["+hud-warm", "-hud-warm"]);
    await host.warmUp(null); // once per page
    assert.equal(b.downTypes().filter((t) => t === "warmup").length, 1);
  });

  await test("stats: debug line + paint GPU ms accumulated until taken", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    assert.equal(host.describe(), "iframe isolée");
    assert.equal(host.takePaintGpuMs(), null);
    b.up({ t: "stats", fps: 243.6, applyMs: 0.31, renderMs: 1.14, paintGpuMs: 0.5 });
    b.up({ t: "stats", fps: 244, applyMs: 0.26, renderMs: 1.05, paintGpuMs: 0.25 });
    assert.equal(host.describe(), "iframe isolée · 244 FPS · JS 0.3 · rendu 1.1 ms");
    assert.equal(host.takePaintGpuMs(), 0.75);
    assert.equal(host.takePaintGpuMs(), null, "taken");
    b.up({ t: "stats", fps: 240, applyMs: 0.2, renderMs: 1, paintGpuMs: null });
    assert.equal(host.takePaintGpuMs(), null);
  });

  await test("errors after ready: one console.warn, the HUD stays in the iframe", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    b.up({ t: "error", message: "boom" });
    b.up({ t: "error", message: "boom again" });
    assert.equal(host.mode, "frame");
    assert.deepEqual(b.warns, ["[HUD] erreur dans l'iframe du HUD : boom"]);
  });

  await test("?hud=frame forces the iframe: no isolation check, debug line says so", async () => {
    const b = browser({ search: "?hud=frame" });
    const host = new H.HudHost();
    host.start(b.env);
    b.hello();
    await settle();
    assert.ok(!b.downTypes().includes("ping"));
    host.init(INIT);
    assert.equal(b.downTypes()[0], "init");
    b.up({ t: "ready" });
    assert.equal(host.describe(), "iframe (forcée)");
  });

  await test("a hello / pong arriving while the page was blocked past a deadline still counts (grace stage)", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    await b.advance(H.HELLO_TIMEOUT_MS); // first stage of the deadline fired
    b.hello(); // queued answer handled before the grace stage
    await b.advance(1000);
    assert.equal(b.frame!.removed, false);
    assert.equal(b.warns.length, 0);
  });

  console.log("Host — fallbacks to the HUD in the page:");

  await test("not isolated (its rAF stopped while this thread was blocked): iframe removed, runtime loaded, init + replay in order", async () => {
    const b = browser({ isolated: false });
    const host = new H.HudHost();
    host.start(b.env);
    host.api.combat.setPlayerName("A");
    b.hello();
    host.init(INIT);
    host.api.clock.set(300);
    await settle();
    assert.equal(b.frame!.removed, true);
    assert.equal(b.port.closed, true);
    assert.equal(host.mode, "inline");
    assert.match(b.warns[0], /iframe non isolée \(0 frame pendant 80 ms bloquées\)/);
    assert.deepEqual(b.runtime.calls, [["init", { ...INIT, viewport: VIEWPORT }], ["combat.name", "A"], ["clock.set", 300]]);
    host.api.combat.notifyKill();
    assert.deepEqual(b.runtime.calls.at(-1), ["combat.kill"], "inline: applied synchronously at the call");
    assert.equal(host.describe(), "dans la page (iframe non isolée (0 frame pendant 80 ms bloquées))");
  });

  await test("no hello within 8 s: HUD in the page; a late hello is ignored", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    host.init(INIT);
    await b.advance(H.HELLO_TIMEOUT_MS + 100);
    assert.equal(host.mode, "inline");
    assert.equal(b.frame!.removed, true);
    b.hello();
    assert.equal(b.frameWindow.posted.length, 0);
    assert.equal(b.runtime.calls.length, 1);
  });

  await test("error before ready (viewport mismatch): one warn with the message, HUD in the page", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    b.hello();
    host.init(INIT);
    await settle();
    host.api.combat.setPlayerName("A");
    b.up({ t: "error", message: "viewport 2844×1600 @0.90 ≠ 3160×1778 @0.81" });
    await settle();
    assert.equal(host.mode, "inline");
    assert.deepEqual(b.warns, ["[HUD] iframe abandonnée (erreur de l'iframe : viewport 2844×1600 @0.90 ≠ 3160×1778 @0.81) : HUD dans la page."]);
    assert.deepEqual(b.runtime.calls.slice(1), [["combat.name", "A"]]);
    b.up({ t: "ready" }); // closed port: nothing reaches the host any more
    assert.equal(host.mode, "inline");
  });

  await test("no ready within 8 s of init: HUD in the page", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    b.hello();
    await settle();
    host.init(INIT);
    await b.advance(H.READY_TIMEOUT_MS + 100);
    assert.equal(host.mode, "inline");
    assert.match(b.warns[0], /pas prête/);
  });

  await test("iframe silent during its warm-up: HUD rebuilt in the page from every command already posted, then warmed up here", async () => {
    const b = browser();
    const host = new H.HudHost();
    host.start(b.env);
    host.api.combat.setPlayerName("A");
    b.hello();
    host.init(INIT);
    await settle();
    b.up({ t: "ready" });
    host.api.clock.set(1);
    host.flush();
    const warm = host.warmUp(Promise.resolve());
    await settle();
    host.api.clock.set(2); // not flushed yet
    await b.advance(H.WARMUP_TIMEOUT_MS + 100);
    await warm;
    assert.equal(host.mode, "inline");
    assert.equal(b.frame!.removed, true);
    assert.deepEqual(b.runtime.calls, [
      ["init", { ...INIT, viewport: VIEWPORT }],
      ["combat.name", "A"],
      ["clock.set", 1],
      ["clock.set", 2],
      ["warmUp", null],
    ]);
    assert.deepEqual(b.root, ["+hud-warm", "-hud-warm"]);
  });

  await test("after a completed warm-up the iframe is final (no more fallback, nothing kept)", async () => {
    const b = browser();
    const host = new H.HudHost();
    await readyFrame(b, host);
    const warm = host.warmUp(Promise.resolve());
    await settle();
    b.up({ t: "warmup-done", ms: 900 });
    await warm;
    for (let i = 0; i < 3; i++) {
      host.api.clock.set(i);
      host.flush();
    }
    await b.advance(60_000);
    assert.equal(host.mode, "frame");
    assert.equal(b.warns.length, 0);
  });

  await test("hidden tab: the isolation check waits until shown; a warm-up asked meanwhile is skipped (as warmUpHud did)", async () => {
    const b = browser({ hidden: true });
    const host = new H.HudHost();
    host.start(b.env);
    b.hello();
    host.init(INIT);
    await settle();
    assert.deepEqual(b.downTypes(), [], "no measure while no frame can be drawn");
    await host.warmUp(Promise.resolve());
    assert.ok(!b.downTypes().includes("warmup"));
    b.setHidden(false);
    await settle();
    assert.deepEqual(b.downTypes(), ["ping", "ping", "init"]);
    b.up({ t: "ready" });
    assert.equal(host.mode, "frame");
  });

  await test("page hidden during the check: measured again once shown (never a false 'not isolated')", async () => {
    const b = browser({ isolated: false });
    const host = new H.HudHost();
    host.start(b.env);
    host.init(INIT);
    b.port.autoPong = false;
    b.hello();
    await settle();
    b.up({ t: "pong", frames: 10 }); // n0 → 80 ms block → second ping
    b.setHidden(true);
    b.setHidden(false);
    await settle();
    b.up({ t: "pong", frames: 30 }); // covers a hidden period: void, whatever it says
    await settle();
    assert.equal(host.mode, null, "first check discarded, a new one runs");
    assert.equal(b.downTypes().filter((t) => t === "ping").length, 3);
    b.up({ t: "pong", frames: 30 });
    await settle();
    b.up({ t: "pong", frames: 30 }); // nothing drawn while this thread was blocked
    await settle();
    assert.equal(host.mode, "inline", "the valid measure decides");
  });

  console.log("Host — inline mode:");

  await test("DEV default: runtime loaded at start, init applied at the call, then every command synchronously; flush is a no-op", async () => {
    const b = browser({ prod: false });
    const host = new H.HudHost();
    host.start(b.env);
    assert.equal(b.frame, null, "no iframe");
    await settle();
    host.init(INIT);
    assert.deepEqual(b.runtime.calls, [["init", { ...INIT, viewport: VIEWPORT }]], "init at the call (inside Game's constructor)");
    host.api.dash.update(0.016, { dashCooldownRemaining: 0, isDashing: false });
    assert.deepEqual(b.runtime.calls.at(-1), ["dash.update", 0.016, { dashCooldownRemaining: 0, isDashing: false }]);
    host.flush();
    assert.equal(b.port.sent.length, 0);
    await host.warmUp(Promise.resolve());
    assert.deepEqual(b.runtime.calls.at(-1), ["warmUp", "promise"]);
    assert.deepEqual(b.root, [], "hud-warm is the runtime's own business inline (warmUpHud sets it)");
    assert.equal(host.takePaintGpuMs(), 1.5);
    assert.equal(host.describe(), "dans la page (dev)");
  });

  await test("commands before the runtime is loaded / before init: kept and replayed after init, in order", async () => {
    const b = browser({ prod: false });
    const host = new H.HudHost();
    host.api.setDocClass("hud", "menu-active", true); // even before start
    host.start(b.env);
    host.init(INIT); // module not loaded yet
    host.api.clock.set(5);
    await settle();
    assert.deepEqual(b.runtime.calls, [["init", { ...INIT, viewport: VIEWPORT }], ["doc.class", "hud", "menu-active", true], ["clock.set", 5]]);
  });

  await test("runtime module failing to load: the match runs without HUD (commands dropped, warm-up resolves)", async () => {
    const b = browser({ prod: false, runtimeFails: true });
    const host = new H.HudHost();
    host.start(b.env);
    host.init(INIT);
    host.api.clock.set(1);
    await settle();
    await host.warmUp(Promise.resolve());
    host.api.clock.set(2);
    assert.equal(host.describe(), "absent (runtime introuvable)");
    assert.equal(b.errors.length, 1);
  });

  await test("never started (headless scripts): flush / takePaintGpuMs / describe are harmless", () => {
    const host = new H.HudHost();
    host.flush();
    assert.equal(host.takePaintGpuMs(), null);
    assert.equal(host.describe(), "en attente");
  });

  console.log(`\nAll ${passed} HUD host checks passed.`);
} finally {
  if (realPerformance) Object.defineProperty(globalThis, "performance", realPerformance);
  await server.close();
}
