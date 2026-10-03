// PAINTBALL RIFLE - SOLO vs BOTS: headless validation of the "one confirmation per hit" fix, the short cosmetic jet and
// the bot hitboxes against the REAL animated silhouette. Runs the REAL source modules through Vite SSR (the same files
// the game bundles), WITHOUT a browser: nothing here is an observation made in the game.
// Usage (repo root):  npx --prefix backend tsx scripts/test-paintball-solo.mts
import fs from "node:fs";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
const g = globalThis as unknown as Record<string, unknown>;
g.self = globalThis;
g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
process.on("unhandledRejection", () => {}); // the bots' optional rifle GLB (Meshopt) may not decode headless

// ---- minimal DOM (HitmarkerHUD + BotModel label texture) ----
const domLog: string[] = [];
function fakeEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    id: "", className: "", children: [] as unknown[], width: 0, height: 0,
    style: { setProperty: (k: string, v: string) => { domLog.push(`var ${k}=${v}`); } },
    classList: {
      add: (c: string) => { domLog.push(`add ${c}`); },
      remove: (...c: string[]) => { domLog.push(`remove ${c.join(",")}`); },
    },
    appendChild(c: unknown) { (el.children as unknown[]).push(c); },
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
  };
  Object.defineProperty(el, "offsetWidth", { get: () => { domLog.push("reflow"); return 0; } });
  return el;
}
g.document = { createElement: () => fakeEl(), body: { appendChild() {} } };

