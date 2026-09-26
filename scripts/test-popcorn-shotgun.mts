// POPCORN SHOTGUN — headless integration test on the REAL game assets
// (no WebGL): shared rules vs pack reference, distance table, profile /
// JSON timelines, FP controller on the REAL ViewmodelSystem, TP pose set
// on the REAL character, TP controller, projectile pool.
// Usage (repo root):  npx --prefix backend tsx scripts/test-popcorn-shotgun.mts
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
  console.log(`  ✓ ${name}`);
}

const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const R = await server.ssrLoadModule("/shared/combat/PopcornShotgunRules.ts");
  const REF = await server.ssrLoadModule("/src/weapons/popcorn/PopcornSpread.ts");
  const PROF = await server.ssrLoadModule("/src/weapons/profiles/PopcornShotgunProfile.ts");
  const { PopcornShotgunController } = await server.ssrLoadModule("/src/weapons/popcorn/PopcornShotgunController.ts");
  const { PopcornProjectiles } = await server.ssrLoadModule("/src/weapons/popcorn/PopcornProjectiles.ts");
  const P = R.PopcornShotgunConfig;
  const profileJson = JSON.parse(fs.readFileSync(`${project}/src/assets/potato/WeaponProfile_PopcornShotgun.json`, "utf8"));

  await test("shared pellets == pack reference PopcornSpread on the same seed (pack rings)", () => {
    const packRings = [{ n: 1, deg: 0, phaseDeg: 0 }, { n: 5, deg: 1.6, phaseDeg: 0 }, { n: 6, deg: 3.4, phaseDeg: 30 }];
    const a = Array.from({ length: 12 }, () => new THREE.Vector3());
    const b = Array.from({ length: 12 }, () => new THREE.Vector3());
    for (const seed of [1, 42, 123456789, 4294967295]) {
      const fwd = new THREE.Vector3(0.3, -0.2, -1).normalize();
      // pack `up` = camera up without roll → the same basis as ours.
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      REF.pelletDirections(fwd, up, seed, a);
      R.popcornPelletDirections(fwd, seed, b, packRings);
      for (let i = 0; i < 12; i++) assert.ok(a[i].distanceTo(b[i]) < 1e-9, `seed ${seed} pellet ${i}`);
    }
    for (const d of [0, 5, 8, 12, 18, 23, 28, 40]) assert.ok(Math.abs(REF.pelletFalloff(d) - R.popcornPelletFalloff(d)) < 1e-12);
    const hits = [{ distance: 4, head: false }, { distance: 9, head: false }];
    const refHits = hits.map((h) => ({ distance: h.distance, zone: "body" }));
    assert.ok(Math.abs(REF.shotDamage(refHits, 100, 100) - R.popcornShotDamage(hits, 100, 100)) < 1e-9);
    assert.equal(R.popcornShotDamage([{ distance: 39, head: true }], 100, 73), 73, "head pellet = remaining HP");
  });

  await test("same seed + same aim → identical pellets on the shooter and the server (wire rounding)", () => {
    const raw = new THREE.Vector3(0.123456, -0.2345678, -0.9876543).normalize();
    const client = R.popcornAimDirection(raw);
    const wx = Math.round(raw.x * 1000) / 1000, wy = Math.round(raw.y * 1000) / 1000, wz = Math.round(raw.z * 1000) / 1000;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const srv = { x: wx / l, y: wy / l, z: wz / l }; // backend normalize()
    const a = Array.from({ length: 12 }, () => ({ x: 0, y: 0, z: 0 }));
    const b = Array.from({ length: 12 }, () => ({ x: 0, y: 0, z: 0 }));
    R.popcornPelletDirections(client, 987654, a);
    R.popcornPelletDirections(srv, 987654, b);
    assert.deepEqual(a, b, "bit-identical");
  });

  await test("distance profile (real server volumes): one-shot up close, partial at 10-12 m, ~1 weak pellet at 20+ m", () => {
    const out = Array.from({ length: 12 }, () => ({ x: 0, y: 0, z: 0 }));
    const stats: Record<number, { pel: number; bodyKill: number; dmg: number }> = {};
    const N = 3000;
    console.log("    dist | pellets/12 | body dmg | body one-shot | shots with a head pellet (aim = chest)");
    for (const d of [2, 4, 5, 6, 8, 10, 12, 15, 20, 30]) {
      let pel = 0, kill = 0, dmg = 0, head = 0;
      for (let s = 0; s < N; s++) {
        const eye = { x: 0, y: 0.55, z: 0 };
        const fl = Math.hypot(d, 0.55);
        R.popcornPelletDirections({ x: 0, y: -0.55 / fl, z: -d / fl }, (s * 2654435761) >>> 0, out);
        const hits: { distance: number; head: boolean }[] = [];
        for (const dir of out) {
          const h = R.popcornRayVsPlayer(eye, dir, { x: 0, y: 0, z: -d }, P.maxRange);
          if (h) hits.push({ distance: h.t, head: h.head });
        }
        pel += hits.length;
        if (R.popcornShotIsHeadshot(hits)) head++;
        const body = R.popcornShotDamage(hits.map((h) => ({ ...h, head: false })), 100, 100);
        dmg += Math.min(body, 150);
        if (body >= 100) kill++;
      }
      stats[d] = { pel: pel / N, bodyKill: kill / N, dmg: dmg / N };
      console.log(
        `    ${String(d).padStart(4)} | ${(pel / N).toFixed(1).padStart(10)} | ${(dmg / N).toFixed(0).padStart(6)} % | ${(100 * kill / N).toFixed(0).padStart(11)} % | ${(100 * head / N).toFixed(0).padStart(4)} %`,
      );
    }
    assert.ok(stats[2].bodyKill === 1 && stats[4].bodyKill === 1, "2-4 m body = one shot");
    assert.ok(stats[10].pel >= 2 && stats[12].pel <= 3.5 && stats[12].bodyKill === 0, "10-12 m: 2-3 pellets, partial");
    assert.ok(stats[20].pel <= 1.5 && stats[30].pel >= 0.9 && stats[30].dmg < 10, "20 m+: ~1 weak pellet");
  });

  await test("profile = JSON (clips, mounts, mask) and shared timeline = JSON actions", () => {
    const prof = PROF.PopcornShotgunProfile;
    assert.equal(prof.id, "PopcornShotgun");
    assert.deepEqual(prof.fpMount, profileJson.mounts.fp.matrixColumnMajor);
    assert.deepEqual(prof.tpMount, profileJson.mounts.tp.matrixColumnMajor);
    assert.ok(prof.upperBodyMask.includes("Spine_1") && prof.upperBodyMask.includes("Weapon_R"));
    const a = profileJson.actions;
    assert.equal(a.fire.events.readyToFire, P.timeline.fireReady);
    assert.equal(a.fireLast.events.readyToFire, P.timeline.fireLastReady);
    assert.equal(a.reload.events.ammoRefilled, P.timeline.reloadAmmoRefilled);
    assert.equal(a.reload.events.readyToFire, P.timeline.reloadReady);
    assert.equal(a.reload.duration, P.timeline.reloadDuration);
    assert.equal(profileJson.popcorn.shots, P.shots);
    assert.equal(PROF.POPCORN_TP_AIM_CLIPS.aim, "TP_Aim_PopcornShotgun");
  });


  // ---- FP: pack controller on the REAL ViewmodelSystem ----
  const { ViewmodelSystem } = await server.ssrLoadModule("/src/weapons/viewmodel/ViewmodelSystem.ts");
  const weaponGltf = await read(`${project}/src/assets/potato/PopcornShotgun_Weapon.glb`);
  const vm = new ViewmodelSystem(16 / 9);
  await vm.ready;
  const events: string[] = [];
  const fp = new PopcornShotgunController(weaponGltf, {
    firstPerson: true,
    timeline: PROF.POPCORN_SHOTGUN_TIMELINE,
    burstParent: vm.scene,
    events: {
      onDryFire: () => events.push("dry"),
      onPumpBack: () => events.push("pumpBack"),
      onLidOpen: () => events.push("lidOpen"),
      onPop: () => events.push("pop"),
    },
  });
  fp.attachViewmodel(vm);
  await vm.equip(PROF.PopcornShotgunProfile, fp.object, { playEquipClip: true });
  const cam = new THREE.PerspectiveCamera(92, 16 / 9, 0.05, 500);
  const motion = { straight: false, running: false, speed: 0, grounded: true, verticalVelocity: 0, jumpSequence: 0 };
  const step = (seconds: number, dt = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      vm.update(dt, motion);
      vm.syncCamera(cam);
      fp.update(dt);
    }
  };

  await test("FP: Equip clip on equip, then Hold", () => {
    assert.equal(vm.presentationClock().clip, "FP_Equip_PopcornShotgun");
    step(1);
    assert.equal(vm.presentationClock().clip, "FP_PopcornShotgun_Hold");
  });

  await test("FP: fire (pump) → FireLast (no pump) → dry fire → reload gates 1.75 / 2.06 s → full tank", () => {
    assert.equal(fp.tank.popcornCount, 72, "starts full (72 popcorns)");
    assert.ok(fp.canFire && fp.fire());
    assert.equal(vm.activeActionKey, "fire");
    assert.equal(fp.tank.popcornCount, 36, "half after 1 shot");
    step(0.5);
    assert.ok(events.includes("pumpBack"), "Fire pumps");
    assert.ok(!fp.canFire, "not ready before 0.58 s");
    step(0.1);
    assert.ok(fp.canFire);
    events.length = 0;
    assert.ok(fp.fire());
    assert.equal(vm.activeActionKey, "fireLast");
    step(0.6);
    assert.ok(!events.includes("pumpBack"), "FireLast never pumps");
    assert.equal(fp.tank.popcornCount, 0, "empty");
    assert.ok(!fp.fire() && events.includes("dry"), "3rd click = dry fire");
    assert.ok(fp.reload());
    step(1.7);
    assert.equal(fp.ammo, 0, "ammo not counted before 1.75 s");
    step(0.1);
    assert.equal(fp.ammo, 2);
    assert.ok(!fp.canFire, "not before 2.06 s");
    step(0.3);
    assert.ok(fp.canFire, "fire again from 2.06 s");
    assert.ok(events.includes("lidOpen") && events.filter((e) => e === "pop").length > 30, "lid + crescendo pops");
    step(0.3);
    assert.equal(fp.tank.popcornCount, 72, "tank full again");
  });

  await test("FP: weapon switch before 1.75 s cancels the reload (ammo unchanged), after = full", () => {
    fp.fire();
    step(0.7);
    fp.reload();
    step(1.0);
    fp.cancelReload();
    assert.equal(fp.ammo, 1, "cancel before refill keeps 1");
    assert.equal(fp.reloading, false);
    fp.reload();
    step(1.8);
    fp.cancelReload();
    assert.equal(fp.ammo, 2, "cancel after refill keeps the full tank");
  });

  await test("FP: one-hand inspection (3.6 s) arms + weapon clips", () => {
    step(0.3);
    assert.ok(fp.inspect());
    assert.ok(vm.inspecting);
    step(3.8);
    assert.ok(!vm.inspecting, "inspection finished");
  });

  await test("FP: running / jumping sets the popcorn in motion, then it sleeps", () => {
    step(3); // settle
    let awakeFrames = 0;
    for (let i = 0; i < 300; i++) {
      step(1 / 60);
      if (fp.tank.sim.awake) awakeFrames++;
    }
    console.log(`    idle (Hold clip breathing, still camera): physics awake ${awakeFrames}/300 frames`);
    assert.ok(awakeFrames < 300, "sleeps at least part of the time at rest");
    // Weapon completely still (no mixer advance): must fall asleep.
    for (let i = 0; i < 240; i++) {
      vm.syncCamera(cam);
      fp.update(1 / 60);
    }
    assert.ok(!fp.tank.sim.awake, "fully still → asleep (no simulation, no GPU upload)");
    fp.fire(); // recoil + suction wake the tank
    step(0.05);
    assert.ok(fp.tank.sim.awake, "shot wakes the physics");
    step(1);
    for (let i = 0; i < 300; i++) {
      vm.syncCamera(cam);
      fp.update(1 / 60);
    }
    assert.ok(!fp.tank.sim.awake, "back to sleep once the weapon is still");
  });


  // ---- TP: pose set on the REAL character + remote controller ----
  const { loadCharacterAsset } = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
  const { RemotePlayerAnimationController } = await server.ssrLoadModule("/src/network/remote/RemotePlayerAnimationController.ts");
  const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
  const asset = await loadCharacterAsset();

  await test("TP: PopcornShotgun pose set built (hold / run / masked jump-dash-slide / layered actions)", () => {
    const set = asset.clips.profiles?.PopcornShotgun;
    assert.ok(set, "profile set 'PopcornShotgun'");
    const mask = new Set<string>(PROF.PopcornShotgunProfile.upperBodyMask);
    const bone = (n: string) => n.slice(0, n.lastIndexOf("."));
    for (const k of ["fire", "fireLast", "reload"]) {
      assert.ok(set.actions[k]?.layered, `${k} is a layer over the legs`);
      assert.ok(set.actions[k].clip.tracks.every((t: THREE.KeyframeTrack) => mask.has(bone(t.name))), `${k} only drives the mask`);
    }
    assert.ok(Math.abs(set.actions.reload.clip.duration - 2.2) < 0.02 && Math.abs(set.actions.fire.clip.duration - 0.9) < 0.02);
    // Every skeleton bone the locomotion drives is also driven by hold (no bind-pose fallback).
    const holdBones = new Set(set.hold.tracks.map((t: THREE.KeyframeTrack) => bone(t.name)));
    for (const t of asset.clips.idle.tracks) assert.ok(holdBones.has(bone(t.name)), `hold covers ${t.name}`);
    for (const t of set.jump.tracks) if (mask.has(bone(t.name))) assert.equal(t.times.length, 1, "jump grip frozen");
    assert.ok(set.lowerBody, "lower-body variants for the layered actions");
  });

  await test("TP: remote controller on Weapon_R + TP clip + weapon clip on the SAME frame", () => {
    const model = clone(asset.template);
    const anim = new RemotePlayerAnimationController(model, -0.9, asset.clips);
    anim.setArmedProfile("PopcornShotgun");
    assert.equal(anim.armedProfileId, "PopcornShotgun");
    const remote = new PopcornShotgunController(weaponGltf, { firstPerson: false, timeline: PROF.POPCORN_SHOTGUN_TIMELINE });
    const { createWeaponMount } = { createWeaponMount: (n: string, m: number[]) => { const g0 = new THREE.Group(); g0.name = n; g0.matrix.fromArray(m); g0.matrixAutoUpdate = false; return g0; } };
    const mount = createWeaponMount("PopcornShotgunTPMount", PROF.PopcornShotgunProfile.tpMount);
    model.getObjectByName("Weapon_R")!.add(mount);
    mount.add(remote.object);
    remote.playRemote("fire");
    const key = remote.ammo === 0 ? "fireLast" : "fire";
    assert.equal(key, "fire");
    assert.ok(anim.playOverride(key, { fadeIn: 0.02 }));
    anim.update(0.1, 0, 0, 0, 0, 0);
    remote.update(0.1);
    assert.equal(anim.presentationClock().clip, "TP_Fire_PopcornShotgun_Layer");
    remote.update(1);
    remote.playRemote("fire");
    assert.equal(remote.ammo, 0, "last load → FireLast");
    remote.playRemote("reload");
    for (let i = 0; i < 140; i++) remote.update(1 / 60);
    assert.equal(remote.ammo, 2, "remote reload refills on the clock");
    assert.equal(remote.tank.popcornCount, 72, "baked full layout");
    // The weapon points straight ahead in the TP hold (pack §2.3).
    anim.clearOverride(0);
    for (let i = 0; i < 30; i++) anim.update(1 / 30, 0, 0, 0, 0, 0);
    model.updateMatrixWorld(true);
    const q = remote.muzzle.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    const charFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()).multiply(
      (asset.template.children[0] as THREE.Object3D).quaternion.clone().invert()));
    assert.ok(Math.abs(fwd.y) < 0.2, `barrel level in TP hold (y=${fwd.y.toFixed(3)})`);
    void charFwd;
    remote.dispose();
  });

  await test("ONE visual effect: no separate muzzle puff (FP / TP controllers created without burst)", () => {
    const src = fs.readFileSync(`${project}/src/weapons/popcorn/PopcornShotgunWeapon.ts`, "utf8");
    const remoteSrc = fs.readFileSync(`${project}/src/network/remote/RemoteWeaponController.ts`, "utf8");
    assert.ok(/burstParent: null/.test(src) && /burstParent: null/.test(remoteSrc), "burstParent null in FP and TP");
    const scene = new THREE.Scene();
    const c = new PopcornShotgunController(weaponGltf, { firstPerson: false, timeline: PROF.POPCORN_SHOTGUN_TIMELINE, burstParent: null });
    scene.add(c.object);
    c.playRemote("fire");
    c.update(0.1);
    let burst = 0;
    scene.traverse((o) => { if (o.name === "PopcornMuzzleBurst") burst++; });
    assert.equal(burst, 0, "no PopcornMuzzleBurst mesh");
    c.dispose();
  });

  await test("visual popcorns: 1 InstancedMesh, big (~11 cm), fall to the floor after a wall hit, rest 2 s, zero GPU upload at rest", () => {
    const scene = new THREE.Scene();
    const pool = new PopcornProjectiles(fp.tank.popcornMesh, scene);
    assert.equal(scene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh).length, 1, "+1 draw call");
    assert.equal(pool.mesh.geometry, fp.tank.popcornMesh.geometry, "tank geometry shared (nothing cloned)");
    pool.setCamera(new THREE.Vector3(0, 1.5, 0));
    const from = new THREE.Vector3(0, 1.5, 0);
    // 6 pellets on a WALL at 10 m (normal +Z, floor at y = 0), 6 on the FLOOR at 8 m.
    const to = [
      ...Array.from({ length: 6 }, (_, i) => new THREE.Vector3(i * 0.2, 1.2, -10)),
      ...Array.from({ length: 6 }, (_, i) => new THREE.Vector3(i * 0.2, 0, -8)),
    ];
    const normal = to.map((_, i) => (i < 6 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)));
    const floor = to.map((_, i) => (i < 6 ? 0 : null));
    pool.spawn(from, to, normal, floor);
    pool.update(1 / 60);
    assert.equal(pool.mesh.count, 12);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    // FAST like real pellets: ~10 m in ≈ 0.06 s. Frame 1 (above) = in flight, stretched streak.
    pool.mesh.getMatrixAt(0, m);
    m.decompose(p, q, s);
    const widthCm = s.x * 0.24 * 100, streakCm = s.z * 0.24 * 100;
    console.log(`    in flight: streak ${streakCm.toFixed(0)} cm long × ${widthCm.toFixed(1)} cm wide`);
    assert.ok(p.z < -0.5 && p.z > -10, "frame 1: visible IN FLIGHT (never teleported to the impact)");
    assert.ok(streakCm > widthCm * 2, "stretched along its trajectory");
    for (let i = 0; i < 6; i++) pool.update(1 / 60);
    pool.mesh.getMatrixAt(0, m);
    m.decompose(p, q, s);
    const cm = s.x * 0.24 * 100;
    assert.ok(cm >= 9, `popcorn ≈ ${cm.toFixed(1)} cm once landed`);
    // flight time: a 10 m shot reaches its impact within ~0.1 s (≤ 6 frames)
    assert.ok(Math.abs(p.z + 10) < 0.6 || p.y < 1.2, "arrived at the impact within 0.12 s");
    // point blank (1.5 m): arrives in < 1 frame, still shown in flight for one frame
    const scene2 = new THREE.Scene();
    const close = new PopcornProjectiles(fp.tank.popcornMesh, scene2);
    close.spawn(from, [new THREE.Vector3(0, 1.5, -1.5)], [new THREE.Vector3(0, 0, 1)], [0]);
    close.update(1 / 60);
    close.mesh.getMatrixAt(0, m);
    m.decompose(p, q, s);
    assert.ok(p.z > -1.5 && p.z < 0, "point blank: one frame in flight before the impact");
    close.dispose();
    // land everything: wait until two consecutive updates upload nothing
    let settle = 0;
    let lastV = -1;
    while (settle < 180) {
      pool.update(1 / 60);
      settle++;
      const v = pool.mesh.instanceMatrix.version;
      if (v === lastV) break;
      lastV = v;
    }
    const landedAt = (settle + 7) / 60;
    assert.equal(pool.mesh.count, 12, "all still visible after landing");
    assert.ok(landedAt < 1.5, `all landed within ${landedAt.toFixed(2)} s`);
    let maxY = -1;
    for (let i = 0; i < 12; i++) { pool.mesh.getMatrixAt(i, m); m.decompose(p, q, s); maxY = Math.max(maxY, p.y); }
    assert.ok(maxY < 0.1, `every popcorn (wall hits included) rests on the floor (max y ${maxY.toFixed(3)})`);
    // resting: no rebuild, no upload
    const v0 = pool.mesh.instanceMatrix.version;
    for (let i = 0; i < 60; i++) pool.update(1 / 60);
    assert.equal(pool.mesh.instanceMatrix.version, v0, "zero GPU upload while everything rests");
    // measure how long each popcorn stays visible after the LAST one landed
    let visibleFor = 1;
    while (pool.activeCount === 12 && visibleFor < 300) { pool.update(1 / 60); visibleFor++; }
    const restSeen = (visibleFor + 60) / 60; // + the 60 frames above
    console.log(`    resting on the floor ≈ ${restSeen.toFixed(2)} s (last landed), then shrink`);
    // 2 s posé + la disparition (0,3 s, compté tant que le popcorn rétrécit)
    assert.ok(restSeen >= 1.9 && restSeen <= 2.4, "≈ 2 s on the floor");
    for (let i = 0; i < 30; i++) pool.update(1 / 60);
    assert.equal(pool.activeCount, 0, "all gone after rest + shrink");
    assert.equal(pool.mesh.count, 0);
    // no floor under a wall hit → disappears while falling
    pool.spawn(from, [new THREE.Vector3(0, 1.2, -5)], [new THREE.Vector3(0, 0, 1)], [null]);
    for (let i = 0; i < 120; i++) pool.update(1 / 60);
    assert.equal(pool.activeCount, 0, "no floor: vanishes after the fall timeout");
    // pool full: the oldest resting popcorns are recycled, never more than MAX drawn
    for (let k = 0; k < 60; k++) { pool.spawn(from, to, normal, floor); pool.update(1 / 30); }
    assert.ok(pool.mesh.count <= 512 && pool.activeCount <= 512, "capped at 512");
    pool.dispose();
  });

  await test("TP character GLB swapped (skin weights only — same size, nodes, skeleton)", () => {
    const b = fs.readFileSync(`${project}/src/assets/potato/Potato_TP_Character.glb`);
    const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
    assert.equal(b.length, 779132, "same file size as the pack");
    assert.ok(j.nodes.some((n: { name: string }) => n.name === "Weapon_R") && j.skins.length === 1);
  });

  console.log(`\n${passed} popcorn shotgun tests passed`);
} finally {
  await server.close();
}

