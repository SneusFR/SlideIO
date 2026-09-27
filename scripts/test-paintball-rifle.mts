// PAINTBALL RIFLE — headless integration test on the REAL game assets
// (no WebGL): shared rules vs pack reference, profile / JSON timelines,
// FP controller on the REAL ViewmodelSystem (auto fire, FireEnd, hopper
// swap), TP pose set on the REAL character, TP controller, visual balls,
// persistent splats and per-vertex character paint.
// Usage (repo root):  npx --prefix backend tsx scripts/test-paintball-rifle.mts
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
  console.log(`  ✓ ${name}`);
}

const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const R = await server.ssrLoadModule("/shared/combat/PaintballRifleRules.ts");
  const REF = await server.ssrLoadModule("/src/weapons/paintball/PaintballSpread.ts");
  const PROF = await server.ssrLoadModule("/src/weapons/profiles/PaintballRifleProfile.ts");
  const { PaintballRifleController } = await server.ssrLoadModule("/src/weapons/paintball/PaintballRifleController.ts");
  const { PaintballFX } = await server.ssrLoadModule("/src/weapons/paintball/PaintballFX.ts");
  const P = R.PaintballRifleConfig;
  const profileJson = JSON.parse(fs.readFileSync(`${project}/src/assets/potato/WeaponProfile_PaintballRifle.json`, "utf8"));

  await test("shared rules == pack reference PaintballSpread (damage, range, capacity, bloom, ball direction)", () => {
    assert.equal(P.bodyDamage, REF.DAMAGE_BODY);
    assert.equal(P.headMultiplier, REF.HEADSHOT_MULTIPLIER);
    assert.equal(R.paintballDamage(false), 12);
    assert.equal(R.paintballDamage(true), 18);
    assert.equal(P.maxRange, REF.MAX_RANGE);
    assert.equal(P.capacity, REF.CAPACITY);
    assert.equal(P.fireInterval, REF.FIRE_INTERVAL);
    assert.equal(P.spreadMinDeg, REF.SPREAD_MIN_DEG);
    assert.equal(P.spreadMaxDeg, REF.SPREAD_MAX_DEG);
    assert.equal(P.bloomPerShotDeg, REF.BLOOM_PER_SHOT_DEG);
    assert.equal(P.bloomRecoveryDegPerSecond, REF.BLOOM_RECOVERY_DEG_PER_S);
    // Same direction as the pack on the same seed (pack `up` = roll-free camera up).
    const a = new THREE.Vector3();
    for (const seed of [1, 42, 123456789, 4294967295]) {
      for (const spread of [0.35, 1.2, 2.2]) {
        const fwd = new THREE.Vector3(0.3, -0.2, -1).normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        REF.ballDirection(fwd, up, spread, seed, a);
        const b = R.paintballBallDirection(fwd, spread, seed, { x: 0, y: 0, z: 0 });
        assert.ok(Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.z - b.z) < 1e-12, `seed ${seed} spread ${spread}`);
        assert.ok(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, fwd.dot(a)))) <= spread + 1e-9, "inside the cone");
      }
    }
    const refBloom = new REF.PaintballBloom();
    const bloom = new R.PaintballBloomState();
    for (let i = 0; i < 12; i++) { refBloom.onShot(); bloom.onShot(); }
    assert.equal(bloom.spreadDeg, refBloom.spreadDeg);
    refBloom.update(0.3, true); bloom.update(0.3, true);
    assert.ok(Math.abs(bloom.spreadDeg - refBloom.spreadDeg) < 1e-12);
  });

  await test("same seed + aim + spread → identical ball on the shooter and the server (wire rounding)", () => {
    const raw = new THREE.Vector3(0.123456, -0.2345678, -0.9876543).normalize();
    const client = R.paintballAimDirection(raw);
    const wx = Math.round(raw.x * 1000) / 1000, wy = Math.round(raw.y * 1000) / 1000, wz = Math.round(raw.z * 1000) / 1000;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const srv = { x: wx / l, y: wy / l, z: wz / l }; // backend normalize()
    const spread = R.quantizePaintballSpread(1.23456789);
    assert.equal(spread, 1.235);
    assert.equal(R.quantizePaintballSpread(Math.round(spread * 1000) / 1000), spread, "wire round-trip stable");
    const a = R.paintballBallDirection(client, spread, 987654, { x: 0, y: 0, z: 0 });
    const b = R.paintballBallDirection(srv, spread, 987654, { x: 0, y: 0, z: 0 });
    assert.deepEqual(a, b, "bit-identical");
  });

  await test("profile = JSON (clips, mounts, mask) and shared timeline = JSON actions", () => {
    const prof = PROF.PaintballRifleProfile;
    assert.equal(prof.id, "PaintballRifle");
    assert.deepEqual(prof.fpMount, profileJson.mounts.fp.matrixColumnMajor);
    assert.deepEqual(prof.tpMount, profileJson.mounts.tp.matrixColumnMajor);
    assert.ok(prof.upperBodyMask.includes("Spine_1") && prof.upperBodyMask.includes("Weapon_R"));
    const a = profileJson.actions;
    assert.equal(a.fire.interval, P.fireInterval);
    assert.equal(a.reload.events.hopperSeat, P.timeline.reloadAmmoRefilled);
    assert.equal(a.reload.events.readyToFire, P.timeline.reloadReady);
    assert.equal(a.reload.duration, P.timeline.reloadDuration);
    assert.equal(profileJson.paintball.capacity, P.capacity);
    assert.equal(prof.fpActions.fire.loop, true, "FP fire loops");
    assert.equal(prof.tpClips.actions.fire.loop, true, "TP fire loops");
    assert.equal(PROF.PAINTBALL_TP_AIM_CLIPS.aim, "TP_Aim_PaintballRifle");
  });

  // ---- FP: pack controller on the REAL ViewmodelSystem ----
  const { ViewmodelSystem } = await server.ssrLoadModule("/src/weapons/viewmodel/ViewmodelSystem.ts");
  const weaponGltf = await read(`${project}/src/assets/potato/PaintballRifle_Weapon.glb`);
  const vm = new ViewmodelSystem(16 / 9);
  await vm.ready;
  const events: string[] = [];
  const colors: THREE.Color[] = [];
  const fp = new PaintballRifleController(weaponGltf, {
    firstPerson: true,
    timeline: PROF.PAINTBALL_RIFLE_TIMELINE,
    dropParent: vm.scene,
    events: {
      onShot: (_left: number, c: THREE.Color) => colors.push(c.clone()),
      onDryFire: () => events.push("dry"),
      onBurstStart: () => events.push("burstStart"),
      onBurstEnd: () => events.push("burstEnd"),
      onHopperDrop: () => events.push("drop"),
      onAmmoRefilled: () => events.push("refill"),
      onChargeBack: () => events.push("chargeBack"),
    },
  });
  fp.attachViewmodel(vm);
  // Same prerequisite as PaintballRifleWeapon.load(): derive the straight burst clips.
  const { preparePaintballStraightFire } = await server.ssrLoadModule("/src/weapons/paintball/PaintballStraightFire.ts");
  const SF = PROF.PAINTBALL_STRAIGHT_FIRE;
  await preparePaintballStraightFire(PROF.PaintballRifleProfile.fpPosesUrl, SF.aim, SF.fire, SF.fireEnd);
  await vm.equip(PROF.PaintballRifleProfile, fp.object, { playEquipClip: true });
  const cam = new THREE.PerspectiveCamera(92, 16 / 9, 0.05, 500);
  const motion = { straight: false, running: false, speed: 0, grounded: true, verticalVelocity: 0, jumpSequence: 0 };
  const step = (seconds: number, dt = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      vm.update(dt, motion);
      vm.syncCamera(cam);
      fp.update(dt);
    }
  };

  // Left hand ↔ foregrip, expressed in the WEAPON frame (Hand_L origin = the
  // wrist: the absolute distance is the authored fist offset, not a gap).
  const handInWeapon = () => {
    const w = vm.scene.getObjectByName("Hand_L")!.getWorldPosition(new THREE.Vector3());
    return fp.object.getObjectByName("OffhandSocket")!.worldToLocal(w);
  };
  let holdHand = new THREE.Vector3();

  await test("FP: Equip clip on equip, then Hold; left hand on the foregrip", () => {
    assert.equal(vm.presentationClock().clip, "FP_Equip_PaintballRifle");
    step(1);
    assert.equal(vm.presentationClock().clip, "FP_PaintballRifle_Hold");
    holdHand = handInWeapon();
    step(0.7);
    const drift = handInWeapon().sub(holdHand).length() * fp.object.getObjectByName("OffhandSocket")!.getWorldScale(new THREE.Vector3()).x;
    console.log(`    left hand drift on the foregrip during Hold: ${(drift * 1000).toFixed(1)} mm`);
    assert.ok(drift < 0.005, "the left hand stays on the foregrip");
  });

  // Muzzle off the camera axis (deg): the gun barrel = weapon −X.
  const aimErr = () => {
    const q = fp.muzzle.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    const c = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return THREE.MathUtils.radToDeg(f.angleTo(c));
  };

  await test("FP: automatic burst at 600 rpm — gun STRAIGHT like ADS, fire loop, hopper drains, FireEnd back to Hold", () => {
    assert.equal(fp.hopper.ballCount, 32);
    const holdErr = aimErr();
    motion.straight = true;
    step(0.6);
    const adsErr = aimErr();
    motion.straight = false;
    step(0.6);
    let shots = 0;
    const errs: number[] = [];
    for (let f = 0; f < 60; f++) { // 1 s trigger held
      if (fp.canFire) { fp.fire(); shots++; }
      step(1 / 60);
      errs.push(aimErr());
    }
    const tail = errs.slice(6);
    const firing = Math.max(...tail);
    const firingAvg = tail.reduce((s, e) => s + e, 0) / tail.length;
    console.log(`    muzzle off-axis: hold ${holdErr.toFixed(1)}°, ADS ${adsErr.toFixed(1)}°, firing avg ${firingAvg.toFixed(1)}° / peak ${firing.toFixed(1)}° (recoil kick)`);
    assert.equal(vm.presentationClock().clip, "FP_Fire_PaintballRifle_Straight", "straight burst clip");
    assert.ok(firing < 3, "straight while firing like ADS (only the authored recoil kick on top)");
    assert.ok(firing < holdErr / 3, "far straighter than the hold pose");
    // Left hand stays on the foregrip in the straight burst (Aim-pose grip).
    motion.straight = true;
    step(0.6);
    const aimHand = handInWeapon();
    motion.straight = false;
    const scale = fp.object.getObjectByName("OffhandSocket")!.getWorldScale(new THREE.Vector3()).x;
    let maxDrift = 0;
    for (let f = 0; f < 30; f++) {
      if (fp.canFire) { fp.fire(); shots++; }
      step(1 / 60);
      maxDrift = Math.max(maxDrift, handInWeapon().sub(aimHand).length() * scale);
    }
    console.log(`    left hand drift on the foregrip while firing: ${(maxDrift * 1000).toFixed(1)} mm`);
    assert.ok(maxDrift < 0.01, "the left hand stays on the foregrip while firing");
    shots = 32 - fp.ammo;
    assert.ok(shots >= 13 && shots <= 16, `≈ 10 balls / s (${shots} in 1.5 s)`);
    assert.equal(vm.activeActionKey, "fire", "arms fire LOOP during the burst");
    assert.equal(events.filter((e) => e === "burstStart").length, 2, "one burst start per burst");
    step(0.1);
    assert.equal(fp.hopper.ballCount, 32 - shots, "balls sucked in one by one");
    step(0.1); // > 0.16 s without a ball
    assert.ok(events.includes("burstEnd"), "burst end after the release");
    assert.equal(vm.activeActionKey, "fireEnd", "FP_FireEnd plays");
    assert.equal(vm.presentationClock().clip, "FP_FireEnd_PaintballRifle_Straight");
    step(0.5);
    assert.ok(Math.abs(aimErr() - holdErr) < 2, "FireEnd lowers the gun back to the hold pose");
    assert.ok(new Set(colors.map((c) => c.getHexString())).size >= 2, "balls of several colours");
  });


  await test("FP: empty → dry fire; hopper swap: drop 0.78, ammo at 1.52, charging handle, fire again at 2.10", () => {
    while (fp.ammo > 0) { if (fp.canFire) fp.fire(); step(1 / 60); }
    step(0.5);
    assert.ok(!fp.fire() && events.includes("dry"), "dry fire when empty");
    assert.ok(fp.reload());
    step(0.8);
    assert.ok(events.includes("drop"), "empty hopper dropped");
    let dropped = 0;
    vm.scene.traverse((o: THREE.Object3D) => { if (o.name === "DroppedHopper") dropped++; });
    assert.equal(dropped, 1, "one cosmetic dropped copy in the FP scene");
    step(0.66);
    assert.equal(fp.ammo, 0, "ammo not counted before 1.52 s");
    step(0.08);
    assert.equal(fp.ammo, 32, "32 at the click");
    assert.ok(!fp.canFire, "not before 2.10 s");
    step(0.5); // t ≈ 2.04 s
    assert.ok(events.includes("chargeBack"), "charging handle");
    assert.ok(!fp.canFire, "still refused at 2.04 s");
    step(0.1); // t ≈ 2.14 s
    assert.ok(fp.canFire, "fire again from 2.10 s");
    step(0.5);
  });

  await test("FP: weapon switch before 1.52 s cancels the swap (ammo unchanged), after = full", () => {
    for (let i = 0; i < 5; i++) { while (!fp.canFire) step(1 / 60); fp.fire(); }
    step(0.5);
    const before = fp.ammo;
    fp.reload();
    step(1.0);
    fp.cancelReload();
    assert.equal(fp.ammo, before, "cancel before the click keeps the ammo");
    assert.equal(fp.hopper.ballCount, before, "hopper restored");
    fp.reload();
    step(1.6);
    fp.cancelReload();
    assert.equal(fp.ammo, 32, "cancel after the click keeps the full hopper");
  });

  // ---- TP: pose set on the REAL character + remote controller ----
  const { loadCharacterAsset } = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
  const { RemotePlayerAnimationController } = await server.ssrLoadModule("/src/network/remote/RemotePlayerAnimationController.ts");
  const asset = await loadCharacterAsset();

  await test("TP: PaintballRifle pose set built (hold / run / masked jump-dash-slide / layered fire LOOP, fireEnd, reload)", () => {
    const set = asset.clips.profiles?.PaintballRifle;
    assert.ok(set, "profile set 'PaintballRifle'");
    const mask = new Set<string>(PROF.PaintballRifleProfile.upperBodyMask);
    const bone = (n: string) => n.slice(0, n.lastIndexOf("."));
    for (const k of ["fire", "fireEnd", "reload"]) {
      assert.ok(set.actions[k]?.layered, `${k} is a layer over the legs`);
      assert.ok(set.actions[k].clip.tracks.every((t: THREE.KeyframeTrack) => mask.has(bone(t.name))), `${k} only drives the mask`);
    }
    assert.equal(set.actions.fire.loop, true, "fire loops");
    assert.ok(Math.abs(set.actions.reload.clip.duration - 2.45) < 0.03, "reload 2.45 s");
    const holdBones = new Set(set.hold.tracks.map((t: THREE.KeyframeTrack) => bone(t.name)));
    for (const t of asset.clips.idle.tracks) assert.ok(holdBones.has(bone(t.name)), `hold covers ${t.name}`);
    assert.ok(set.lowerBody, "lower-body variants for the layered actions");
  });

  await test("TP: remote controller on Weapon_R — burst events drive the TP loop / fireEnd, reload refills, barrel level", () => {
    const model = clone(asset.template);
    const anim = new RemotePlayerAnimationController(model, -0.9, asset.clips);
    anim.setArmedProfile("PaintballRifle");
    assert.equal(anim.armedProfileId, "PaintballRifle");
    const world = new THREE.Scene();
    const tpEvents: string[] = [];
    const remote = new PaintballRifleController(weaponGltf, {
      firstPerson: false,
      timeline: PROF.PAINTBALL_RIFLE_TIMELINE,
      dropParent: world,
      groundY: () => 0,
      events: {
        onBurstStart: () => { tpEvents.push("start"); anim.playOverride("fire", { fadeIn: 0.03 }); },
        onBurstEnd: () => { tpEvents.push("end"); anim.playOverride("fireEnd", { fadeIn: 0.04 }); },
      },
    });
    const mount = new THREE.Group();
    mount.matrix.fromArray(PROF.PaintballRifleProfile.tpMount);
    mount.matrixAutoUpdate = false;
    model.getObjectByName("Weapon_R")!.add(mount);
    mount.add(remote.object);
    for (let i = 0; i < 6; i++) { remote.playRemote("fire"); anim.update(0.1, 0, 0, 0, 0, 0); remote.update(0.1); }
    assert.deepEqual(tpEvents, ["start"], "one TP loop for the whole burst");
    assert.equal(anim.presentationClock().clip, "TP_Fire_PaintballRifle_Layer");
    remote.update(0.2);
    assert.deepEqual(tpEvents, ["start", "end"], "TP FireEnd after the last ball");
    assert.equal(remote.ammo, 26);
    remote.playRemote("reload");
    for (let i = 0; i < 160; i++) remote.update(1 / 60);
    assert.equal(remote.ammo, 32, "remote swap refills on the clock");
    let dropped = 0;
    world.traverse((o) => { if (o.name === "DroppedHopper") dropped++; });
    assert.ok(dropped <= 1, "dropped TP hopper in the world (or already faded)");
    anim.clearOverride(0);
    for (let i = 0; i < 30; i++) anim.update(1 / 30, 0, 0, 0, 0, 0);
    model.updateMatrixWorld(true);
    const q = remote.muzzle.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    assert.ok(Math.abs(fwd.y) < 0.2, `barrel level in TP hold (y=${fwd.y.toFixed(3)})`);
    remote.dispose();
  });


  // ---- Visuals: one PaintballFX (balls + splats + character paint) ----
  const worldScene = new THREE.Scene();
  const fx = new PaintballFX(worldScene);
  fx.init(weaponGltf);
  const viewer = new THREE.Vector3(0, 0, 0);
  const ballAt = (k: number) => {
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    fx.projectiles!.mesh.getMatrixAt(k, m);
    m.decompose(p, q, s);
    return { p, q, r: s.x };
  };

  await test("flying ball == hopper ball: Ball_Template geometry, hopper material, EXACT palette colour, no halo, tumbling", () => {
    const balls = fx.projectiles!;
    assert.ok(balls, "ball pool built");
    const tpl = weaponGltf.scene.getObjectByName("Ball_Template") as THREE.Mesh;
    assert.equal(balls.mesh.geometry, tpl.geometry, "same faceted sphere as the hopper");
    const mat = balls.mesh.material as THREE.MeshStandardMaterial;
    const hopperMat = tpl.material as THREE.MeshStandardMaterial;
    assert.ok(Math.abs(mat.roughness - hopperMat.roughness) < 1e-6, `roughness ${mat.roughness} == hopper ${hopperMat.roughness}`);
    assert.equal(mat.metalness, hopperMat.metalness);
    assert.equal(balls.halo, null, "no energy halo by default");
    balls.clear();
    const teal = fx.colorOf(2, new THREE.Color());
    const red = fx.colorOf(0, new THREE.Color());
    fx.spawn(new THREE.Vector3(0.3, -0.2, -0.6), new THREE.Vector3(0.3, -0.2, -30), teal, null);
    fx.spawn(new THREE.Vector3(0.3, -0.2, -0.6), new THREE.Vector3(0.3, -0.2, -30), red, null);
    fx.update(0, viewer);
    const c0 = new THREE.Color(), c1 = new THREE.Color();
    balls.mesh.getColorAt(0, c0);
    balls.mesh.getColorAt(1, c1);
    for (const [got, want] of [[c0, teal], [c1, red]] as const) {
      assert.ok(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b) < 1e-5, "exact hopper colour (no flash boost)");
    }
    const q0 = ballAt(0).q.clone(), q1 = ballAt(1).q.clone();
    assert.ok(Math.abs(q0.dot(q1)) < 0.9999, "each ball has its own random orientation");
    fx.update(1 / 60, viewer);
    assert.ok(Math.abs(ballAt(0).q.dot(q0)) < 0.9999, "the ball tumbles in flight");
    balls.clear();
  });

  await test("exit is SEEN and straight: frame 0 at the muzzle, 2nd frame < 2 m, ≥ 4 frames, lands ≤ 6 frames, on the ray", () => {
    const balls = fx.projectiles!;
    balls.clear();
    const from = new THREE.Vector3(0.3, -0.2, -0.6), to = new THREE.Vector3(0.3, -0.2, -20.6);
    const hit = { normal: new THREE.Vector3(0, 0, 1), seed: 7 };
    fx.spawn(from, to, new THREE.Color(1, 0, 0), hit);
    const dists: number[] = [];
    const n0 = fx.splats.surfaceCount;
    fx.update(0, viewer);
    for (let f = 0; f < 12 && balls.mesh.count > 0; f++) {
      const { p } = ballAt(0);
      const off = new THREE.Vector3().subVectors(p, from);
      const along = off.z / (to.z - from.z) * from.distanceTo(to);
      const perp = Math.hypot(off.x, off.y);
      if (fx.splats.surfaceCount === n0) {
        assert.ok(perp < 1e-4, `straight on the fired ray (frame ${f}: ${perp})`);
        dists.push(along);
      }
      fx.update(1 / 60, viewer);
    }
    console.log(`    20 m shot, ball along the ray per frame: ${dists.map((d) => d.toFixed(2)).join(" → ")}`);
    assert.ok(dists[0] < 0.1, "frame 0 at the muzzle");
    assert.ok(dists[1] > dists[0] && dists[1] < 2, "2nd frame just out of the barrel");
    assert.ok(dists.length >= 4, `seen ≥ 4 frames (${dists.length})`);
    assert.ok(dists.length <= 6, "lands in ≤ 6 frames");
    for (let k = 1; k < dists.length; k++) assert.ok(dists[k] > dists[k - 1], "always forward");
    assert.ok(fx.splats.surfaceCount > n0, "splat on arrival");
    fx.clearAll();
  });

  await test("trail: short, faint, lighter ball colour, never longer than the path flown", () => {
    const balls = fx.projectiles!;
    balls.clear();
    const from = new THREE.Vector3(0.3, -0.2, -0.6), to = new THREE.Vector3(0.3, -0.2, -30.6);
    const col = fx.colorOf(1, new THREE.Color());
    fx.spawn(from, to, col, null);
    fx.update(0, viewer);
    assert.equal(balls.trail!.count, 0, "no trail at the muzzle (nothing flown yet)");
    let seen = 0;
    for (let f = 0; f < 5; f++) {
      fx.update(1 / 60, viewer);
      if (balls.trail!.count === 0) continue;
      seen++;
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      balls.trail!.getMatrixAt(0, m);
      m.decompose(p, q, s);
      assert.ok(s.z <= p.distanceTo(from) + 1e-4, "never pokes back into the gun");
      assert.ok(s.x < ballAt(0).r, "thinner than the ball");
      const tc = new THREE.Color();
      balls.trail!.getColorAt(0, tc);
      assert.ok(tc.r >= col.r && tc.g >= col.g && tc.b >= col.b && tc.b > col.b, "ball colour, lifted toward white");
    }
    assert.ok(seen >= 1, "trail visible in flight");
    assert.ok((balls.trail!.material as THREE.Material).opacity <= 0.5, "faint");
    balls.clear();
  });

  await test("glued to the gun while strafing (2 frames on the live muzzle), then on the fired ray", () => {
    const balls = fx.projectiles!;
    balls.clear();
    const muzzle = new THREE.Vector3(0.3, -0.2, -0.6);
    const from = muzzle.clone(), to = new THREE.Vector3(0.3, -0.2, -40.6);
    fx.spawn(from, to, new THREE.Color(0, 1, 0), null, (out) => { out.copy(muzzle); return true; });
    // Distance of the ball to the line start → impact.
    const offLine = (start: THREE.Vector3) =>
      new THREE.Line3(start, to).closestPointToPoint(ballAt(0).p, false, new THREE.Vector3()).distanceTo(ballAt(0).p);
    fx.update(0, viewer);
    muzzle.x += 0.25; // strafe during the frame
    fx.update(1 / 60, viewer);
    const glued = muzzle.clone();
    assert.ok(offLine(glued) < 1e-4, "on the line LIVE muzzle → impact");
    assert.ok(offLine(from) > 0.1, "not left behind on the old muzzle line");
    muzzle.x += 0.25;
    fx.update(1 / 60, viewer);
    assert.ok(offLine(glued) < 1e-4, "then flies the fired ray (anchor released)");
    assert.ok(offLine(muzzle) > 1e-3, "no longer follows the muzzle");
    balls.clear();
  });

  await test("splats: seeded (same shape everywhere), merged under sustained fire, cleared only by clearAll()", () => {
    const n0 = fx.splats.surfaceCount;
    const c = new THREE.Color(1, 0, 0);
    for (let i = 0; i < 60; i++) {
      fx.splats.splatSurface(new THREE.Vector3(5 + (i % 5) * 0.01, 1, -3), new THREE.Vector3(0, 0, 1), c, undefined, 1000 + i);
    }
    const added = fx.splats.surfaceCount - n0;
    console.log(`    60 balls on the same spot → ${added} instance(s)`);
    // 3× splat: the quad of the first splat is ~0.96 m wide.
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    fx.splats.surfaceMesh.getMatrixAt(0, m);
    m.decompose(p, q, s);
    console.log(`    splat size ≈ ${Math.max(s.x, s.y).toFixed(2)} m`);
    assert.ok(Math.max(s.x, s.y) > 0.6, "3× the pack splat (0.96 m base)");
    assert.ok(added <= 8, "merged (no quad pile-up)");
    fx.clearAll();
    assert.equal(fx.splats.surfaceCount, 0);
    assert.equal(worldScene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh).length, 3, "+3 draw calls total (balls, trails, splats — no halo by default)");
  });

  await test("character paint: visual raycast on the posed Potato body, per-vertex paint, cleared at death, detach restores", () => {
    const model = clone(asset.template);
    const anim = new RemotePlayerAnimationController(model, -0.9, asset.clips);
    anim.update(0.1, 0, 0, 0, 0, 0);
    const root = new THREE.Group();
    root.add(model);
    root.position.set(0, 0.9, -6);
    worldScene.add(root);
    worldScene.updateMatrixWorld(true);
    const body = model.getObjectByProperty("name", "Potato") as THREE.SkinnedMesh;
    const origGeo = body.geometry;
    const origMat = body.material;
    const origin = new THREE.Vector3(0, 1.4, 0);
    const dir = new THREE.Vector3(0, 0.9, -6).sub(origin).normalize();
    const hit = fx.characterHit(root, origin, dir, new THREE.Vector3(0, 0.9, -6));
    assert.ok(hit && hit.mesh === body && hit.faceIndex !== undefined, "face + barycentric on the body mesh");
    assert.ok(body.geometry.getAttribute("paint"), "per-player paint attribute");
    assert.equal(body.geometry.getAttribute("position"), origGeo.getAttribute("position"), "other attributes SHARED");
    fx.spawn(origin, new THREE.Vector3(0, 0.9, -6), new THREE.Color(0, 1, 0), hit);
    for (let i = 0; i < 30; i++) fx.update(1 / 60);
    const paint = body.geometry.getAttribute("paint") as THREE.BufferAttribute;
    let painted = 0;
    for (let i = 0; i < paint.count; i++) if (paint.getW(i) > 0.1) painted++;
    console.log(`    painted vertices: ${painted} / ${paint.count}`);
    assert.ok(painted > 0 && painted < paint.count / 4, "a local splat on the body");
    fx.clearPaintUnder(model);
    let left = 0;
    for (let i = 0; i < paint.count; i++) if (paint.getW(i) > 0) left++;
    assert.equal(left, 0, "death: all the paint is gone");
    fx.detachUnder(model);
    assert.equal(body.geometry, origGeo, "detach: original geometry back");
    assert.equal(body.material, origMat, "detach: original material back");
    anim.dispose();
  });

  await test("files in place: pack GLBs, TP character kept, profile imports like HexSniperProfile", () => {
    for (const f of ["PaintballRifle_Weapon.glb", "PaintballRifle_FP_Poses.glb", "PaintballRifle_TP_Poses.glb", "WeaponProfile_PaintballRifle.json"]) {
      assert.ok(fs.existsSync(`${project}/src/assets/potato/${f}`), f);
    }
    const src = fs.readFileSync(`${project}/src/weapons/profiles/PaintballRifleProfile.ts`, "utf8");
    assert.ok(/\.\.\/\.\.\/assets\/potato\/PaintballRifle_Weapon\.glb\?url/.test(src));
    const b = fs.readFileSync(`${project}/src/assets/potato/Potato_TP_Character.glb`);
    assert.equal(b.length, 779132, "the corrected Popcorn Shotgun TP character stays");
  });

  console.log(`\n${passed} paintball rifle tests passed`);
} finally {
  await server.close();
}

