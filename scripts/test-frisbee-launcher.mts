// FRISBEE LAUNCHER — headless integration test on the REAL game assets (no WebGL):
// shared rules vs the pack reference, shared FrisbeeSim vs the pack's FrisbeeSim (same flight),
// profile / JSON timelines, FP controller on the REAL ViewmodelSystem (shot + re-cock, cage swap, cancel),
// TP controller, disc pool, thrown cages, TP pose set on the real character.
// Usage (repo root):  npx --prefix backend tsx scripts/test-frisbee-launcher.mts
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
const read = async (file: string): Promise<GLTF> => {
  const b = fs.readFileSync(file);
  return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
};
const dirFor = (name: string) =>
  /BrickMaul/.test(name) ? "src/assets/brickmaul/" : /GoofyBasket/.test(name) ? "src/assets/goofybasket/" : "src/assets/potato/";
GLTFLoader.prototype.loadAsync = async function (url: string) {
  const name = url.split("/").pop()!.split("?")[0];
  return read(`${project}/${dirFor(name)}${name}`);
};

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok ${name}`);
}

const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const R = await server.ssrLoadModule("/shared/combat/FrisbeeLauncherRules.ts");
  const S = await server.ssrLoadModule("/shared/combat/FrisbeeSim.ts");
  const REF = await server.ssrLoadModule("/src/weapons/frisbee/FrisbeeLauncherGameplay.ts");
  const PRJ = await server.ssrLoadModule("/src/weapons/frisbee/FrisbeeProjectiles.ts");
  const PROF = await server.ssrLoadModule("/src/weapons/profiles/FrisbeeLauncherProfile.ts");
  const { FrisbeeLauncherController } = await server.ssrLoadModule("/src/weapons/frisbee/FrisbeeLauncherController.ts");
  const F = R.FrisbeeLauncherConfig;
  const profileJson = JSON.parse(fs.readFileSync(`${project}/src/assets/potato/WeaponProfile_FrisbeeLauncher.json`, "utf8"));

  await test("shared rules == pack reference (capacity, tuning, cones, PRNG); damage 45 / 68 / 27 / 41", () => {
    assert.equal(F.capacity, REF.FRISBEE_LAUNCHER.capacity);
    assert.equal(F.cageCapacity, REF.FRISBEE_LAUNCHER.cageCapacity);
    assert.equal(F.spreadHipDeg, REF.FRISBEE_LAUNCHER.spreadHipDeg);
    assert.equal(F.spreadAimDeg, REF.FRISBEE_LAUNCHER.spreadAimDeg);
    assert.deepEqual(F.tuning, PRJ.FRISBEE_TUNING, "the shared tuning IS the pack tuning");
    assert.equal(R.frisbeeDamage(false, false), 45);
    assert.equal(R.frisbeeDamage(true, false), 68);
    assert.equal(R.frisbeeDamage(false, true), 27);
    assert.equal(R.frisbeeDamage(true, true), 41);
    const a = new THREE.Vector3();
    for (const seed of [1, 42, 123456789, 4294967295]) {
      for (const aiming of [false, true]) {
        const fwd = new THREE.Vector3(0.3, -0.2, -1).normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        REF.discDirection(fwd, up, aiming, seed, a);
        const b = R.frisbeeDirection(fwd, aiming, seed, { x: 0, y: 0, z: 0 });
        assert.ok(Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.z - b.z) < 1e-12, `seed ${seed} aim ${aiming}`);
        const cone = aiming ? F.spreadAimDeg : F.spreadHipDeg;
        assert.ok(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, fwd.dot(a)))) <= cone + 1e-9, "inside the cone");
      }
    }
    for (const raw of [-1, 1.5, NaN, "x", 4294967296]) assert.equal(R.sanitizeFrisbeeSeed(raw), null);
    assert.equal(R.sanitizeFrisbeeSeed(7), 7);
  });

  await test("same seed + aim -> identical launch direction on the shooter and the server (wire rounding)", () => {
    const raw = new THREE.Vector3(0.123456, -0.2345678, -0.9876543).normalize();
    const client = R.frisbeeAimDirection(raw);
    const wx = Math.round(raw.x * 1000) / 1000, wy = Math.round(raw.y * 1000) / 1000, wz = Math.round(raw.z * 1000) / 1000;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const srv = { x: wx / l, y: wy / l, z: wz / l }; // backend normalize()
    const a = R.frisbeeDirection(client, false, 987654, { x: 0, y: 0, z: 0 });
    const b = R.frisbeeDirection(srv, false, 987654, { x: 0, y: 0, z: 0 });
    assert.deepEqual(a, b, "bit-identical");
  });

  /** A floor at y = 0, a wall at z = -12 and optional players (capsule centres). */
  const worldCast = (players: { id: string; x: number; y: number; z: number }[]) => (from: any, dir: any, maxDist: number, radius: number, ignore: string | null) => {
    let best: any = null;
    const plane = (axis: "y" | "z", at: number, n: any) => {
      const d = dir[axis];
      if (Math.abs(d) < 1e-9) return;
      const t = (at + (n[axis] > 0 ? radius : -radius) - from[axis]) / d;
      if (t >= 0 && t <= maxDist && (!best || t < best.distance)) {
        best = { distance: t, point: { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t }, normal: { ...n } };
      }
    };
    plane("y", 0, { x: 0, y: 1, z: 0 });
    plane("z", -12, { x: 0, y: 0, z: 1 });
    for (const p of players) {
      if (ignore !== null && p.id === ignore) continue;
      const c = S.sweepFrisbeePlayer(from, dir, radius, { x: p.x, y: p.y, z: p.z }, maxDist);
      if (c && (!best || c.t < best.distance)) {
        best = { distance: c.t, point: { x: from.x + dir.x * c.t, y: from.y + dir.y * c.t, z: from.z + dir.z * c.t }, normal: c.normal, target: p.id, headshot: c.head };
      }
    }
    return best;
  };
  /** three.js flavour of the same world for the pack's FrisbeeSim. */
  const packCast = (players: { id: string; x: number; y: number; z: number }[]) => {
    const w = worldCast(players);
    return (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number, ignore: string | null) => {
      const h = w(from, dir, maxDist, radius, ignore);
      if (!h) return null;
      return { ...h, point: new THREE.Vector3(h.point.x, h.point.y, h.point.z), normal: new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z) };
    };
  };

  await test("shared SharedFrisbeeSim == the pack's FrisbeeSim: same arc, same bounces, same touch (1/120 s steps)", () => {
    for (const [dir, players] of [
      [new THREE.Vector3(0.1, 0.05, -1).normalize(), []],
      [new THREE.Vector3(-0.3, 0.2, -1).normalize(), []],
      [new THREE.Vector3(0, -0.15, -1).normalize(), []],
      [new THREE.Vector3(0.02, 0.03, -1).normalize(), [{ id: "P", x: 0, y: 0.9, z: -8 }]],
    ] as [THREE.Vector3, { id: string; x: number; y: number; z: number }[]][]) {
      const origin = new THREE.Vector3(0, 1.45, 0);
      const pack = new PRJ.FrisbeeSim(1, { origin, direction: dir, owner: "A" });
      const shared = new S.SharedFrisbeeSim(1, origin, dir, "A");
      const pc = packCast(players);
      const sc = worldCast(players);
      const packEv: string[] = [];
      const sharedEv: string[] = [];
      for (let i = 0; i < 480 && (pack.alive || shared.alive); i++) {
        pack.step(pc, {
          onHit: (e: any) => packEv.push(`hit@${i}:${e.damage}:${e.headshot}`),
          onBounce: () => packEv.push(`bounce@${i}`),
          onRest: () => packEv.push(`rest@${i}`),
          onExpire: () => packEv.push(`end@${i}`),
        });
        shared.step(sc, {
          onHit: (e: any) => sharedEv.push(`hit@${i}:${e.damage}:${e.headshot}`),
          onBounce: () => sharedEv.push(`bounce@${i}`),
          onRest: () => sharedEv.push(`rest@${i}`),
          onExpire: () => sharedEv.push(`end@${i}`),
        });
        assert.ok(Math.abs(pack.pos.x - shared.pos.x) < 1e-9 && Math.abs(pack.pos.y - shared.pos.y) < 1e-9 && Math.abs(pack.pos.z - shared.pos.z) < 1e-9, `pos step ${i}`);
        assert.ok(Math.abs(pack.vel.x - shared.vel.x) < 1e-9 && Math.abs(pack.vel.y - shared.vel.y) < 1e-9 && Math.abs(pack.vel.z - shared.vel.z) < 1e-9, `vel step ${i}`);
      }
      assert.deepEqual(sharedEv, packEv, "same events at the same steps");
      assert.equal(pack.bounces, shared.bounces);
    }
  });

  await test("flight: 102 m/s, ONE touch per disc (45 / 68, knockback 2.5 + 0.8), x0.6 after a bounce, bounce budget, end of life", () => {
    const body: any[] = [];
    const s1 = new S.SharedFrisbeeSim(1, { x: 0, y: 1.0, z: 0 }, { x: 0, y: 0, z: -1 }, "A");
    assert.equal(F.tuning.speed, 102, "launch speed = 3 x the pack's 34 m/s");
    assert.ok(Math.abs(Math.hypot(s1.vel.x, s1.vel.y, s1.vel.z) - F.tuning.speed) < 1e-9, "launch speed 102 m/s");
    const wc = worldCast([{ id: "P", x: 0, y: 0.9, z: -8 }]);
    for (let i = 0; i < 240; i++) s1.step(wc, { onHit: (e: any) => body.push(e) });
    assert.equal(body.length, 1, "ONE touch per disc");
    assert.equal(body[0].damage, 45);
    assert.equal(body[0].headshot, false);
    assert.ok(Math.abs(body[0].impulse.y - 0.8) < 1e-12, "0.8 m/s up");
    assert.ok(Math.abs(Math.hypot(body[0].impulse.x, body[0].impulse.z) - 2.5) < 1e-9, "2.5 m/s horizontal");
    assert.ok(body[0].impulse.z < 0, "pushed along the disc");
    const head: any[] = [];
    const s2 = new S.SharedFrisbeeSim(2, { x: 0, y: 1.75, z: 0 }, { x: 0, y: 0, z: -1 }, "A");
    for (let i = 0; i < 240; i++) s2.step(wc, { onHit: (e: any) => head.push(e) });
    assert.equal(head[0].damage, 68);
    assert.equal(head[0].headshot, true);
    // a wall bounce first, then a player on the way BACK (scan the lateral offset: the disc drifts sideways): x0.6
    let found = 0;
    for (let px = 1.2; px <= 3.0; px += 0.1) {
      const bounced: any[] = [];
      let bounces = 0;
      const s3 = new S.SharedFrisbeeSim(3, { x: 0, y: 1.0, z: -2 }, { x: 0.1, y: 0.02, z: -1 }, "A");
      const wc3 = worldCast([{ id: "P", x: px, y: 0.9, z: -4 }]);
      for (let i = 0; i < 600; i++) s3.step(wc3, { onBounce: () => bounces++, onHit: (e: any) => bounced.push(e) });
      if (bounced.length === 0) continue;
      assert.ok(bounces >= 1, "the wall bounced the disc before the touch");
      assert.ok(bounced[0].bounces >= 1);
      assert.ok(bounced[0].damage === 27 || bounced[0].damage === 41, `bounced touch = 27 / 41 (${bounced[0].damage})`);
      found++;
    }
    assert.ok(found > 0, "at least one placement is touched after the bounce");
    // bounce budget + end of life
    const s4 = new S.SharedFrisbeeSim(4, { x: 0, y: 1.0, z: -2 }, { x: 0, y: 0, z: -1 }, "A");
    for (let i = 0; i < 2000 && s4.alive; i++) s4.step(worldCast([]), {});
    assert.ok(!s4.alive, "the disc ends (rest or 3.5 s lifetime)");
    assert.ok(!s4.canDamage, "no damage once it has bounced past the budget / rested");
    // the owner is never a target
    const own: any[] = [];
    const s5 = new S.SharedFrisbeeSim(5, { x: 0, y: 1.0, z: 0 }, { x: 0, y: 0, z: -1 }, "P");
    for (let i = 0; i < 240; i++) s5.step(wc, { onHit: (e: any) => own.push(e) });
    assert.equal(own.length, 0, "the shooter is ignored by its own disc");
  });

  await test("profile = JSON (clips, mounts, mask) and shared timeline = JSON actions", () => {
    const prof = PROF.FrisbeeLauncherProfile;
    assert.equal(prof.id, "FrisbeeLauncher");
    assert.deepEqual(prof.fpMount, profileJson.mounts.fp.matrixColumnMajor);
    assert.deepEqual(prof.tpMount, profileJson.mounts.tp.matrixColumnMajor);
    assert.ok(prof.upperBodyMask.includes("Spine_1") && prof.upperBodyMask.includes("Weapon_R"));
    const a = profileJson.actions;
    const T = F.timeline;
    assert.equal(a.fire.duration, T.fire.duration);
    assert.equal(a.fire.events.discTaken, T.fire.discTaken);
    assert.equal(a.fire.events.discSeated, T.fire.discSeated);
    assert.equal(a.fire.events.readyToFire, T.fire.readyToFire);
    assert.equal(a.fireLast.duration, T.fireLast.duration);
    assert.equal(a.fireLast.events.readyToReload, T.fireLast.readyToReload);
    for (const k of ["reload", "reloadEmpty"] as const) {
      assert.equal(a[k].duration, T[k].duration, k);
      assert.equal(a[k].events.cageSwap, T[k].cageSwap, k);
      assert.equal(a[k].events.cageIn, T[k].cageIn, k);
      assert.equal(a[k].events.readyToFire, T[k].readyToFire, k);
    }
    assert.equal(a.reloadEmpty.events.discTaken, T.reloadEmpty.discTaken);
    assert.equal(a.reloadEmpty.events.discSeated, T.reloadEmpty.discSeated);
    assert.equal(profileJson.discs.cageCapacity, F.cageCapacity);
    assert.equal(profileJson.discs.capacity, F.capacity);
    for (const k of ["fire", "fireAim", "fireLast", "fireLastAim", "reload", "reloadEmpty"]) assert.equal(prof.fpActions[k].loop, false, `FP ${k} is a one-shot`);
    for (const k of ["fire", "fireLast", "reload", "reloadEmpty"]) assert.equal(prof.tpClips.actions[k].loop, false, `TP ${k} is a one-shot (NOT a loop)`);
    assert.equal(PROF.FRISBEE_LAUNCHER_TP_AIM_CLIPS.aim, "TP_Aim_FrisbeeLauncher");
  });

  // ---- FP: pack controller on the REAL ViewmodelSystem ----
  const { ViewmodelSystem } = await server.ssrLoadModule("/src/weapons/viewmodel/ViewmodelSystem.ts");
  const weaponGltf = await read(`${project}/src/assets/potato/FrisbeeLauncher_Weapon.glb`);
  const vm = new ViewmodelSystem(16 / 9);
  await vm.ready;
  const ev: string[] = [];
  let clock = 0;
  const drops: any[] = [];
  const fp = new FrisbeeLauncherController(weaponGltf, {
    firstPerson: true,
    timeline: PROF.FRISBEE_LAUNCHER_TIMELINE,
    events: {
      onShot: (aiming: boolean) => ev.push(aiming ? "shotAim" : "shot"),
      onDryFire: () => ev.push("dry"),
      onCocked: () => ev.push("cocked"),
      onDiscTaken: () => ev.push("taken"),
      onDiscSeated: () => ev.push("seated"),
      onCageOut: () => ev.push("cageOut"),
      onCageDrop: (d: any) => { ev.push("cageDrop"); drops.push(d); },
      onCageIn: () => ev.push("cageIn"),
      onReloadEnd: (c: boolean) => ev.push(c ? "reloadCancelled" : "reloadEnd"),
    },
  });
  fp.attachViewmodel(vm);
  await vm.equip(PROF.FrisbeeLauncherProfile, fp.object, { playEquipClip: true });
  const cam = new THREE.PerspectiveCamera(92, 16 / 9, 0.05, 500);
  const motion = { straight: false, running: false, speed: 0, grounded: true, verticalVelocity: 0, jumpSequence: 0 };
  const step = (seconds: number, dt = 1 / 240) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      clock += dt;
      vm.update(dt, motion);
      vm.syncCamera(cam);
      fp.update(dt);
    }
  };

  await test("FP: Equip clip then Hold; 6 discs (deck + cage 5), two-handed launcher nodes present", () => {
    assert.equal(vm.presentationClock().clip, "FP_Equip_FrisbeeLauncher");
    step(1.2);
    assert.equal(vm.presentationClock().clip, "FP_FrisbeeLauncher_Hold");
    assert.equal(fp.ammo, 6);
    assert.equal(fp.capacity, 6);
    assert.equal(fp.cageCapacity, 5);
    for (const n of ["LaunchSocket", "DiscDeck", "Cage", "CageDisc0", "CageDisc4", "Sled"]) assert.ok(fp.object.getObjectByName(n), n);
    assert.ok(fp.discTemplate && fp.cageTemplate);
  });

  await test("FP: ONE pull = ONE shot, then the automatic re-cock (cocked, taken, seated), next shot only from 1.50 s", () => {
    ev.length = 0;
    assert.ok(fp.canFire && fp.fire(false));
    assert.deepEqual(ev, ["shot"], "the disc leaves DURING fire()");
    assert.equal(fp.deckLoaded, false);
    assert.equal(fp.ammo, 5);
    assert.ok(!fp.canFire, "no second disc while re-cocking");
    step(0.8);
    assert.ok(ev.includes("cocked") && !ev.includes("taken"));
    step(0.25); // 1.05 s: the disc was taken from the cage (0.95 s)
    assert.ok(ev.includes("taken"));
    assert.equal(fp.cageCount, 4);
    assert.ok(!fp.canFire, "not before readyToFire (1.50 s)");
    step(0.3); // 1.35 s: seated (1.29 s) but readyToFire is 1.50 s
    assert.ok(ev.includes("seated") && fp.deckLoaded);
    assert.ok(!fp.canFire);
    step(0.2); // 1.55 s
    assert.ok(fp.canFire, "ready at 1.50 s");
    step(0.6);
    assert.ok(fp.canFire && !fp.busy);
  });

  await test("FP: last discs (cage empty): fireLast, NO re-cock, empty deck -> dry fire refused", () => {
    fp.setAmmo(true, 0);
    ev.length = 0;
    assert.ok(fp.fire(true));
    assert.equal(ev[0], "shotAim");
    assert.equal(fp.currentAction, "fireLast");
    step(1.0);
    assert.ok(!ev.includes("cocked") && !ev.includes("taken"));
    assert.equal(fp.ammo, 0);
    assert.ok(!fp.deckLoaded);
    ev.length = 0;
    assert.equal(fp.fire(false), false);
    assert.deepEqual(ev, ["dry"]);
  });

  await test("FP: cage swap on a loaded deck: cage full at 0.71 s, the empty cage is dropped (FP: no world matrix), fire from 1.30 s", () => {
    fp.setAmmo(true, 2);
    ev.length = 0;
    drops.length = 0;
    assert.ok(fp.canReload && fp.reload());
    assert.equal(fp.currentAction, "reload");
    step(0.5);
    assert.ok(ev.includes("cageOut") && ev.includes("cageDrop"));
    assert.equal(drops[0].world, null, "FP: the clip already drops the cage off screen");
    assert.equal(drops[0].discs, 2, "the cage was thrown with its 2 remaining discs");
    assert.equal(fp.cageCount, 2);
    step(0.3); // 0.80 s: cageSwap (0.71 s)
    assert.equal(fp.cageCount, 5);
    assert.ok(!fp.canFire);
    step(0.55); // 1.35 s
    assert.ok(fp.canFire, "fire again from readyToFire 1.30 s");
    step(0.2);
    assert.ok(ev.includes("cageIn") && ev.includes("reloadEnd"));
    assert.ok(!fp.canReload, "full cage + loaded deck: reload refused");
  });

  await test("FP: cage swap on an EMPTY deck = reloadEmpty (swap + re-cock), disc on the deck at 2.19 s", () => {
    fp.setAmmo(false, 1);
    ev.length = 0;
    assert.ok(fp.reload());
    assert.equal(fp.currentAction, "reloadEmpty");
    step(1.7);
    assert.ok(ev.includes("cocked"));
    step(0.6); // 2.30 s
    assert.ok(fp.deckLoaded && fp.cageCount === 4, `deck loaded, cage 5 -> 4 (${fp.cageCount})`);
    step(0.3);
    assert.ok(fp.canFire);
  });

  await test("FP: cancel a swap before cageIn keeps the old cage; after it the new cage stays; a re-cock is completed", () => {
    step(3.0);
    fp.setAmmo(true, 2);
    assert.ok(fp.reload());
    step(0.9); // past cageSwap, before cageIn
    fp.cancelAction();
    assert.equal(fp.cageCount, 2, "the old cage is given back before the click");
    step(0.3);
    fp.setAmmo(true, 2);
    assert.ok(fp.reload());
    step(1.2); // after cageIn
    fp.cancelAction();
    assert.equal(fp.cageCount, 5, "after the click the new cage stays");
    step(1.0);
    fp.setAmmo(true, 3);
    assert.ok(fp.fire(false));
    step(0.3);
    fp.cancelAction(); // weapon switch mid re-cock
    assert.ok(fp.deckLoaded, "the interrupted re-cock is completed: the disc is on the deck");
    assert.equal(fp.ammo, 3);
  });

  await test("FP: inspection (3.6 s) is refused while acting", () => {
    step(2.0);
    fp.setAmmo(true, 5);
    assert.ok(fp.inspect());
    step(3.8);
    assert.ok(!fp.busy);
  });

  await test("TP: the character gets the FrisbeeLauncher pose set, every action is a ONE-SHOT layer", async () => {
    const CH = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
    const asset = await CH.loadCharacterAsset();
    const set = asset.clips.profiles[PROF.FrisbeeLauncherProfile.id];
    assert.ok(set, "profile pose set built");
    assert.ok(set.hold && set.run, "hold / run");
    for (const k of ["fire", "fireLast", "reload", "reloadEmpty"]) {
      assert.ok(set.actions[k], `TP action ${k}`);
      assert.equal(set.actions[k].loop, false, `${k} is a one-shot`);
      assert.equal(set.actions[k].layered, true, `${k} is a layer over the locomotion`);
    }
  });

  await test("TP controller: playRemote fire = shot + re-cock (fire) or fireLast; reload picks reload / reloadEmpty; the empty cage goes to the world copy", () => {
    const tpEv: string[] = [];
    const tpDrops: any[] = [];
    const remote = new FrisbeeLauncherController(weaponGltf, {
      firstPerson: false,
      timeline: PROF.FRISBEE_LAUNCHER_TIMELINE,
      events: {
        onShot: () => tpEv.push("shot"),
        onCocked: () => tpEv.push("cocked"),
        onCageDrop: (d: any) => { tpEv.push("cageDrop"); tpDrops.push(d); },
      },
    });
    const tpRoot = new THREE.Group();
    tpRoot.add(remote.object);
    const run = (s: number) => { for (let t = 0; t < s; t += 1 / 60) { tpRoot.updateMatrixWorld(true); remote.update(1 / 60); } };
    remote.playRemote("fire", { aiming: false, cage: 5 });
    assert.equal(remote.currentAction, "fire");
    run(1.7);
    assert.ok(tpEv.includes("shot") && tpEv.includes("cocked"), "shot + re-cock");
    assert.equal(remote.cageCount, 4, "the re-cock took a disc from the cage");
    remote.playRemote("fire", { aiming: false, cage: 0 });
    assert.equal(remote.currentAction, "fireLast", "cage empty at the shot -> fireLast, no re-cock");
    run(0.6);
    remote.playRemote("reload", { cage: 2, deckLoaded: true });
    assert.equal(remote.currentAction, "reload");
    run(1.6);
    assert.equal(tpDrops.length, 1, "the cage is thrown once");
    assert.ok(tpDrops[0].world instanceof THREE.Matrix4, "TP: the world matrix of the Cage node is handed over");
    assert.equal(tpDrops[0].discs, 2);
    assert.equal(remote.cageCount, 5, "the new cage is full");
    remote.playRemote("reload", { cage: 3, deckLoaded: false });
    assert.equal(remote.currentAction, "reloadEmpty");
    remote.dispose();
  });

  await test("disc pool: the visible disc leaves the launcher and joins the eye trajectory; snap / end / 24 max / ends at rest or lifetime", () => {
    const scene = new THREE.Scene();
    const pool = new PRJ.FrisbeeProjectiles(scene, fp.discTemplate, packCast([]), {}, { max: 24, visualRadius: 0.1 });
    const eye = new THREE.Vector3(0, 1.6, 0);
    const from = new THREE.Vector3(0.2, 1.2, -0.3);
    const id = pool.fire({ origin: eye, direction: new THREE.Vector3(0, 0, -1), owner: "local", seed: 5, roll: -0.1, visualFrom: from });
    assert.equal(pool.count, 1);
    const disc = pool.group.children[0];
    assert.ok(disc.position.distanceTo(from) < disc.position.distanceTo(eye), "at the start the visible disc is at the launcher");
    for (let i = 0; i < 30; i++) pool.update(1 / 60);
    assert.ok(Math.abs(disc.position.x) < 0.02, "then it joins the eye trajectory (offset converged)");
    assert.ok(pool.has(id));
    pool.snap(id, new THREE.Vector3(0, 1, -3), new THREE.Vector3(0, 0, -20), { bounces: 1 });
    pool.end(id);
    assert.ok(!pool.has(id), "server END removes the copy");
    pool.end(999); // unknown ids are no-ops
    for (let i = 0; i < 30; i++) pool.fire({ origin: eye, direction: new THREE.Vector3(0, 0, -1), owner: "local" });
    assert.equal(pool.count, 24, "24 discs max for the whole game");
    for (let i = 0; i < 60 * 6; i++) pool.update(1 / 60);
    assert.equal(pool.count, 0, "every disc ends (rest or 3.5 s lifetime)");
    pool.dispose();
  });

  await test("dropped cages: fall to the ground, sink after ~6 s, 12 max, keep their discs", async () => {
    const { DroppedCages } = await server.ssrLoadModule("/src/weapons/frisbee/DroppedCages.ts");
    const scene = new THREE.Scene();
    const cages = new DroppedCages(scene, fp.cageTemplate, { ground: () => 0 });
    cages.spawnAt(new THREE.Vector3(0, 1.2, 0), new THREE.Quaternion(), new THREE.Vector3(0.4, -1, 0), 3);
    assert.equal(cages.count, 1);
    const obj = cages.group.children[0];
    let shown = 0;
    obj.traverse((o: any) => { if (/^CageDisc\d+$/.test(o.name) && o.visible) shown++; });
    assert.equal(shown, 3, "it keeps the discs that were still inside");
    for (let i = 0; i < 60 * 1.5; i++) cages.update(1 / 60);
    assert.ok(obj.position.y < 0.6 && obj.position.y > -0.5, `on the ground (${obj.position.y.toFixed(2)})`);
    for (let i = 0; i < 60 * 7.5; i++) cages.update(1 / 60);
    assert.equal(cages.count, 0, "it sinks and disappears after its life");
    for (let i = 0; i < 20; i++) cages.spawnAt(new THREE.Vector3(i, 1, 0), new THREE.Quaternion(), new THREE.Vector3(), 5);
    assert.equal(cages.count, 12, "12 cages max (the oldest go)");
    cages.dispose();
  });

  await test("loadout: FRISBEE_LAUNCHER is a primary with 45 / 68 / 27-41 stats and a 3D icon", async () => {
    const L = await server.ssrLoadModule("/src/loadout/Loadout.ts");
    const item = L.PRIMARY_ITEMS.find((i: any) => i.id === "FRISBEE_LAUNCHER");
    assert.ok(item, "primary catalogue entry");
    assert.equal(item.name, "LANCE-FRISBEE");
    const stats = item.abilities[0].stats.map((s: any) => s.value).join(" | ");
    assert.ok(stats.includes("45 PV") && stats.includes("68 PV") && stats.includes("27 / 41 PV"), stats);
    const wi = fs.readFileSync(`${project}/src/menu/WeaponIconRenderer.ts`, "utf8");
    assert.ok(/FRISBEE_LAUNCHER: frisbeeLauncherUrl/.test(wi));
  });

  console.log(`\n${passed} frisbee tests passed`);
} finally {
  await server.close();
}