const read = async (file: string): Promise<GLTF> => {
  const b = fs.readFileSync(file);
  return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
};
const dirFor = (name: string) => {
  const dir = (d: string) => (fs.existsSync(`${project}/src/assets/${d}/${name}`) ? `src/assets/${d}/` : null);
  return /BrickMaul/.test(name) ? "src/assets/brickmaul/" : /GoofyBasket/.test(name) ? "src/assets/goofybasket/" : dir("potato") ?? "src/assets/";
};
GLTFLoader.prototype.loadAsync = async function (url: string) {
  const name = url.split("/").pop()!.split("?")[0];
  return read(`${project}/${dirFor(name)}${name}`);
};

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
  const HFC = (await server.ssrLoadModule("/src/combat/HitFeedbackConfig.ts")).HitFeedbackConfig as Record<string, number>;
  const { HitZone } = await server.ssrLoadModule("/src/combat/HitZone.ts");
  const { KillMethod } = await server.ssrLoadModule("/src/combat/KillMethod.ts");
  const { Health } = await server.ssrLoadModule("/src/combat/Combatant.ts");
  const { HitFeedbackManager } = await server.ssrLoadModule("/src/combat/HitFeedbackManager.ts");
  const { HitmarkerHUD } = await server.ssrLoadModule("/src/ui/HitmarkerHUD.ts");
  const { PaintballFX } = await server.ssrLoadModule("/src/weapons/paintball/PaintballFX.ts");
  const R = await server.ssrLoadModule("/shared/combat/PaintballRifleRules.ts");
  const weaponGltf = await read(`${project}/src/assets/potato/PaintballRifle_Weapon.glb`);

  // 1. SETTINGS ACTUALLY LOADED (the numbers the tested modules really use)
  await test("settings in force: maxFlight, feedback interval, hitmarker ticks, damage 12/18, 0 deg spread, 10 shots/s", () => {
    console.log(`    PAINT_JET.maxFlight=${S.PAINT_JET.maxFlight} s, speed=${S.PAINT_JET.speed} m/s, springStep=1/${Math.round(1 / S.PAINT_JET.springStep)} s`);
    console.log(`    paintballFeedbackInterval=${HFC.paintballFeedbackInterval} s (body interval of other weapons=${HFC.bodyHitFeedbackInterval} s), tick body/head=${HFC.paintballBodyHitmarkerDuration}/${HFC.paintballHeadHitmarkerDuration} s`);
    assert.equal(S.PAINT_JET.maxFlight, 0.08);
    assert.equal(HFC.paintballFeedbackInterval, 0);
    assert.ok(HFC.paintballBodyHitmarkerDuration < 0.1 && HFC.paintballHeadHitmarkerDuration < 0.13);
    assert.equal(HFC.bodyHitFeedbackInterval, 0.12, "other weapons keep the 120 ms throttle");
    assert.equal(R.paintballDamage(false), 12);
    assert.equal(R.paintballDamage(true), 18);
    assert.equal(R.PaintballRifleConfig.fireInterval, 0.1);
    assert.equal(R.PaintballRifleConfig.spreadMinDeg, 0);
    assert.equal(R.PaintballRifleConfig.spreadMaxDeg, 0);
  });

  // 2. FEEDBACK: 10 hits spaced 100 ms -> 10 confirmations
  const makeTarget = () => ({
    id: 1, name: "bot", health: new Health(10000), velocity: new THREE.Vector3(),
    getPosition: (o: THREE.Vector3) => o.set(0, 0, -12), getEyePosition: (o: THREE.Vector3) => o.set(0, 1, -12),
    applyImpulse() {}, onHitVisual() {},
  });
  const makeFeedback = (attacker: unknown) => {
    const shows: { zone: number; dur: number | undefined }[] = [];
    const hud = { show: (zone: number, dur?: number) => shows.push({ zone, dur }) };
    const fb = new HitFeedbackManager(hud, { burst() {} }, attacker);
    let paintSounds = 0, otherSounds = 0;
    fb.onPaintballHitSound = () => paintSounds++;
    fb.onBodyHitSound = () => otherSounds++;
    fb.onHeadshotSound = () => otherSounds++;
    return { fb, shows, sounds: () => ({ paint: paintSounds, other: otherSounds }) };
  };
  const hit = (attacker: unknown, target: unknown, zone: number, weapon: unknown, isKill = false) => ({
    attacker, target, hitZone: zone, damage: 12, position: new THREE.Vector3(0, 1, -12), weapon, isKill,
  });

  await test("10 body hits spaced 100 ms (paintball) -> 10 hitmarker pulses + 10 hit sounds; the old 120 ms rule loses half", () => {
    const player = { id: 0 }, target = makeTarget();
    for (const jitter of [0, 0.004, -0.004]) {
      const a = makeFeedback(player);
      for (let i = 0; i < 10; i++) {
        a.fb.registerHit(hit(player, target, HitZone.BODY, KillMethod.PAINTBALL_RIFLE));
        a.fb.update(0.1 + (i % 2 ? jitter : -jitter));
      }
      assert.equal(a.shows.length, 10, `10 hitmarkers (jitter +-${jitter})`);
      assert.equal(a.sounds().paint, 10, `10 paintball hit sounds (jitter +-${jitter})`);
      assert.ok(a.shows.every((s) => s.dur === HFC.paintballBodyHitmarkerDuration), "each pulse is the short paintball tick");
    }
    // The previous behaviour (same code path, the old 0.12 s interval): proves the cause.
    const old = HFC.paintballFeedbackInterval;
    HFC.paintballFeedbackInterval = 0.12;
    const b = makeFeedback(player);
    for (let i = 0; i < 10; i++) { b.fb.registerHit(hit(player, target, HitZone.BODY, KillMethod.PAINTBALL_RIFLE)); b.fb.update(0.1); }
    HFC.paintballFeedbackInterval = old;
    console.log(`    with the old 0.12 s interval: ${b.shows.length}/10 confirmations (fix: 10/10)`);
    assert.equal(b.shows.length, 5, "old behaviour: every other ball confirmed");
    // Other weapons are untouched: still throttled at 0.12 s with the default hitmarker lifetime.
    const c = makeFeedback(player);
    for (let i = 0; i < 10; i++) { c.fb.registerHit(hit(player, target, HitZone.BODY, KillMethod.REVOLVER)); c.fb.update(0.1); }
    assert.equal(c.shows.length, 5, "non-paintball weapons keep the 120 ms throttle");
    assert.ok(c.shows.every((s) => s.dur === undefined), "...and their default hitmarker lifetime");
  });

  await test("head hits and body/head alternation: every ball confirmed with its own zone", () => {
    const player = { id: 0 }, target = makeTarget();
    const a = makeFeedback(player);
    const zones = [HitZone.HEAD, HitZone.HEAD, HitZone.BODY, HitZone.HEAD, HitZone.BODY, HitZone.BODY, HitZone.HEAD, HitZone.HEAD, HitZone.BODY, HitZone.HEAD];
    for (const z of zones) { a.fb.registerHit(hit(player, target, z, KillMethod.PAINTBALL_RIFLE)); a.fb.update(0.1); }
    assert.deepEqual(a.shows.map((s) => s.zone), zones);
    assert.equal(a.sounds().paint, 10);
    assert.deepEqual(a.shows.map((s) => s.dur), zones.map((z) => (z === HitZone.HEAD ? HFC.paintballHeadHitmarkerDuration : HFC.paintballBodyHitmarkerDuration)));
  });

  await test("hitmarker HUD: every pulse restarts the CSS animation (remove, reflow, add) with the short tick; other weapons get the default lifetime back", () => {
    const hud = new HitmarkerHUD();
    domLog.length = 0;
    for (let i = 0; i < 10; i++) hud.show(HitZone.BODY, HFC.paintballBodyHitmarkerDuration);
    const restarts = domLog.join("|").split("remove hm-body,hm-head|reflow|add hm-body").length - 1;
    assert.equal(restarts, 10, "10 clean restarts (remove, reflow, add)");
    assert.ok(domLog.includes(`var --hm-body-dur=${HFC.paintballBodyHitmarkerDuration}s`), "short tick lifetime applied");
    domLog.length = 0;
    hud.show(HitZone.BODY);
    assert.ok(domLog.includes(`var --hm-body-dur=${HFC.bodyHitmarkerDuration}s`), "default lifetime restored for the next weapon");
    const css = fs.readFileSync(`${project}/src/hud.css`, "utf8");
    assert.ok(/#hitmarker\.hm-body \.hm-arm\s*{[^}]*var\(--hm-body-dur/.test(css) && /#hitmarker\.hm-head \.hm-arm\s*{[^}]*var\(--hm-head-dur/.test(css), "CSS animations read the duration variables");
  });

  // 3. SOUND: the REAL AudioManager voice logic (fake AudioContext), 10 hits per second
  await test("hit sounds: 10 balls at 100 ms -> every sound played (body 10, head 20 voices); the old voice caps dropped hits", async () => {
    const { audio } = await server.ssrLoadModule("/src/audio/AudioManager.ts");
    const { GameAudio } = await server.ssrLoadModule("/src/audio/GameAudio.ts");
    const a = audio as unknown as Record<string, unknown>;
    let now = 0;
    const clock = { t: 0 };
    const played: string[] = [];
    const node = () => ({ connect() {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, playbackRate: { value: 1 }, start() {}, stop() {} });
    const ctx = {
      state: "running", get currentTime() { return clock.t; },
      createBufferSource: () => {
        const n = node() as Record<string, unknown>;
        Object.defineProperty(n, "buffer", { set: (b: { key: string }) => played.push(b.key), get: () => null });
        return n;
      },
      createGain: node,
    };
    a.ctx = ctx;
    const dur: Record<string, number> = { paintball_gooey: 0.984, paintball_splat_01: 0.522, paintball_splat_02: 0.575 };
    const buffers = a.buffers as Map<string, unknown>;
    for (const k of Object.keys(dur)) buffers.set(k, { key: k, duration: dur[k] });
    (a.buses as Map<string, unknown>).set("impacts", node());
    const realNow = performance.now.bind(performance);
    performance.now = () => now;
    const origRandom = Math.random;
    try {
      const run = (fn: () => void) => {
        played.length = 0; a.voices = []; (a.lastPlay as Map<string, number>).clear(); now = 1000; clock.t = 0;
        for (let i = 0; i < 10; i++) { fn(); now += 100; clock.t += 0.1; }
        return played.length;
      };
      const ga = new GameAudio();
      Math.random = () => 0.3;
      const bodyNew = run(() => ga.paintballHit(false));
      const headNew = run(() => ga.paintballHit(true)); // 2 sounds per head hit (gooey + splat)
      // The previous caps (4 / 4 / 5), same sounds, same throttle, through the same engine.
      // Body: average pitch (rate 1.05) and the slowest random pitch (1.05 - 0.12 = 0.93: a longer sample).
      const bodyOld = run(() => audio.play("paintball_splat_01", { bus: "impacts", volume: 0.7, rate: 1.05, throttleMs: 40, maxInstances: 5 }));
      const bodyOldSlow = run(() => audio.play("paintball_splat_01", { bus: "impacts", volume: 0.7, rate: 0.93, throttleMs: 40, maxInstances: 5 }));
      const bodyNewSlow = run(() => audio.play("paintball_splat_01", { bus: "impacts", volume: 0.7, rate: 0.93, throttleMs: 40, maxInstances: 10 }));
      const headOld = run(() => {
        audio.play("paintball_gooey", { bus: "impacts", volume: 0.8, rate: 1.2, throttleMs: 40, maxInstances: 4 });
        audio.play("paintball_splat_01", { bus: "impacts", volume: 0.55, rate: 1.5, throttleMs: 40, maxInstances: 4 });
      });
      console.log(`    body: new ${bodyNew}/10 | old caps ${bodyOld}/10 at average pitch, ${bodyOldSlow}/10 at the slowest pitch (new caps ${bodyNewSlow}/10)`);
      console.log(`    head: new ${headNew}/20 voices | old caps ${headOld}/20`);
      assert.equal(bodyNew, 10, "all 10 body hits are heard");
      assert.equal(bodyNewSlow, 10, "all 10 body hits are heard even at the slowest pitch");
      assert.equal(headNew, 20, "all 10 head hits are heard (gooey + splat each)");
      assert.ok(headOld < 20, "the old per-key voice caps silently dropped head-hit sounds at 10 balls/s");
      assert.ok(bodyOldSlow <= bodyOld, "slower pitch can only lose more with the old caps");
    } finally {
      performance.now = realNow;
      Math.random = origRandom;
    }
  });

  // 4. COSMETIC JET: whole path, <= 80 ms, straight, distinct, no damage
  const scene = new THREE.Scene();
  const fx = new PaintballFX(scene);
  fx.init(weaponGltf);
  const jets = fx.projectiles!;
  const viewer = new THREE.Vector3(0, 1.6, 0);

  await test("jet reaches the computed impact in <= 80 ms at EVERY distance (2-400 m), nose exactly on the point, straight line", () => {
    const rows: string[] = [];
    for (const D of [2, 5, 8.5, 10, 15, 20, 30, 45, 80, 150, 400]) {
      for (const speedSeed of [1, 2, 3, 50, 99]) { // per-jet speed jitter
        jets.clear(); fx.clearAll();
        (jets as unknown as { spawned: number }).spawned = speedSeed;
        const from = new THREE.Vector3(0.3, 1.4, -0.6);
        const dir = new THREE.Vector3(0.05, 0.02, -1).normalize();
        const to = from.clone().addScaledVector(dir, D);
        fx.spawn(from, to, new THREE.Color(1, 0, 0.5), { normal: new THREE.Vector3(0, 0, 1), seed: 1 });
        jets.update(0);
        const dt = 1 / 1000;
        let t = 0, arrival = -1;
        for (let i = 0; i < 400 && arrival < 0; i++) {
          jets.update(dt); t += dt;
          const s = jets.sampleInstance(0);
          if (s) {
            assert.ok(s.dir.angleTo(to.clone().sub(from).normalize()) < 1e-5, "straight ray, no guidance");
            if (s.draining) { arrival = t; assert.ok(s.headWorld.distanceTo(to) < 1e-3, `nose ON the impact (${s.headWorld.distanceTo(to)} m)`); }
          } else if (jets.impactCount > 0) arrival = t;
        }
        assert.ok(arrival > 0, `${D} m landed`);
        assert.ok(arrival <= 0.08 + 1e-9, `${D} m (seed ${speedSeed}) arrives in ${(arrival * 1000).toFixed(1)} ms <= 80 ms`);
        if (speedSeed === 1) rows.push(`${D} m -> ${(arrival * 1000).toFixed(0)} ms`);
      }
    }
    console.log(`    arrival: ${rows.join(", ")}`);
  });

  await test("jet look kept: stretched squishy body (3.5-5.3:1), 3 palette colours, distinct simultaneous shots, never longer than the path", () => {
    jets.clear(); fx.clearAll();
    const K = S.PAINT_JET;
    const cols = [0, 1, 2].map((i) => fx.colorOf(i, new THREE.Color()));
    for (let i = 0; i < 3; i++) {
      fx.spawn(new THREE.Vector3(0.3, 1.4, -0.6), new THREE.Vector3(-1 + i, 1.2, -20), cols[i], { normal: new THREE.Vector3(0, 0, 1), seed: 10 + i });
    }
    jets.update(0);
    assert.equal(jets.mesh.count, 3, "three distinct jets (one instance each)");
    const seenCols = new Set<string>();
    for (let k = 0; k < 3; k++) { const c = new THREE.Color(); jets.mesh.getColorAt(k, c); seenCols.add(c.getHexString()); }
    assert.equal(seenCols.size, 3, "pink / blue / yellow kept");
    let minRatio = Infinity, maxRatio = 0;
    for (let f = 0; f < 6; f++) {
      jets.update(1 / 180);
      for (let k = 0; k < jets.mesh.count; k++) {
        const s = jets.sampleInstance(k)!;
        if (s.draining) continue;
        const ratio = s.len / (2 * s.radius);
        minRatio = Math.min(minRatio, ratio); maxRatio = Math.max(maxRatio, ratio);
        assert.ok(s.len <= K.maxLength + 1e-6 && s.len <= s.head + 1e-6, "body never longer than the covered path");
      }
    }
    console.log(`    length/thickness over the flight: ${minRatio.toFixed(2)} ... ${maxRatio.toFixed(2)} (spec 3.5-5.3)`);
    assert.ok(minRatio >= 3.4 && maxRatio <= 5.4, "long squishy jet, never a ball");
    for (let f = 0; f < 120; f++) jets.update(1 / 240);
    assert.equal(jets.activeCount, 0);
  });

  // 5. REAL WEAPON, SOLO PATH: 10 hits -> 10 damages, 10 confirmations, jets add NO damage
  await test("REAL weapon (solo path): 10 balls at 10/s on a bot-like target -> 10 x 12 damage, 10 confirmations, jets land with ZERO extra damage", async () => {
    const { PaintballRifleWeapon } = await server.ssrLoadModule("/src/weapons/paintball/PaintballRifleWeapon.ts");
    const { ViewmodelSystem } = await server.ssrLoadModule("/src/weapons/viewmodel/ViewmodelSystem.ts");
    const cam = new THREE.PerspectiveCamera(92, 16 / 9, 0.1, 400);
    cam.position.set(0, 1.6, 0);
    cam.rotation.set(0, 0, 0, "YXZ");
    cam.updateMatrixWorld(true);
    const world = new THREE.Scene();
    const vm = new ViewmodelSystem(16 / 9);
    await vm.ready;
    const w = new PaintballRifleWeapon(cam, world, vm);
    await w.ready;
    const player = { id: 0, name: "player", health: new Health(100), velocity: new THREE.Vector3(), getPosition: (o: THREE.Vector3) => o, getEyePosition: (o: THREE.Vector3) => o, applyImpulse() {} };
    const bot = makeTarget();
    const fbk = makeFeedback(player);
    w.owner = player;
    w.feedback = fbk.fb;
    w.takePresentation();
    // Bot-like target 12 m ahead (tagged like BotModel's group) + a wall behind it.
    const group = new THREE.Group();
    group.userData.combatant = bot;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    body.position.set(0, 1.6, -12);
    group.add(body);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(40, 20, 1), new THREE.MeshBasicMaterial());
    wall.position.set(0, 5, -30);
    wall.name = "WALL";
    world.add(group, wall);
    world.updateMatrixWorld(true);
    // Spy on the jets handed to the FX (origin, impact) and on the damage events.
    const spawns: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    const fxSpawn = w.fx.spawn.bind(w.fx);
    w.fx.spawn = (from: THREE.Vector3, to: THREE.Vector3, ...rest: unknown[]) => { spawns.push({ from: from.clone(), to: to.clone() }); return fxSpawn(from, to, ...rest); };
    const damages: number[] = [];
    bot.health.addDamageListener((a: number) => damages.push(a));
    const input = {
      fireHeld: true, reloadPressed: false, inspectPressed: false, aimHeld: false, canAct: true,
      hittables: [group, wall] as THREE.Object3D[], grounded: true, verticalVelocity: 0, jumpSequence: 0, sliding: false, speed: 0,
    };
    const dt = 1 / 60;
    const shotTimes: number[] = [];
    let t = 0;
    for (let f = 0; f < 90 && spawns.length < 10; f++) { // hold until the 10th ball left
      const before = spawns.length;
      w.update(dt, input);
      vm.syncCamera(cam);
      w.postCameraUpdate(dt);
      fbk.fb.update(dt);
      if (spawns.length > before) shotTimes.push(t);
      t += dt;
    }
    assert.equal(spawns.length, 10, "10 balls fired");
    const gaps = shotTimes.slice(1).map((x, i) => x - shotTimes[i]);
    console.log(`    shot gaps (ms): ${gaps.map((x) => (x * 1000).toFixed(0)).join(" ")}`);
    assert.ok(gaps.every((x) => Math.abs(x - 0.1) < 1e-6), "nominal cadence: one ball every 100 ms (10 shots/s)");
    input.fireHeld = false;
    for (let f = 0; f < 60; f++) { w.update(dt, input); vm.syncCamera(cam); w.postCameraUpdate(dt); fbk.fb.update(dt); } // jets land
    assert.equal(damages.length, 10, "10 damage events (one per ball)");
    assert.ok(damages.every((d) => d === 12), "12 per body ball");
    assert.equal(bot.health.current, 10000 - 120, "no extra damage from the jets / impacts");
    assert.equal(fbk.shows.length, 10, "10 hitmarker pulses");
    assert.equal(fbk.sounds().paint, 10, "10 hit sounds");
    for (const s of spawns) {
      assert.ok(Math.abs(s.to.z - -11.5) < 1e-6 && Math.abs(s.to.x) < 1e-6, `jet destination = the hitscan impact on the bot (${s.to.toArray().map((v) => v.toFixed(2))})`);
    }
    assert.equal(w.fx.projectiles!.activeCount, 0, "every jet reached its destination");
    // A ray that misses the box is intercepted by the wall behind it.
    const rc = new THREE.Raycaster(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(-Math.sin(0.2), 0, -Math.cos(0.2)).normalize());
    assert.equal(rc.intersectObjects([group, wall], true)[0].object.name, "WALL", "a missed ball is intercepted by the wall behind the bot");
    w.releasePresentation();
  });

  // 6. BOT HITBOXES vs the REAL animated silhouette (headless measurement, NOT an in-game observation)
  const { loadCharacterAsset, FEET_OFFSET } = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
  await loadCharacterAsset();
  const { BotModel } = await server.ssrLoadModule("/src/bots/BotModel.ts");

  type Pose = { name: string; speed: number; yaw: number; pitch: number; sliding: boolean; grounded: boolean; dashing: boolean; velocityY: number; vx: number; vz: number; frames: number };
  const base = { yaw: 0, pitch: 0, sliding: false, grounded: true, dashing: false, velocityY: 0, vx: 0, vz: 0 };
  const poses: Pose[] = [
    { ...base, name: "idle", speed: 0, frames: 90 },
    { ...base, name: "run toward shooter", speed: 9.5, vz: 9.5, frames: 70 },
    { ...base, name: "strafe (phase 0)", speed: 9.5, vx: 9.5, frames: 70 },
    { ...base, name: "strafe (phase +0.2s)", speed: 9.5, vx: 9.5, frames: 82 },
    { ...base, name: "strafe (phase +0.4s)", speed: 9.5, vx: 9.5, frames: 94 },
    { ...base, name: "slide", speed: 13, sliding: true, vz: 13, frames: 70 },
    { ...base, name: "jump (rising)", speed: 6, grounded: false, velocityY: 8, vz: 6, frames: 50 },
  ];
  type Row = { pose: string; az: number; dist: number; visHit: number; visMiss: number; phantom: number; headHit: number; headVisTotal: number };
  const rows: Row[] = [];

  /** Visible parts: one static (posed) mesh per skinned mesh, so a ray reports WHICH part of the model it sees. */
  type Part = { name: string; mesh: THREE.Mesh };
  /** Pose one bot, return its visible silhouette as a static mesh + its two hitboxes. */
  const buildBot = async (pose: Pose) => {
    const bm = new BotModel(0);
    for (let i = 0; i < 60 && !bm.characterModel; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(bm.characterModel, "skinned character clone attached");
    const holder = new THREE.Scene();
    holder.add(bm.group);
    const camQuat = new THREE.Quaternion();
    for (let f = 0; f < pose.frames; f++) bm.update(1 / 60, pose, 1, camQuat, false, f / 60);
    bm.group.position.set(0, FEET_OFFSET, 0);
    holder.updateMatrixWorld(true);
    const parts: Part[] = [];
    const visBox = new THREE.Box3();
    bm.characterModel.traverse((o: THREE.Object3D) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || sm.userData.enemyOutline) return; // visible body only, not the red outline hull
      const positions: number[] = [];
      const v = new THREE.Vector3();
      for (let i = 0; i < sm.geometry.attributes.position.count; i++) {
        sm.getVertexPosition(i, v);
        v.applyMatrix4(sm.matrixWorld);
        positions.push(v.x, v.y, v.z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      if (sm.geometry.index) geo.setIndex(sm.geometry.index.clone());
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      mesh.updateMatrixWorld(true);
      parts.push({ name: sm.name, mesh });
      visBox.union(new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute));
    });
    const priv = bm as unknown as { bodyHitbox: THREE.Mesh; headHitbox: THREE.Mesh };
    return { bm, parts, visBox, names: parts.map((p) => p.name), hitboxes: [priv.bodyHitbox, priv.headHitbox] };
  };
  /** Per visible part + height band: visible pixels (nearest visible surface) and how many are covered by a hitbox. */
  const partStats = new Map<string, { vis: number; hit: number }>();

  const analyse = async (pose: Pose, azDeg: number, dist: number): Promise<Row> => {
    const { bm, parts, visBox, names, hitboxes } = await buildBot(pose);
    const visMeshes = parts.map((p) => p.mesh);
    const az = (azDeg * Math.PI) / 180;
    const eye = new THREE.Vector3(Math.sin(az) * dist, 1.6, -Math.cos(az) * dist);
    const centre = visBox.getCenter(new THREE.Vector3());
    const fwd = centre.clone().sub(eye).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const rc = new THREE.Raycaster();
    let visHit = 0, visMiss = 0, phantom = 0, headHit = 0, headVisTotal = 0;
    const NX = 40, NY = 60, halfW = 1.3, halfH = 1.5;
    // Visible head = the band between 72 % and 92 % of the model height (jaw to cranium; plant leaf above excluded).
    const span = visBox.max.y - visBox.min.y;
    const headLo = visBox.min.y + span * 0.72, headHi = visBox.min.y + span * 0.92;
    for (let iy = 0; iy < NY; iy++) {
      for (let ix = 0; ix < NX; ix++) {
        const u = (((ix + 0.5) / NX) * 2 - 1) * halfW, v = (((iy + 0.5) / NY) * 2 - 1) * halfH;
        const dir = fwd.clone().addScaledVector(right, u / dist).addScaledVector(up, v / dist).normalize();
        rc.set(eye, dir);
        const vh = rc.intersectObjects(visMeshes, false)[0];
        const hh = rc.intersectObjects(hitboxes, false)[0];
        if (vh) {
          if (hh) visHit++; else visMiss++;
          const part = parts.find((p) => p.mesh === vh.object)!.name;
          const band = vh.point.y < 1.1 ? "low <1.1m" : vh.point.y < 2.02 ? "mid 1.1-2.02m" : "top >2.02m";
          const key = `${part} / ${band}`;
          const st = partStats.get(key) ?? { vis: 0, hit: 0 };
          st.vis++; if (hh) st.hit++;
          partStats.set(key, st);
        } else if (hh) phantom++;
        if (vh && vh.point.y >= headLo && vh.point.y <= headHi) { headVisTotal++; if (hh && hh.object === hitboxes[1]) headHit++; }
      }
    }
    if (pose.name === "idle" && azDeg === 0 && dist === 10) {
      const bb = new THREE.Box3().setFromObject(hitboxes[0]), hb = new THREE.Box3().setFromObject(hitboxes[1]);
      const f2 = (n: number) => n.toFixed(2);
      console.log(`    skinned meshes: ${names.join(", ")}`);
      console.log(`    idle visible silhouette  x ${f2(visBox.min.x)}..${f2(visBox.max.x)}  y ${f2(visBox.min.y)}..${f2(visBox.max.y)}  z ${f2(visBox.min.z)}..${f2(visBox.max.z)} (m)`);
      console.log(`    body hitbox              x ${f2(bb.min.x)}..${f2(bb.max.x)}  y ${f2(bb.min.y)}..${f2(bb.max.y)}  z ${f2(bb.min.z)}..${f2(bb.max.z)}`);
      console.log(`    head hitbox              x ${f2(hb.min.x)}..${f2(hb.max.x)}  y ${f2(hb.min.y)}..${f2(hb.max.y)}  z ${f2(hb.min.z)}..${f2(hb.max.z)}`);
    }
    bm.dispose();
    return { pose: pose.name, az: azDeg, dist, visHit, visMiss, phantom, headHit, headVisTotal };
  };

  await test("bot hitbox placement vs the visible mesh, per height band (idle + strafe): centre offset and half-widths", async () => {
    for (const pose of [poses[0], poses[2]]) {
      const { bm, parts, hitboxes } = await buildBot(pose);
      const bb = new THREE.Box3().setFromObject(hitboxes[0]), hb = new THREE.Box3().setFromObject(hitboxes[1]);
      console.log(`    [${pose.name}] body box centre x ${((bb.min.x + bb.max.x) / 2).toFixed(2)} z ${((bb.min.z + bb.max.z) / 2).toFixed(2)}, half-width ${((bb.max.x - bb.min.x) / 2).toFixed(2)} | head box centre x ${((hb.min.x + hb.max.x) / 2).toFixed(2)} y ${((hb.min.y + hb.max.y) / 2).toFixed(2)} z ${((hb.min.z + hb.max.z) / 2).toFixed(2)}, half-size ${((hb.max.x - hb.min.x) / 2).toFixed(2)}`);
      console.log("      band (m)       visible Potato mesh: x range / z range (centre)          | body-box x half-width");
      for (let y0 = 0; y0 < 2.2; y0 += 0.3) {
        const box = new THREE.Box3();
        for (const p of parts) {
          if (p.name !== "Potato" && p.name !== "Potato001") continue;
          const pos = p.mesh.geometry.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) if (pos.getY(i) >= y0 && pos.getY(i) < y0 + 0.3) box.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
        }
        if (box.isEmpty()) continue;
        console.log(`      ${y0.toFixed(1)}-${(y0 + 0.3).toFixed(1)}   x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} (c ${((box.min.x + box.max.x) / 2).toFixed(2)})  z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)} (c ${((box.min.z + box.max.z) / 2).toFixed(2)})   | ${((bb.max.x - bb.min.x) / 2).toFixed(2)}`);
      }
      const eyes = new THREE.Box3();
      for (const p of parts) if (p.name.startsWith("Eye_Image")) eyes.union(new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.attributes.position as THREE.BufferAttribute));
      console.log(`      eyes (face centre) y ${eyes.min.y.toFixed(2)}..${eyes.max.y.toFixed(2)}  z ${eyes.min.z.toFixed(2)}..${eyes.max.z.toFixed(2)}`);
      bm.dispose();
    }
  });

  await test("bot hitboxes vs the animated visible silhouette (7 poses, 3 azimuths, 10 m + 25 m) - headless measurement", async () => {
    for (const pose of poses) for (const az of [0, 45, 90]) for (const dist of [10, 25]) rows.push(await analyse(pose, az, dist));
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "-");
    console.log("    pose                    az  dist | visible px covered | visible px MISSED | hitbox px on empty air | visible head px in head box");
    for (const r of rows) {
      console.log(`    ${r.pose.padEnd(22)} ${String(r.az).padStart(3)} ${String(r.dist).padStart(3)} m |      ${pct(r.visHit, r.visHit + r.visMiss).padStart(5)} %      |     ${pct(r.visMiss, r.visHit + r.visMiss).padStart(5)} %      |        ${pct(r.phantom, r.visHit + r.phantom).padStart(5)} %        |        ${pct(r.headHit, r.headVisTotal).padStart(5)} %`);
    }
    const t = rows.reduce((a, r) => ({ h: a.h + r.visHit, m: a.m + r.visMiss, p: a.p + r.phantom, hh: a.hh + r.headHit, ht: a.ht + r.headVisTotal }), { h: 0, m: 0, p: 0, hh: 0, ht: 0 });
    console.log("    visible surface by part and height, all poses / azimuths / distances (nearest visible pixel):");
    for (const [k, s] of [...partStats.entries()].sort((a, b) => b[1].vis - a[1].vis)) {
      console.log(`      ${k.padEnd(34)} ${String(s.vis).padStart(6)} px  in a hitbox ${pct(s.hit, s.vis).padStart(5)} %  MISSED ${pct(s.vis - s.hit, s.vis).padStart(5)} %`);
    }
    console.log(`    TOTAL: ${pct(t.h, t.h + t.m)} % of the visible body is inside a hitbox, ${pct(t.m, t.h + t.m)} % is visible but a MISS, ${pct(t.p, t.h + t.p)} % of hitbox pixels are empty air, ${pct(t.hh, t.ht)} % of the visible head is in the head box`);
  });

  console.log(`\n${passed} paintball SOLO tests passed`);
} finally {
  await server.close();
}
