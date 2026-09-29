// WATER FAMAS — headless integration test on the REAL game assets (no WebGL):
// shared rules vs the pack reference, profile / JSON timelines, FP controller
// on the REAL ViewmodelSystem (burst of 3 jets, refill, cancel), TP controller,
// visible jets, wet marks, per-vertex character wetness.
// Usage (repo root):  npx --prefix backend tsx scripts/test-water-famas.mts
import fs from "node:fs";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
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
  const R = await server.ssrLoadModule("/shared/combat/WaterFamasRules.ts");
  const REF = await server.ssrLoadModule("/src/weapons/waterfamas/WaterFamasGameplay.ts");
  const PROF = await server.ssrLoadModule("/src/weapons/profiles/WaterFamasProfile.ts");
  const { WaterFamasController } = await server.ssrLoadModule("/src/weapons/waterfamas/WaterFamasController.ts");
  const W = R.WaterFamasConfig;
  const profileJson = JSON.parse(fs.readFileSync(`${project}/src/assets/potato/WeaponProfile_WaterFamas.json`, "utf8"));

  await test("shared rules == pack reference (capacity, burst, range, cones, PRNG); damage = SlideIO 200 HP tuning", () => {
    assert.equal(W.capacity, REF.CAPACITY);
    assert.equal(W.jetsPerBurst, REF.JETS_PER_BURST);
    assert.deepEqual([...W.jetTimes], REF.JET_TIMES);
    assert.equal(W.burstInterval, REF.BURST_INTERVAL);
    // Deliberate differences with the pack: NO weapon range (pack: 28 m), visible jet speed doubled.
    assert.ok(W.maxRange >= 400 && W.maxRange > REF.MAX_RANGE);
    assert.equal(W.jetSpeed, 120, "visible jet speed x4 (pack: 30 m/s)");
    assert.deepEqual([...W.spreadDeg], REF.SPREAD_DEG);
    assert.equal(W.aimSpreadFactor, REF.ADS_SPREAD_SCALE);
    assert.equal(W.headMultiplier, REF.HEADSHOT_MULTIPLIER);
    // SlideIO tuning: players have 200 HP (the pack assumed 100): 23 body / 34.5 head.
    assert.equal(R.waterFamasJetDamage(false), 23);
    assert.equal(R.waterFamasJetDamage(true), 34.5);
    // Same direction as the pack on the same seed (pack `up` = roll-free camera up).
    const a = new THREE.Vector3();
    for (const seed of [1, 42, 123456789, 4294967295]) {
      for (const k of [0, 1, 2]) {
        for (const aiming of [false, true]) {
          const fwd = new THREE.Vector3(0.3, -0.2, -1).normalize();
          const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
          const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
          REF.jetDirection(fwd, up, k, aiming, seed, a);
          const b = R.waterFamasJetDirection(fwd, k, aiming, seed, { x: 0, y: 0, z: 0 });
          assert.ok(Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.z - b.z) < 1e-12, `seed ${seed} jet ${k} aim ${aiming}`);
          assert.ok(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, fwd.dot(a)))) <= R.waterFamasSpreadDeg(k, aiming) + 1e-9, "inside the cone");
        }
      }
    }
    // 3 jets of one burst: 3 different seeds, same everywhere
    const s = [0, 1, 2].map((k) => R.waterFamasJetSeed(555, k));
    assert.equal(new Set(s).size, 3);
    for (const raw of [-1, 1.5, NaN, "x", 4294967296]) assert.equal(R.sanitizeWaterFamasSeed(raw), null);
    for (const raw of [-1, 3, 0.5, "1", NaN]) assert.equal(R.sanitizeWaterFamasJetIndex(raw), null);
    assert.equal(R.sanitizeWaterFamasJetIndex(2), 2);
  });

  await test("same seed + aim → identical jet on the shooter and the server (wire rounding)", () => {
    const raw = new THREE.Vector3(0.123456, -0.2345678, -0.9876543).normalize();
    const client = R.waterFamasAimDirection(raw);
    const wx = Math.round(raw.x * 1000) / 1000, wy = Math.round(raw.y * 1000) / 1000, wz = Math.round(raw.z * 1000) / 1000;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const srv = { x: wx / l, y: wy / l, z: wz / l }; // backend normalize()
    for (const k of [0, 1, 2]) {
      const a = R.waterFamasJetDirection(client, k, false, R.waterFamasJetSeed(987654, k), { x: 0, y: 0, z: 0 });
      const b = R.waterFamasJetDirection(srv, k, false, R.waterFamasJetSeed(987654, k), { x: 0, y: 0, z: 0 });
      assert.deepEqual(a, b, `jet ${k} bit-identical`);
    }
  });


  await test("profile = JSON (clips, mounts, mask) and shared timeline = JSON actions", () => {
    const prof = PROF.WaterFamasProfile;
    assert.equal(prof.id, "WaterFamas");
    assert.deepEqual(prof.fpMount, profileJson.mounts.fp.matrixColumnMajor);
    assert.deepEqual(prof.tpMount, profileJson.mounts.tp.matrixColumnMajor);
    assert.ok(prof.upperBodyMask.includes("Spine_1") && prof.upperBodyMask.includes("Weapon_R"));
    const a = profileJson.actions;
    assert.deepEqual(a.fire.jets, [...W.jetTimes]);
    assert.equal(a.fire.jetsPerBurst, W.jetsPerBurst);
    assert.equal(a.fire.burstInterval, W.burstInterval);
    assert.equal(a.reload.events.pourEnd, W.timeline.reloadAmmoRefilled);
    assert.equal(a.reload.events.readyToFire, W.timeline.reloadReady);
    assert.equal(a.reload.duration, W.timeline.reloadDuration);
    assert.equal(profileJson.waterTank.capacity, W.capacity);
    assert.equal(prof.fpActions.fire.loop, false, "FP burst is a one-shot");
    assert.equal(prof.tpClips.actions.fire.loop, false, "TP burst is a one-shot (NOT a loop)");
    assert.equal(PROF.WATER_FAMAS_TP_AIM_CLIPS.aim, "TP_Aim_WaterFamas");
  });

  // ---- FP: pack controller on the REAL ViewmodelSystem ----
  const { ViewmodelSystem } = await server.ssrLoadModule("/src/weapons/viewmodel/ViewmodelSystem.ts");
  const weaponGltf = await read(`${project}/src/assets/potato/WaterFamas_Weapon.glb`);
  const vm = new ViewmodelSystem(16 / 9);
  await vm.ready;
  const events: string[] = [];
  const jetLog: { k: number; left: number; t: number }[] = [];
  let clock = 0;
  const fp = new WaterFamasController(weaponGltf, {
    firstPerson: true,
    timeline: PROF.WATER_FAMAS_TIMELINE,
    events: {
      onBurstStart: (aiming: boolean) => events.push(aiming ? "burstAim" : "burst"),
      onJet: (k: number, left: number) => jetLog.push({ k, left, t: clock }),
      onBurstEnd: () => events.push("burstEnd"),
      onDryFire: () => events.push("dry"),
      onCapGrab: () => events.push("capGrab"),
      onPourStart: () => events.push("pourStart"),
      onAmmoRefilled: () => events.push("refill"),
      onCapScrewed: () => events.push("capScrewed"),
      onReloadEnd: (c: boolean) => events.push(c ? "reloadCancelled" : "reloadEnd"),
    },
  });
  fp.attachViewmodel(vm);
  // Same prerequisite as WaterFamasWeapon.load(): derive the straight hip burst clip.
  const { prepareWaterFamasStraightFire } = await server.ssrLoadModule("/src/weapons/waterfamas/WaterFamasStraightFire.ts");
  const SF = PROF.WATER_FAMAS_STRAIGHT_FIRE;
  await prepareWaterFamasStraightFire(PROF.WaterFamasProfile.fpPosesUrl, SF.aim, SF.fire);
  await vm.equip(PROF.WaterFamasProfile, fp.object, { playEquipClip: true });
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

  await test("FP: Equip clip on equip, then Hold; 9 jets in the tank", () => {
    assert.equal(vm.presentationClock().clip, "FP_Equip_WaterFamas");
    step(1.2);
    assert.equal(vm.presentationClock().clip, "FP_WaterFamas_Hold");
    assert.equal(fp.ammo, 9);
    assert.equal(fp.capacity, 9);
    assert.equal(fp.jetsPerBurst, 3);
  });

  await test("FP: ONE pull = a burst of 3 jets at 0 / 0.075 / 0.15 s, the tank drops by 3, 0.45 s between bursts", () => {
    jetLog.length = 0;
    const t0 = clock;
    assert.ok(fp.canFire && fp.fire(false));
    assert.equal(jetLog.length, 1, "jet 0 leaves DURING fire()");
    assert.equal(jetLog[0].k, 0);
    step(0.3);
    assert.deepEqual(jetLog.map((j) => j.k), [0, 1, 2]);
    assert.deepEqual(jetLog.map((j) => j.left), [8, 7, 6]);
    const dt = jetLog.map((j) => j.t - t0);
    console.log(`    jet times: ${dt.map((x) => x.toFixed(3)).join(" / ")} s`);
    assert.ok(Math.abs(dt[1] - 0.075) < 0.01 && Math.abs(dt[2] - 0.15) < 0.01, "0.075 / 0.15 s");
    assert.equal(fp.ammo, 6);
    assert.equal(vm.activeActionKey, "fire", "arms burst clip (one-shot)");
    assert.ok(!fp.canFire, "no second burst inside 0.45 s");
    step(0.2);
    assert.ok(events.includes("burstEnd"), "burst end at 0.42 s");
    assert.ok(fp.canFire, "next burst allowed 0.45 s after the first");
    assert.ok(fp.fire(true), "second burst, aimed");
    step(0.6);
    assert.equal(fp.ammo, 3, "second burst: 3 more jets");
    assert.ok(events.includes("burstAim"), "aimed burst flag");
  });

  // Muzzle off the camera axis (deg): the gun barrel = weapon -X.
  const aimErr = () => {
    const q = fp.muzzle.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    const c = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return THREE.MathUtils.radToDeg(f.angleTo(c));
  };

  await test("FP: hip burst = gun STRAIGHT like ADS within ~0.05 s, back to Hold quickly at the end", () => {
    step(0.6);
    const holdErr = aimErr();
    motion.straight = true;
    step(0.6);
    const adsErr = aimErr();
    motion.straight = false;
    step(0.6);
    assert.ok(fp.canFire && fp.fire(false));
    assert.equal(vm.presentationClock().clip, "FP_Fire_WaterFamas_Straight", "straight burst clip");
    const errs: number[] = [];
    for (let t = 0; t < 0.42; t += 1 / 240) { step(1 / 240, 1 / 240); errs.push(aimErr()); }
    const at = (s: number) => errs[Math.min(errs.length - 1, Math.round(s * 240))];
    console.log(`    muzzle off-axis: hold ${holdErr.toFixed(1)}°, ADS ${adsErr.toFixed(1)}°, burst t=0.02 ${at(0.02).toFixed(1)}° / 0.05 ${at(0.05).toFixed(1)}° / 0.25 ${at(0.25).toFixed(1)}° / 0.40 ${at(0.4).toFixed(1)}°`);
    assert.ok(holdErr > 4, "the hold pose is off the aim axis");
    assert.ok(at(0.06) < holdErr / 2, "already mostly straight 60 ms after the pull");
    assert.ok(Math.max(...errs.slice(Math.round(0.08 * 240), Math.round(0.3 * 240))) < holdErr / 2, "straight while the 3 jets leave");
    step(0.5);
    assert.ok(Math.abs(aimErr() - holdErr) < 2, "back to the hold pose after the burst");
    fp.setAmmo(9); // the following tests start from a full tank
  });

  await test("FP: empty → dry fire; refill: ammo 9 at pourEnd 1.98 s, fire again at 2.95 s, ends at 3.3 s", () => {
    step(0.5);
    while (fp.ammo > 0) { if (fp.canFire) fp.fire(false); step(0.05); }
    step(0.5);
    events.length = 0;
    assert.ok(!fp.fire(false) && events.includes("dry"), "dry fire when empty");
    assert.ok(fp.canReload && fp.reload());
    assert.ok(fp.reloading);
    step(1.9);
    assert.equal(fp.ammo, 0, "before the end of the pour: still empty");
    assert.ok(events.includes("capGrab") && events.includes("pourStart"));
    step(0.12);
    assert.equal(fp.ammo, 9, "9 jets at 1.98 s");
    assert.ok(events.includes("refill"));
    assert.ok(!fp.canFire, "not before readyToFire (2.95 s)");
    step(0.88); // t = 2.90 s
    assert.ok(!fp.canFire, "still refused at 2.90 s");
    step(0.07); // t = 2.97 s
    assert.ok(fp.canFire, "fire possible from 2.95 s");
    step(0.5);
    assert.ok(events.includes("reloadEnd") && !fp.reloading, "refill ends at 3.3 s");
  });

  await test("FP: switching weapon before the end of the pour keeps the old ammo (cancel)", () => {
    while (fp.ammo > 6) { if (fp.canFire) fp.fire(false); step(0.05); }
    step(0.6);
    assert.equal(fp.ammo, 6);
    events.length = 0;
    assert.ok(fp.reload());
    step(1.0);
    fp.cancelReload();
    assert.ok(events.includes("reloadCancelled"));
    assert.equal(fp.ammo, 6, "ammo unchanged");
    assert.ok(!fp.reloading);
    fp.setAmmo(9);
    assert.equal(fp.ammo, 9);
  });

  // ---- visible jets, wet marks, wet characters ----
  const { WaterFamasFX } = await server.ssrLoadModule("/src/weapons/waterfamas/WaterFamasFX.ts");
  const scene = new THREE.Scene();
  const fx = new WaterFamasFX(scene);

  await test("FX: 3 jets = 3 separate packets, the wet mark appears on arrival and dries in ~6 s; 3 draw objects", () => {
    const from = new THREE.Vector3(0, 1.5, 0);
    const to = new THREE.Vector3(0, 1.5, -10);
    const normal = new THREE.Vector3(0, 0, 1);
    for (let k = 0; k < 3; k++) {
      fx.spawn(from, to, { normal, seed: 100 + k }, null);
      fx.update(0.075);
    }
    assert.equal(fx.jets.streams.count, 3, "one instanced packet per jet");
    for (let i = 0; i < 30; i++) fx.update(1 / 60);
    assert.ok(fx.marks.surfaceMesh.visible, "wet mark visible after the arrival");
    for (let i = 0; i < 7 * 60; i++) fx.update(1 / 60);
    assert.ok(!fx.marks.surfaceMesh.visible, "dry (mesh hidden) after ~6 s");
    let objects = 0;
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) objects++; });
    assert.equal(objects, 3, "streams + droplets + wet marks = 3 objects for the whole session");
  });

  await test("FX: character wetness attaches per vertex, dries on death, detach restores the original geometry", () => {
    const body = new THREE.SkinnedMesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshStandardMaterial());
    body.name = "Potato";
    const bones = [new THREE.Bone()];
    body.add(bones[0]);
    body.bind(new THREE.Skeleton(bones));
    const root = new THREE.Group();
    root.add(body);
    scene.add(root);
    const original = body.geometry;
    const w = fx.marks.attach(body);
    assert.ok(body.geometry !== original && body.geometry.getAttribute("wet"), "wet attribute added");
    w.soak(0, new THREE.Vector3(1 / 3, 1 / 3, 1 / 3), 0.3, fx.marks.uPlayerTime.value);
    const arr = (body.geometry.getAttribute("wet") as THREE.BufferAttribute).array as Float32Array;
    assert.ok(arr.some((v, i) => i % 2 === 1 && v > 0), "some vertices are wet");
    fx.dryUnder(root);
    assert.ok(!(arr as Float32Array).some((v, i) => i % 2 === 1 && v > 0), "dry again after death / respawn");
    fx.detachUnder(root);
    assert.equal(body.geometry, original, "original geometry restored");
  });

  await test("TP: the character gets the WaterFamas pose set, the burst is a ONE-SHOT layer", async () => {
    const CH = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
    const asset = await CH.loadCharacterAsset();
    const set = asset.clips.profiles[PROF.WaterFamasProfile.id];
    assert.ok(set, "profile pose set built");
    assert.ok(set.hold && set.run && set.actions.fire && set.actions.reload, "hold / run / fire / reload");
    assert.equal(set.actions.fire.loop, false);
    assert.equal(set.actions.fire.layered, true);
  });

  await test("TP controller: playRemote fire = a burst with 3 jets, refill via Reload_TP", () => {
    const remote = new WaterFamasController(clone(weaponGltf.scene) && weaponGltf, {
      firstPerson: false,
      timeline: PROF.WATER_FAMAS_TIMELINE,
      events: { onJet: () => events.push("tpJet"), onBurstStart: () => events.push("tpBurst") },
    });
    events.length = 0;
    remote.playRemote("fire", false);
    for (let i = 0; i < 60; i++) remote.update(1 / 240 * 4);
    assert.equal(events.filter((e) => e === "tpJet").length, 3);
    assert.equal(events.filter((e) => e === "tpBurst").length, 1);
    remote.playRemote("reload");
    assert.ok(remote.reloading);
    for (let i = 0; i < 300; i++) remote.update(1 / 60);
    assert.equal(remote.ammo, 9);
    remote.dispose();
  });

  console.log(`\n${passed} water famas tests passed`);
} finally {
  await server.close();
}
