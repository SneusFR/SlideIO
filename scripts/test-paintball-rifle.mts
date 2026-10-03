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

  await test("shared rules == pack reference PaintballSpread (damage, capacity, bloom, ball direction); NO max range", async () => {
    assert.equal(P.bodyDamage, REF.DAMAGE_BODY);
    assert.equal(P.headMultiplier, REF.HEADSHOT_MULTIPLIER);
    assert.equal(R.paintballDamage(false), 12);
    assert.equal(R.paintballDamage(true), 18);
    // Deliberate difference with the pack (45 m): no weapon range — the ray
    // is longer than the 3D diagonal of EVERY map (walls / bounds stop it).
    const { MAP_REGISTRY } = await server.ssrLoadModule("/shared/map/MapRegistry.ts");
    for (const def of Object.values(MAP_REGISTRY) as { name: string; colliderBoxes: number[][] }[]) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const b of def.colliderBoxes) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], b[k] - b[k + 3] / 2);
          hi[k] = Math.max(hi[k], b[k] + b[k + 3] / 2);
        }
      }
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      console.log(`    ${def.name}: diagonal ${diag.toFixed(0)} m < ray ${P.maxRange} m`);
      assert.ok(P.maxRange > diag, `${def.name}: the ball crosses the whole map`);
    }
    assert.equal(P.capacity, REF.CAPACITY);
    assert.equal(P.fireInterval, REF.FIRE_INTERVAL);
    // Deliberate difference with the pack (0.35 → 2.2° bloom): NO spread.
    assert.equal(P.spreadMinDeg, 0);
    assert.equal(P.spreadMaxDeg, 0);
    assert.equal(P.bloomPerShotDeg, 0);
    assert.equal(R.PAINTBALL_MIN_SPREAD_DEG, 0);
    // The cone MATH stays identical to the pack (same PRNG / draw order) for
    // any cone — checked on the pack's own cones.
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
    // NO spread: a long burst keeps a 0° cone, every ball = the crosshair axis.
    const bloom = new R.PaintballBloomState();
    const fwd = new THREE.Vector3(0.3, -0.2, -1).normalize();
    for (let i = 0; i < 40; i++) {
      const spread = R.quantizePaintballSpread(bloom.spreadDeg);
      assert.equal(spread, 0, `ball ${i}: 0° cone`);
      const d = R.paintballBallDirection(fwd, spread, 1000 + i * 7919, { x: 0, y: 0, z: 0 });
      assert.ok(Math.abs(d.x - fwd.x) < 1e-12 && Math.abs(d.y - fwd.y) < 1e-12 && Math.abs(d.z - fwd.z) < 1e-12, `ball ${i} exactly on the crosshair`);
      bloom.onShot();
      bloom.update(1 / 144, false);
    }
    // Any received cone (modified client) is clamped to 0 by the server rule.
    for (const raw of [0.35, 2.2, 50, -3, NaN, "x"]) assert.equal(R.quantizePaintballSpread(raw), 0);
  });

  await test("same seed + aim + spread → identical ball on the shooter and the server (wire rounding)", () => {
    const raw = new THREE.Vector3(0.123456, -0.2345678, -0.9876543).normalize();
    const client = R.paintballAimDirection(raw);
    const wx = Math.round(raw.x * 1000) / 1000, wy = Math.round(raw.y * 1000) / 1000, wz = Math.round(raw.z * 1000) / 1000;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const srv = { x: wx / l, y: wy / l, z: wz / l }; // backend normalize()
    const spread = R.quantizePaintballSpread(1.23456789);
    assert.equal(spread, 0, "no spread: every cone clamps to 0°");
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
  /** Jets currently drawn (one instance each): ray start / dir, physical head / tail (m along the ray), radius, drawn state. */
  const segs = () => {
    const jets = fx.projectiles!;
    const out: { start: THREE.Vector3; dir: THREE.Vector3; tail: number; head: number; len: number; r: number; drawR: number; drawLen: number; headW: THREE.Vector3; tailW: THREE.Vector3; draining: boolean }[] = [];
    for (let k = 0; k < jets.mesh.count; k++) {
      const s = jets.sampleInstance(k)!;
      out.push({ start: s.start, dir: s.dir, tail: s.head - s.len, head: s.head, len: s.len, r: s.radius, drawR: s.drawRadius, drawLen: s.drawLength, headW: s.headWorld, tailW: s.tailWorld, draining: s.draining });
    }
    return out;
  };
  const same = (x: THREE.Color, y: THREE.Color) => Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) < 1e-5;

  await test("paint jet: EXACT palette colour (one per shot), wet paint material, ONE instance of ONE shared geometry per jet", () => {
    const jets = fx.projectiles!;
    assert.ok(jets, "jet pool built");
    jets.clear();
    const teal = fx.colorOf(2, new THREE.Color());
    const red = fx.colorOf(0, new THREE.Color());
    const geo = jets.mesh.geometry, mat = jets.mesh.material;
    fx.spawn(new THREE.Vector3(0.3, -0.2, -0.6), new THREE.Vector3(0.3, -0.2, -30), teal, null);
    fx.update(0, viewer);
    fx.update(1 / 60, viewer);
    assert.equal(jets.mesh.count, 1, "one jet = one instance (no chain of segments)");
    const c = new THREE.Color();
    jets.mesh.getColorAt(0, c);
    assert.ok(same(c, teal), "exact hopper colour (no flash boost)");
    fx.spawn(new THREE.Vector3(0.3, -0.2, -0.6), new THREE.Vector3(0.3, -0.2, -30), red, null);
    fx.update(0, viewer);
    assert.equal(jets.mesh.count, 2, "two jets = two instances");
    let reds = 0;
    for (let k = 0; k < jets.mesh.count; k++) { jets.mesh.getColorAt(k, c); if (same(c, red)) reds++; }
    assert.equal(reds, 1, "each jet keeps its own ball colour");
    assert.ok(jets.mesh.geometry === geo && jets.mesh.material === mat, "geometry + material shared and reused (never rebuilt per shot)");
    const pos = geo.getAttribute("position");
    assert.ok(pos.count <= 400, `light shared geometry (${pos.count} vertices)`);
    const m = mat as THREE.MeshStandardMaterial;
    assert.ok(m.roughness <= 0.5 && m.metalness === 0, "slightly glossy paint, not metal");
    assert.ok(!m.transparent, "opaque liquid (no transparent sorting)");
    assert.equal(m.map, null, "procedural paint texture (no image asset)");
    jets.clear();
  });

  await test("palette = pink / blue / yellow (one source), jet speed is a visible burst speed, flight time bounded", async () => {
    const jets = fx.projectiles!;
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    assert.equal(S.PAINT_COLORS_SRGB.length, 3, "three paint colours");
    const want = S.PAINT_COLORS_SRGB.map((hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace));
    for (let i = 0; i < 3; i++) assert.ok(same(fx.colorOf(i, new THREE.Color()), want[i]), `fx palette ${i}`);
    assert.ok(fx.colorOf(0, new THREE.Color()).r > 0.9 && fx.colorOf(1, new THREE.Color()).b > 0.9 && fx.colorOf(2, new THREE.Color()).g > 0.6, "pink / blue / yellow");
    assert.equal(fx.indexOf(want[1]), 1, "wire index round-trips");
    // The loader patches the hopper palette: balls in the hopper, shot colour and jet all agree.
    const { loadPaintballRifleGltf } = await server.ssrLoadModule("/src/weapons/paintball/PaintballRifleModel.ts");
    const gl = await loadPaintballRifleGltf();
    const pal = gl.scene.getObjectByName("Hopper").userData.palette as number[][];
    for (let i = 0; i < 3; i++) assert.ok(same(new THREE.Color(pal[i][0], pal[i][1], pal[i][2]), want[i]), `hopper palette ${i} patched`);
    assert.ok(jets.speed >= 60 && jets.speed <= 140, `jet head speed ${jets.speed} m/s: leaves gaps in a 10 shots/s burst`);
    assert.ok(jets.speed / 10 >= 6, "≥ 6 m between two jets of a 600 rpm burst");
    assert.ok(Math.abs(jets.flightTime(19) - 19 / jets.speed) < 1e-12, "19 m at jet speed");
    assert.ok(jets.flightTime(1000) <= 0.35 + 1e-12, "far shot bounded");
    assert.ok(Math.abs(jets.flightTime(1) - 2 / 60) < 1e-12, "point blank: ≥ 2 frames (exit still seen)");
  });
  /** Per-frame samples of the first jet on screen: body length, head, tail, physical nose radius. */
  const sampleJet = (to: THREE.Vector3, fps: number, frames: number, spawned = 100) => {
    const jets = fx.projectiles!;
    jets.clear();
    fx.clearAll();
    (jets as unknown as { spawned: number }).spawned = spawned; // same per-jet irregularity every run
    const from = new THREE.Vector3(0.3, 1, -0.6);
    fx.spawn(from, to, new THREE.Color(1, 0, 1), { normal: new THREE.Vector3(0, 0, 1), seed: 77 });
    fx.update(0, viewer);
    const out: { t: number; len: number; head: number; tail: number; r: number }[] = [];
    for (let f = 0; f <= frames; f++) {
      const c = segs();
      // In flight only (once the nose hits, the body drains into the impact: tested apart).
      if (c.length && !c[0].draining) out.push({ t: f / fps, len: c[0].len, head: c[0].head, tail: c[0].tail, r: c[0].r });
      if (f < frames) fx.update(1 / fps, viewer);
    }
    return out;
  };

  await test("BORN STRETCHED, STAYS A LONG JET: 8-12× longer than thick from frame 0 to the impact (never a ball), one slight soft relaxation, then a light elastic breathing (no rigid spike, no jitter)", async () => {
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    const K = S.PAINT_JET;
    const s = sampleJet(new THREE.Vector3(0.3, 1, -60.6), 240, 150); // 60 m: the whole flight (maxFlight 0.35 s = 84 frames)
    const l0 = s[0].len;
    const ratio = (x: { len: number; r: number }) => x.len / (2 * x.r);
    console.log(`    length: ${s.filter((_, i) => i % 12 === 0).map((x) => x.len.toFixed(2)).join(" → ")} m; length / thickness: ${s.filter((_, i) => i % 12 === 0).map((x) => ratio(x).toFixed(1)).join(" → ")}`);
    assert.ok(s.length >= Math.floor(K.maxFlight * 240) - 1, `sampled over the whole flight up to the impact (${s.length} frames)`);
    assert.ok(s[0].tail < 1e-6, "frame 0: the tail sits at the nozzle");
    assert.ok(Math.abs(l0 - K.launchLength) < 1e-6, `frame 0 is already the long jet (${l0.toFixed(2)} m)`);
    for (const x of s) assert.ok(ratio(x) >= 8 - 1e-6 && ratio(x) <= 12 + 1e-6, `length / thickness ${ratio(x).toFixed(2)} at ${(x.t * 1000).toFixed(0)} ms: within 8-12, never a ball`);
    // Launch relaxation: one soft, monotonic contraction during the first frames (readable at normal speed).
    const early = s.filter((x) => x.t <= 0.05);
    for (let i = 1; i < early.length; i++) assert.ok(early[i].len <= early[i - 1].len + 1e-4, "the launch relaxation is monotonic");
    const minLen = Math.min(...s.map((x) => x.len));
    assert.ok(minLen >= K.minLength - 1e-6 && minLen > l0 * 0.75, `only a slight relaxation, the shape is kept (${l0.toFixed(2)} → ${minLen.toFixed(2)} m)`);
    assert.ok(early[early.length - 1].len < l0 - 0.05, "it visibly relaxes a little after the launch");
    // In flight it keeps BREATHING (stretches / thins slightly): elastic, not a rigid spike...
    const cruise = s.filter((x) => x.t >= 0.1);
    const cLo = Math.min(...cruise.map((x) => x.len)), cHi = Math.max(...cruise.map((x) => x.len));
    const rLo = Math.min(...cruise.map((x) => x.r)), rHi = Math.max(...cruise.map((x) => x.r));
    let turns = 0, dir = 0, maxStep = 0;
    for (let i = 1; i < cruise.length; i++) {
      const d = cruise[i].len - cruise[i - 1].len;
      maxStep = Math.max(maxStep, Math.abs(d));
      if (Math.abs(d) < 1e-5) continue;
      const sg = Math.sign(d);
      if (dir !== 0 && sg !== dir) turns++;
      dir = sg;
    }
    console.log(`    in flight: length ${cLo.toFixed(3)}…${cHi.toFixed(3)} m (±${((50 * (cHi - cLo)) / cLo).toFixed(1)} %), radius ${(rLo * 1000).toFixed(1)}…${(rHi * 1000).toFixed(1)} mm, ${turns} direction change(s) in ${((cruise[cruise.length - 1].t - cruise[0].t) * 1000).toFixed(0)} ms`);
    assert.ok(cHi - cLo >= 0.03, `still elastic in flight: the body stretches / relaxes a little (${((cHi - cLo) * 100).toFixed(1)} cm)`);
    assert.ok(rHi - rLo >= 0.0005, "and thins / thickens with it (volume kept)");
    // ...but slight and smooth: the silhouette stays long (8-12 checked above), no jitter.
    assert.ok((cHi - cLo) / cLo <= 0.15, "slight: the silhouette keeps its length");
    assert.ok(turns >= 1 && turns <= 6, `a slow breathing, not a jitter (${turns} direction changes)`);
    // One fixed sub-step (1/180 s) per drawn frame at most: the length moves ≤ 1.5 % of itself per frame.
    assert.ok(maxStep <= 0.015 * cLo, `smooth from frame to frame (max ${(maxStep * 1000).toFixed(1)} mm per 1/180 s step)`);
  });

  await test("volume conserved while it relaxes (r² · L ≈ constant), thinner when stretched, a bit thicker when relaxed", () => {
    const s = sampleJet(new THREE.Vector3(0.3, 1, -60.6), 240, 36);
    const vols = s.map((x) => x.r * x.r * x.len);
    const lo = Math.min(...vols), hi = Math.max(...vols);
    console.log(`    r² · L from ${lo.toFixed(5)} to ${hi.toFixed(5)} (ratio ${(hi / lo).toFixed(2)}); r ${s[0].r.toFixed(3)} → ${s[s.length - 1].r.toFixed(3)} m`);
    assert.ok(hi / lo < 1.35, "volume ≈ conserved (±15 %)");
    assert.ok(s[0].r < s[s.length - 1].r, "stretched at birth = thinner than once relaxed");
  });

  await test("FPS READABILITY: from the shooter's camera the jet reads as a long streak on screen during its whole flight, on the muzzle → crosshair line, never past the muzzle", () => {
    const jets = fx.projectiles!;
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 500);
    cam.position.set(0, 1.6, 0);
    cam.lookAt(0, 1.6, -1);
    cam.updateMatrixWorld(true);
    const eye = cam.position.clone();
    const muzzle = new THREE.Vector3(0.22, 1.42, -0.55); // FP muzzle: right, below, in front of the eye
    const H = 1080;
    const px = (p: THREE.Vector3) => { const v = p.clone().project(cam); return new THREE.Vector2(v.x * H * (16 / 9) / 2, v.y * H / 2); };
    const fy = (H / 2) / Math.tan(THREE.MathUtils.degToRad(75 / 2)); // pixels per radian (≈)
    for (const dist of [8, 20, 40]) {
      jets.clear(); fx.clearAll();
      (jets as unknown as { spawned: number }).spawned = 100;
      const impact = new THREE.Vector3(0, 1.6, -dist);
      fx.spawn(muzzle, impact, new THREE.Color(1, 0, 1), { normal: new THREE.Vector3(0, 0, 1), seed: 9 });
      fx.update(0, eye);
      let minAspect = Infinity, frames = 0, minLenPx = Infinity;
      while (jets.activeCount > 0 && frames < 60) {
        const c = segs()[0];
        if (c && !c.draining) {
          const a = px(c.headW), b = px(c.tailW);
          const lenPx = a.distanceTo(b);
          const wPx = 2 * Math.min(c.drawR, c.headW.distanceTo(eye) * 0.04) * fy / c.headW.distanceTo(eye);
          minAspect = Math.min(minAspect, lenPx / wPx);
          minLenPx = Math.min(minLenPx, lenPx);
          // On the screen line muzzle → crosshair (the hitscan line seen by the shooter).
          const m = px(muzzle), t = px(impact);
          const line = t.clone().sub(m).normalize();
          const off = (p: THREE.Vector2) => Math.abs((p.x - m.x) * line.y - (p.y - m.y) * line.x);
          assert.ok(off(a) < 1.5 && off(b) < 1.5, `${dist} m: drawn on the muzzle → crosshair line (${off(a).toFixed(2)} / ${off(b).toFixed(2)} px off)`);
          // The drawn tail never goes back past the muzzle (along the shot).
          assert.ok(c.tailW.clone().sub(muzzle).dot(c.dir) >= -1e-4, `${dist} m: tail never behind the muzzle`);
        }
        fx.update(1 / 60, eye);
        frames++;
      }
      console.log(`    ${dist} m: on-screen length / width ≥ ${minAspect.toFixed(1)}, length ≥ ${minLenPx.toFixed(0)} px over ${frames} frames`);
      assert.ok(frames >= 2, "seen in flight");
      assert.ok(minAspect >= 6, `${dist} m: always a long streak on screen, never a dot (≥ 6:1, got ${minAspect.toFixed(1)})`);
    }
    // Seen from the side, the real geometry is drawn unchanged (no fake stretch).
    jets.clear(); fx.clearAll();
    fx.spawn(new THREE.Vector3(-10, 1.6, -10), new THREE.Vector3(10, 1.6, -10), new THREE.Color(1, 0, 1), null);
    fx.update(0, eye);
    fx.update(1 / 60, eye);
    const side = segs()[0];
    assert.ok(Math.abs(side.drawLen - side.len) < 1e-4 && side.tailW.distanceTo(side.start.clone().addScaledVector(side.dir, side.tail)) < 1e-4, "side view: drawn = the real jet");
    jets.clear(); fx.clearAll();
  });

  type JetPriv = {
    dur: Float32Array; dv: Float32Array; dc: Float32Array; dr: Float32Array; dlife: Float32Array; dage: Float32Array;
    irot: Float32Array; iasp: Float32Array; ic: Float32Array;
  };

  await test("FEWER droplets (≈ 7 per shot, vs ≈ 25-30 estimated before): small, short-lived, same colour; the jet stays dominant", async () => {
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    const K = S.PAINT_JET;
    const jets = fx.projectiles!;
    const P = jets as unknown as JetPriv;
    jets.clear(); fx.clearAll();
    const col = fx.colorOf(1, new THREE.Color());
    const e0 = jets.dropsEmitted;
    fx.spawn(new THREE.Vector3(0.3, 1, -0.6), new THREE.Vector3(0.3, 1, -20.6), col, { normal: new THREE.Vector3(0, 0, 1), seed: 5 });
    fx.update(0, viewer);
    let maxR = 0, maxLife = 0, alive = 0, maxFlightR = 0;
    // Muzzle droplets (in flight, before any impact): tiny and discreet.
    for (let i = 0; i < 1024; i++) if (P.dlife[i] > 0) maxFlightR = Math.max(maxFlightR, P.dr[i]);
    assert.ok(maxFlightR > 0 && maxFlightR <= 0.15 * K.radius, `muzzle droplets are tiny next to the jet (${(maxFlightR * 1000).toFixed(1)} mm)`);
    for (let f = 0; f < 120; f++) {
      fx.update(1 / 240, viewer);
      alive = Math.max(alive, jets.dropCount);
      for (let i = 0; i < 1024; i++) {
        if (P.dlife[i] <= 0) continue;
        maxR = Math.max(maxR, P.dr[i]);
        maxLife = Math.max(maxLife, P.dlife[i]);
        assert.ok(same(new THREE.Color(P.dc[i * 3], P.dc[i * 3 + 1], P.dc[i * 3 + 2]), col), "every droplet has the colour of its shot");
      }
    }
    const per = jets.dropsEmitted - e0;
    console.log(`    ${per} droplets for one shot (≤ ${alive} alive), radius ≤ ${(maxR * 100).toFixed(1)} cm, life ≤ ${maxLife.toFixed(2)} s`);
    assert.ok(per >= 3, "a few droplets remain (muzzle + impact)");
    assert.ok(per <= 10, `about a third of the ≈ 25-30 droplets per shot before (${per})`);
    // Impact splash droplets are unchanged (≤ 2.2 cm by construction = 0.4 × the jet radius).
    assert.ok(maxR <= 0.4 * K.radius + 1e-9, `droplets are small next to the jet (${(maxR * 100).toFixed(2)} cm)`);
    assert.ok(maxLife <= 0.35, "droplets are short-lived");
  });

  await test("IMPACT SQUASH → SPREAD → TRACE: at the real collision the body drains into the surface, the paint slams flat, overshoots + recoils, smears on a slanted hit, and the splat SPREADS out under it (no stamp)", async () => {
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    const K = S.PAINT_JET;
    const jets = fx.projectiles!;
    const P = jets as unknown as JetPriv;
    jets.clear(); fx.clearAll();
    const col = fx.colorOf(0, new THREE.Color());
    fx.spawn(new THREE.Vector3(0.3, 1, -0.6), new THREE.Vector3(0.3, 1, -20.6), col, { normal: new THREE.Vector3(0, 0, 1), seed: 9 });
    const J = jets as unknown as { next: number; maxJets: number };
    const tHit = P.dur[(J.next - 1 + J.maxJets) % J.maxJets]; // the jet just spawned (the ring index survives clear())
    fx.update(0, viewer);
    const dt = 1 / 240;
    let t = 0, hitT = -1, splatT = -1, latOk = false, nSide = 0, splatI = -1, drainEnd = -1;
    const pan: { t: number; w: number; h: number }[] = [];
    const drain: { t: number; len: number; r: number; ratio: number }[] = [];
    const spread: { t: number; s: number }[] = [];
    const SPR = (fx.splats as unknown as { spreads: THREE.InstancedBufferAttribute }).spreads;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const pc = new THREE.Color();
    for (let f = 0; f < 200; f++) {
      fx.update(dt, viewer);
      t += dt;
      // Body draining into the impact: the nose stays ON the surface, the body gets shorter + fatter.
      const c = segs()[0];
      if (c && c.draining) {
        assert.ok(Math.abs(c.head - c.start.distanceTo(new THREE.Vector3(0.3, 1, -20.6))) < 1e-4, "the nose stays on the surface while the body drains");
        drain.push({ t: t - hitT, len: c.len, r: c.r, ratio: c.len / (2 * c.r) });
      } else if (hitT >= 0 && drainEnd < 0) drainEnd = t - hitT;
      if (fx.splats.surfaceCount > 0) {
        if (splatT < 0) { splatT = t; splatI = 0; }
        spread.push({ t: t - hitT, s: SPR.getX(splatI) });
      }
      if (hitT < 0 && jets.impactCount > 0) {
        hitT = t;
        let lat = 0, nor = 0;
        for (let i = 0; i < 1024; i++) {
          if (P.dlife[i] <= 0 || P.dage[i] > 0.01) continue;
          nSide++;
          nor += Math.abs(P.dv[i * 3 + 2]); // surface normal = +Z
          lat += Math.hypot(P.dv[i * 3], P.dv[i * 3 + 1]);
        }
        latOk = nSide >= 3 && nor < 0.6 * lat;
      }
      if (jets.impactCount > 0) {
        const last = jets.drops.count - 1; // pancakes are appended after the droplets
        jets.drops.getMatrixAt(last, m); m.decompose(p, q, s);
        jets.drops.getColorAt(last, pc);
        assert.ok(same(pc, col), "pancake = the colour of the shot");
        pan.push({ t: t - hitT, w: Math.min(s.x, s.y), h: s.z });
      }
    }
    const first = pan[0], end = pan[pan.length - 1];
    const wMax = Math.max(...pan.map((x) => x.w));
    const wMaxAt = pan.find((x) => x.w === wMax)!.t;
    const spreadAt = (ms: number) => spread.filter((x) => x.t <= ms / 1000).pop()?.s ?? 0;
    console.log(`    hit at ${(hitT * 1000).toFixed(0)} ms (expected ${(tHit * 1000).toFixed(0)}); body drains in ${(drainEnd * 1000).toFixed(0)} ms (${drain.length} frames, ${drain[0]?.ratio.toFixed(1)}:1 → ${drain[drain.length - 1]?.ratio.toFixed(1)}:1, r ${(drain[0]?.r * 1000).toFixed(0)} → ${(drain[drain.length - 1]?.r * 1000).toFixed(0)} mm)`);
    console.log(`    pancake ${pan.length} frames: ${(first.w * 100).toFixed(1)}x${(first.h * 100).toFixed(1)} cm → peak ${(wMax * 100).toFixed(1)} cm at ${(wMaxAt * 1000).toFixed(0)} ms → ${(end.w * 100).toFixed(1)}x${(end.h * 100).toFixed(2)} cm; splat at +${((splatT - hitT) * 1000).toFixed(0)} ms, spread ${[30, 60, 100, 150, 220].map((x) => `${x} ms ${spreadAt(x).toFixed(2)}`).join(", ")}; ${nSide} droplets`);
    assert.ok(Math.abs(hitT - tHit) <= 1 / 180 + dt, "the impact starts at the REAL collision time of the hitscan");
    assert.ok(latOk, "droplets are thrown laterally (along the surface), not back at the shooter");
    // 1) the body sinks into the impact: shorter + fatter, quickly, then gone.
    assert.ok(drain.length >= 3, `the body visibly drains into the surface (${drain.length} frames)`);
    for (let i = 1; i < drain.length; i++) assert.ok(drain[i].len <= drain[i - 1].len + 1e-6, "draining: only ever shorter");
    assert.ok(drain[drain.length - 1].r > drain[0].r * 1.15, "draining: it squashes (fatter)");
    assert.ok(drainEnd > 0 && drainEnd <= K.impactDrain + 2 * dt + 1 / 180, `gone after ${(drainEnd * 1000).toFixed(0)} ms (≤ impactDrain)`);
    assert.equal(jets.activeCount, 0, "jet freed after draining");
    // 2) squash: a blob taller than wide SLAMS flat, spreads PAST its size and recoils (elastic, not a scale-up).
    assert.ok(first.h >= 0.5 * first.w, `starts as a thick blob (${(first.h * 100).toFixed(1)} cm tall vs ${(first.w * 100).toFixed(1)} cm wide)`);
    const flat = pan.find((x) => x.t >= K.impactSpread * 0.6)!;
    assert.ok(flat.h < 0.12 * flat.w, `slammed flat against the surface (${(flat.h * 100).toFixed(1)} cm thick vs ${(flat.w * 100).toFixed(0)} cm wide)`);
    const half = pan.find((x) => x.t >= 0.025)!;
    assert.ok(half.w >= 0.6 * wMax, "fast: most of the spread happens in the first 25 ms");
    assert.ok(wMax > 2.5 * first.w, "spreads out wide");
    assert.ok(wMaxAt < K.impactSpread && end.w < wMax * 0.97, `elastic overshoot then recoil (peak at ${(wMaxAt * 1000).toFixed(0)} ms)`);
    assert.ok(end.h < 0.25 * flat.h, "thins and sinks into the trace at the end");
    // 3) trace: the splat appears EARLY, UNDER the pancake, as a small puddle, and spreads out to its shape.
    assert.ok(splatT - hitT >= K.impactSplatAt - dt && splatT - hitT <= K.impactSplatAt + 2 * dt, `the splat appears right after the squash (+${((splatT - hitT) * 1000).toFixed(0)} ms), under the pancake`);
    assert.ok(spread[0].s < 0.1, "it starts as a small puddle, not the full stamp");
    for (let i = 1; i < spread.length; i++) assert.ok(spread[i].s >= spread[i - 1].s - 1e-6, "it only ever spreads");
    assert.ok(spreadAt(60) > 0.3 && spreadAt(60) < 0.95, `still spreading at 60 ms (${spreadAt(60).toFixed(2)})`);
    assert.equal(spread[spread.length - 1].s, 1, "fully spread = the final seeded splat");
    assert.ok(Math.abs(pan[pan.length - 1].t - K.impactLife) <= 2 * dt, "the pancake ends when the splat is spread");
    // The puddle really grows (JS port of the shader mask: covered area at spread 0 / 0.5 / 1).
    const fr = (x: number) => x - Math.floor(x);
    const ss = (e0: number, e1: number, x: number) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
    const seedF = (fx.splats as unknown as { seeds: THREE.InstancedBufferAttribute }).seeds.getX(0);
    const area = (sp: number) => {
      const core = ss(0, 0.5, sp), fing = ss(0.2, 0.85, sp);
      const f1 = 4 + Math.floor(fr(seedF * 7.31) * 3), f2 = 8 + Math.floor(fr(seedF * 3.17) * 3), amp = 0.1 + 0.1 * fr(seedF * 1.713);
      let n = 0;
      for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) {
        const x = (i / 63) * 2 - 1, y = (j / 63) * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
        const lobes = amp * Math.sin(a * f1 + seedF * 6.283) + 0.09 * Math.sin(a * f2 + seedF * 12.1) + 0.05 * Math.sin(a * 15 + seedF * 3.7);
        if (r <= 0.52 * (0.35 + 0.65 * core) + lobes * fing) n++;
      }
      return n;
    };
    const a0 = area(0), a5 = area(0.5), a1 = area(1);
    console.log(`    splat area: ${a0} → ${a5} → ${a1} px (spread 0 / 0.5 / 1)`);
    assert.ok(a0 < 0.2 * a1 && a5 > 1.5 * a0 && a1 > a5, "the trace grows out of a small puddle");
    // Same colour + same rotation / aspect as the persistent splat that follows.
    const SP = fx.splats as unknown as { rot: Float32Array; asp: Float32Array };
    fx.splats.surfaceMesh.getColorAt(0, pc);
    assert.ok(same(pc, col), "splat = the colour of the shot");
    const K0 = ((jets as unknown as { iNext: number }).iNext + 47) % 48; // pancake slot just used
    assert.equal(SP.rot[0], P.irot[K0], "pancake rotation = splat rotation");
    assert.equal(SP.asp[0], P.iasp[K0 * 2], "pancake aspect x = splat aspect x");
    assert.equal(SP.asp[1], P.iasp[K0 * 2 + 1], "pancake aspect y = splat aspect y");
    assert.equal(jets.impactCount, 0, "pancake freed");
    assert.equal(jets.drops.count, 0, "nothing left drawn");
    // Slanted hit (60° off the normal): the pancake is smeared FORWARD along the surface.
    {
      // Same seed on the floor, straight down vs 60° off the normal (travelling toward -Z).
      const to = new THREE.Vector3(0, 0, -10);
      const run = (from: THREE.Vector3) => {
        jets.clear(); fx.clearAll();
        fx.spawn(from, to, col, { normal: new THREE.Vector3(0, 1, 0), seed: 9 });
        fx.update(0, viewer);
        let area = 0, fwd = 0;
        for (let f = 0; f < 200 && (jets.activeCount > 0 || jets.impactCount > 0); f++) {
          fx.update(dt, viewer);
          if (jets.impactCount === 0) continue;
          jets.drops.getMatrixAt(jets.drops.count - 1, m);
          const e = m.elements;
          // Footprint on the floor = |column0 × column1| (both lie in the surface plane).
          const c0 = new THREE.Vector3(e[0], e[1], e[2]), c1 = new THREE.Vector3(e[4], e[5], e[6]);
          area = Math.max(area, c0.cross(c1).length());
          fwd = Math.max(fwd, to.z - e[14]); // pushed toward -Z = forward along the travel
        }
        return { area, fwd };
      };
      const straight = run(new THREE.Vector3(0, 8, -10));
      const slant = run(to.clone().add(new THREE.Vector3(0, 8 * Math.cos(Math.PI / 3), 8 * Math.sin(Math.PI / 3))));
      console.log(`    slanted hit (60°): footprint ×${(slant.area / straight.area).toFixed(2)} vs straight-on, pushed ${(slant.fwd * 100).toFixed(1)} cm forward (straight-on ${(straight.fwd * 100).toFixed(1)} cm)`);
      assert.ok(slant.area > 1.2 * straight.area, "slanted hit: the paint is smeared (longer along the travel)");
      assert.ok(slant.fwd > 0.01 && straight.fwd < 1e-3, "slanted hit: it slides forward; straight-on: centred");
    }
    fx.clearAll();
    // A miss (sky): no pancake, no splat, no splash.
    fx.clearAll();
    const e0 = jets.dropsEmitted;
    fx.spawn(new THREE.Vector3(0.3, 1, -0.6), new THREE.Vector3(0.3, 1, -300), col, null);
    for (let f = 0; f < 120; f++) { fx.update(1 / 60, viewer); assert.equal(jets.impactCount, 0, "miss: no pancake"); }
    assert.equal(fx.splats.surfaceCount, 0, "miss: no splat");
    assert.ok(jets.dropsEmitted - e0 <= K.muzzleDrops + 4, "miss: no splash");
    assert.equal(jets.activeCount, 0, "miss: jet freed");
    fx.clearAll();
  });

  await test("SPLAT variants: size and rotation differ from shot to shot, shape varies per seed, identical on every client for the same seed", async () => {
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    const jets = fx.projectiles!;
    const SP = fx.splats as unknown as { rot: Float32Array; base: Float32Array; asp: Float32Array; seeds: THREE.InstancedBufferAttribute };
    const N = 14;
    const run = () => {
      jets.clear(); fx.clearAll();
      for (let k = 0; k < N; k++) {
        fx.spawn(new THREE.Vector3(3 * k, 1, -0.6), new THREE.Vector3(3 * k, 1, -8.6), fx.colorOf(k % 3, new THREE.Color()), { normal: new THREE.Vector3(0, 0, 1), seed: 1000 + 37 * k });
      }
      fx.update(0, viewer);
      for (let f = 0; f < 90; f++) fx.update(1 / 60, viewer);
      assert.equal(fx.splats.surfaceCount, N, "one splat per shot");
      // Landing order depends on each client's local per-jet speed jitter: key the splats by their seed.
      return Array.from({ length: N }, (_, i) => ({ rot: SP.rot[i], size: SP.base[i], ax: SP.asp[i * 2], ay: SP.asp[i * 2 + 1], seed: SP.seeds.getX(i) })).sort((u, v) => u.seed - v.seed);
    };
    const a = run(), b = run();
    assert.deepEqual(a, b, "same seeds → the very same splats (every client draws the same)");
    const base = fx.splats.surfaceBase, v = S.PAINT_JET.splatSizeVariation;
    const sizes = new Set(a.map((x) => x.size.toFixed(3))), rots = new Set(a.map((x) => x.rot.toFixed(3)));
    console.log(`    ${N} shots → ${sizes.size} sizes (${Math.min(...a.map((x) => x.size)).toFixed(2)}…${Math.max(...a.map((x) => x.size)).toFixed(2)} m), ${rots.size} rotations`);
    assert.ok(sizes.size >= N - 2 && rots.size >= N - 2, "sizes + rotations differ");
    for (const x of a) assert.ok(x.size >= base * (1 - v / 2) - 1e-6 && x.size <= base * (1 + v / 2) + 1e-6, "size within the variation range");
    assert.ok(Math.max(...a.map((x) => x.size)) - Math.min(...a.map((x) => x.size)) > 0.25 * base, "clearly different sizes");
    // Shape: JS port of the shader mask (PaintSplats SPLAT_GLSL), rasterised per seed.
    const fr = (x: number) => x - Math.floor(x);
    const mask = (px: number, py: number, sd: number) => {
      const r = Math.hypot(px, py), ang = Math.atan2(py, px);
      const f1 = 4 + Math.floor(fr(sd * 7.31) * 3), f2 = 8 + Math.floor(fr(sd * 3.17) * 3), amp = 0.1 + 0.1 * fr(sd * 1.713);
      const edge = 0.52 + amp * Math.sin(ang * f1 + sd * 6.283) + 0.09 * Math.sin(ang * f2 + sd * 12.1) + 0.05 * Math.sin(ang * 15 + sd * 3.7);
      if (r <= edge) return 1;
      for (let k = 0; k < 6; k++) {
        if (fr(sd * 13.7 + k * 0.37) < 0.25) continue;
        const an = sd * 31 + k * 1.9, dist = 0.62 + 0.3 * fr(Math.sin(sd * 7.3 + k * 12.9898) * 43758.5453), rad = 0.04 + 0.07 * fr(Math.sin(sd * 3.1 + k * 78.233) * 43758.5453);
        if (Math.hypot(px - Math.cos(an) * dist, py - Math.sin(an) * dist) <= rad) return 1;
      }
      return 0;
    };
    const bitmaps: Uint8Array[] = [], lobes = new Set<number>();
    for (const x of a) {
      const bmp = new Uint8Array(48 * 48);
      for (let i = 0; i < 48; i++) for (let j = 0; j < 48; j++) bmp[i * 48 + j] = mask((i / 47) * 2 - 1, (j / 47) * 2 - 1, x.seed);
      bitmaps.push(bmp);
      lobes.add(4 + Math.floor(fr(x.seed * 7.31) * 3));
    }
    // Silhouettes compared pairwise: the share of differing pixels (rotation excluded).
    let minDiff = 1, sumDiff = 0, pairs = 0;
    for (let u = 0; u < N; u++) for (let w = u + 1; w < N; w++) {
      let d = 0;
      for (let k = 0; k < 48 * 48; k++) if (bitmaps[u][k] !== bitmaps[w][k]) d++;
      const share = d / (48 * 48);
      minDiff = Math.min(minDiff, share); sumDiff += share; pairs++;
    }
    console.log(`    shapes: mean silhouette difference ${((100 * sumDiff) / pairs).toFixed(1)} % (min ${(100 * minDiff).toFixed(1)} %), ${lobes.size} lobe counts`);
    assert.ok(minDiff > 0.003 && sumDiff / pairs > 0.04, "silhouettes clearly differ from one seed to another");
    assert.ok(lobes.size >= 2, "several lobe counts");
    fx.clearAll();
  });

  await test("WEAPON KICK: sharp recoil back on each shot, soft return in 80-120 ms, never accumulates, same at any fps, camera untouched", async () => {
    const S = await server.ssrLoadModule("/src/weapons/paintball/PaintJetSettings.ts");
    const K = S.PAINT_JET;
    fp.setAmmo(32);
    step(1.0); // settle (any previous burst / FireEnd / reload)
    const camPos = cam.position.clone(), camQuat = cam.quaternion.clone();
    assert.ok(Math.abs(vm.kickOffset) < 1e-4, "at rest before the shot");
    // ONE shot, sampled every millisecond (the real controller path: fp.fire() → vm.kick).
    assert.ok(fp.canFire, "ready to fire");
    fp.fire();
    const one: number[] = [];
    for (let ms = 0; ms < 200; ms++) { vm.update(0.001, motion); one.push(vm.kickOffset); }
    const peak = Math.max(...one), tPeak = one.indexOf(peak) + 1;
    const back = one.findIndex((x, i) => i > tPeak && x < 0.05 * peak) + 1;
    console.log(`    peak ${(peak * 1000).toFixed(1)} mm at ${tPeak} ms, back to 5 % at ${back} ms, min ${(Math.min(...one) * 1000).toFixed(2)} mm`);
    assert.ok(peak > 0.9 * K.kickPeak && peak < 1.1 * K.kickPeak, "peak = the configured stroke");
    assert.ok(tPeak >= 10 && tPeak <= 30, `sharp: peak after ${tPeak} ms`);
    assert.ok(back >= 80 && back <= 120, `soft return in ${back} ms (80-120 ms)`);
    assert.ok(Math.min(...one) >= -1e-5, "critically damped: never bounces forward");
    // Burst at 600 rpm: every shot repeats the same stroke, it never builds up.
    step(0.5);
    const peaks: number[] = [];
    for (let sh = 0; sh < 8; sh++) {
      assert.ok(fp.canFire || (step(0.1), fp.canFire), "ready for the next shot");
      fp.fire();
      let m = 0;
      for (let ms = 0; ms < 100; ms++) { vm.update(0.001, motion); m = Math.max(m, vm.kickOffset); }
      peaks.push(m);
    }
    console.log(`    8-shot burst peaks: ${peaks.map((x) => (x * 1000).toFixed(1)).join(" ")} mm`);
    assert.ok(Math.max(...peaks) <= 1.1 * K.kickPeak, "no accumulation over a burst");
    assert.ok(Math.min(...peaks) >= 0.85 * K.kickPeak, "every shot has the same kick");
    // Same stroke whatever the frame rate (exact integrator).
    const stroke = (fps: number) => { step(0.6); fp.fire(); let m = 0; for (let i = 0; i < Math.round(fps * 0.2); i++) { vm.update(1 / fps, motion); m = Math.max(m, vm.kickOffset); } return m; };
    const p144 = stroke(144), p240 = stroke(240);
    console.log(`    peak @144 fps ${(p144 * 1000).toFixed(1)} mm, @240 fps ${(p240 * 1000).toFixed(1)} mm`);
    assert.ok(Math.abs(p144 - p240) < 0.06 * p240, "same stroke at 144 and 240 fps");
    // The aiming camera is never moved by the kick (the shake / ray camera stays put).
    assert.ok(cam.position.distanceTo(camPos) < 1e-9 && cam.quaternion.angleTo(camQuat) < 1e-9, "camera untouched");
  });




  await test("no max range: a 150 m shot lands within the flight bound, splat at the far wall, bounded detail", () => {
    const jets = fx.projectiles!;
    jets.clear();
    const from = new THREE.Vector3(0.3, -0.2, -0.6), to = new THREE.Vector3(0.3, -0.2, -150.6);
    const n0 = fx.splats.surfaceCount;
    fx.spawn(from, to, new THREE.Color(1, 1, 0), { normal: new THREE.Vector3(0, 0, 1), seed: 3 });
    fx.update(0, viewer);
    let frames = 0, maxInst = 0;
    while (fx.splats.surfaceCount === n0 && frames < 60) { fx.update(1 / 60, viewer); maxInst = Math.max(maxInst, jets.mesh.count); frames++; }
    console.log(`    150 m shot: splat after ${frames} frames, ≤ ${maxInst} instance(s)`);
    assert.ok(fx.splats.surfaceCount > n0, "splat 150 m away");
    assert.ok(frames <= Math.ceil((0.35 + 0.12) * 60) + 2, `150 m in ${frames} frames (flight + impact pancake)`);
    assert.equal(maxInst, 1, "one instance per jet, whatever the distance");
    fx.clearAll();
  });

  await test("frame-rate independent: 20 / 30 / 60 / 144 fps give the same arrival time and the same stretch; a hitch never skips the impact", () => {
    const jets = fx.projectiles!;
    const run = (fps: number) => {
      jets.clear();
      fx.clearAll();
      const n0 = fx.splats.surfaceCount;
      // Same per-jet irregularity for every run (the hash is driven by the spawn counter).
      (jets as unknown as { spawned: number }).spawned = 100;
      fx.spawn(new THREE.Vector3(0.3, 1, -0.6), new THREE.Vector3(0.3, 1, -25.6), new THREE.Color(1, 0, 0), { normal: new THREE.Vector3(0, 0, 1), seed: 11 });
      fx.update(0, viewer);
      // Length sampled at FIXED instants (0.1 s, 0.2 s — multiples of every tested frame time).
      let arrival = -1;
      const at: number[] = [];
      for (let f = 1; f <= fps * 0.35 + 1e-6; f++) {
        fx.update(1 / fps, viewer);
        if (arrival < 0 && fx.splats.surfaceCount > n0) arrival = f / fps;
        if (Math.abs(f / fps - 0.1) < 1e-6 || Math.abs(f / fps - 0.2) < 1e-6) {
          const c = segs();
          at.push(c.length ? c[0].head - c[0].tail : 0);
        }
      }
      return { arrival: arrival < 0 ? 0.3 : arrival, at };
    };
    const r = [20, 40, 60, 120, 240].map(run);
    console.log(`    arrival ${r.map((x) => x.arrival.toFixed(3)).join(" / ")} s, length @0.1 s ${r.map((x) => x.at[0].toFixed(2)).join(" / ")} m, @0.2 s ${r.map((x) => x.at[1].toFixed(2)).join(" / ")} m`);
    for (const x of r) {
      assert.ok(Math.abs(x.arrival - r[4].arrival) <= 1 / 20 + 1e-6, "same arrival whatever the frame rate");
      assert.ok(Math.abs(x.at[0] - r[4].at[0]) <= 0.08, "same stretch @0.1 s whatever the frame rate");
      assert.ok(Math.abs(x.at[1] - r[4].at[1]) <= 0.08, "same stretch @0.2 s whatever the frame rate");
    }
    jets.clear();
    fx.clearAll();
    const n0 = fx.splats.surfaceCount;
    fx.spawn(new THREE.Vector3(0.3, 1, -0.6), new THREE.Vector3(0.3, 1, -25.6), new THREE.Color(1, 0, 0), { normal: new THREE.Vector3(0, 0, 1), seed: 12 });
    fx.update(0, viewer);
    fx.update(0.5, viewer);
    assert.equal(fx.splats.surfaceCount, n0 + 1, "a 500 ms hitch still lands (and only once)");
    for (let f = 0; f < 30; f++) fx.update(1 / 60, viewer);
    assert.equal(fx.splats.surfaceCount, n0 + 1, "still exactly one splat");
    fx.clearAll();
  });

  await test("leaves the gun at the live muzzle while running / strafing, then flies free on its fixed ray to the impact", () => {
    const jets = fx.projectiles!;
    jets.clear();
    const muzzle = new THREE.Vector3(0.3, -0.2, -0.6);
    const from = muzzle.clone(), to = new THREE.Vector3(0.3, -0.2, -20.6);
    const n0 = fx.splats.surfaceCount;
    fx.spawn(from, to, new THREE.Color(0, 1, 0), { normal: new THREE.Vector3(0, 0, 1), seed: 5 }, (out) => { out.copy(muzzle); return true; });
    fx.update(0, viewer);
    let frames = 0, released = -1, startAtRelease: THREE.Vector3 | null = null;
    // Run forward (9.5 m/s) + strafe every frame until the jet is freed.
    while ((jets.activeCount > 0 || jets.impactCount > 0) && frames < 60) {
      muzzle.z -= 9.5 / 60;
      muzzle.x += 0.05;
      fx.update(1 / 60, viewer);
      frames++;
      const chain = segs();
      if (chain.length === 0) continue;
      // The drawn nose (instance origin) is ON the jet's ray: start + dir · head.
      const m = new THREE.Matrix4(), nose = new THREE.Vector3();
      jets.mesh.getMatrixAt(0, m);
      m.decompose(nose, new THREE.Quaternion(), new THREE.Vector3());
      assert.ok(nose.distanceTo(chain[0].headW) < 1e-4, `frame ${frames}: the drawn nose is the real head`);
      const dirNow = chain[0].dir;
      const startPoint = chain[0].start;
      if (chain[0].tail < 0.05) {
        assert.ok(startPoint.distanceTo(muzzle) < 1e-3, `frame ${frames}: tail still leaving the barrel sits AT the live muzzle`);
      } else {
        if (released < 0) { released = frames; startAtRelease = startPoint.clone(); }
        assert.ok(startPoint.distanceTo(startAtRelease!) < 1e-3, `frame ${frames}: after the release the jet flies free (start frozen)`);
        assert.ok(Math.abs(dirNow.dot(to.clone().sub(startAtRelease!).normalize()) - 1) < 1e-6, `frame ${frames}: straight on the fixed ray to the impact`);
      }
    }
    assert.ok(released > 0, "the tail left the barrel");
    assert.ok(fx.splats.surfaceCount > n0, "the splat landed");
    assert.equal(jets.activeCount, 0, "jet freed after its life");
    fx.clearAll();

    // Weapon gone (anchor → false): the start stays on the last known muzzle.
    let valid = true;
    muzzle.set(0.3, -0.2, -0.6);
    fx.spawn(muzzle.clone(), to, new THREE.Color(0, 1, 0), null, (out) => { if (!valid) return false; out.copy(muzzle); return true; });
    fx.update(0, viewer);
    muzzle.x += 0.25;
    fx.update(1 / 60, viewer);
    const last = muzzle.clone();
    valid = false;
    muzzle.x += 5;
    fx.update(1 / 60, viewer);
    const c0 = segs();
    assert.ok(c0.length > 0, "still drawn");
    assert.ok(c0[0].start.distanceTo(last) < 1e-3, "weapon gone: the jet keeps its last start point");
    jets.clear();
  });

  await test("sustained fire: 600 shots/min for 2 s stays within the pools, idle = nothing drawn", () => {
    const jets = fx.projectiles!;
    jets.clear();
    const col = fx.colorOf(3, new THREE.Color());
    let peakJets = 0, peakSeg = 0;
    for (let f = 0; f < 120; f++) {
      if (f % 6 === 0) fx.spawn(new THREE.Vector3(0.3, 1.2, -0.6), new THREE.Vector3(0.5, 1.2, -25), col, { normal: new THREE.Vector3(0, 0, 1), seed: f });
      fx.update(1 / 60, viewer);
      peakJets = Math.max(peakJets, jets.activeCount);
      peakSeg = Math.max(peakSeg, jets.mesh.count);
    }
    console.log(`    2 s burst: ≤ ${peakJets} jets / ${peakSeg} instances drawn`);
    assert.ok(peakJets >= 2, "pulses overlap: a continuous paint stream");
    assert.ok(peakJets <= 4 && peakSeg <= peakJets, "bounded cost: one instance per jet");
    for (let f = 0; f < 90; f++) fx.update(1 / 60, viewer);
    assert.equal(jets.mesh.count + jets.drops.count, 0, "idle: no instance drawn");
    fx.clearAll();
  });

  await test("splats: seeded (same shape everywhere), merged under sustained fire, cleared only by clearAll()", () => {
    const n0 = fx.splats.surfaceCount;
    const c = new THREE.Color(1, 0, 0);
    for (let i = 0; i < 60; i++) {
      fx.splats.splatSurface(new THREE.Vector3(5 + (i % 5) * 0.01, 1, -3), new THREE.Vector3(0, 0, 1), c, undefined, 1000 + i);
    }
    const added = fx.splats.surfaceCount - n0;
    console.log(`    60 balls on the same spot → ${added} instance(s)`);
    // A merged splat keeps its SHAPE + ROTATION (readable under sustained
    // fire): only the colour changes and it grows a little.
    {
      fx.clearAll();
      const S = fx.splats as unknown as { seeds: THREE.InstancedBufferAttribute; rot: Float32Array; grow: Float32Array };
      const i0 = fx.splats.splatSurface(new THREE.Vector3(9, 1, -3), new THREE.Vector3(0, 0, 1), c, undefined, 42);
      const seed0 = S.seeds.getX(i0), rot0 = S.rot[i0], grow0 = S.grow[i0];
      const blue = new THREE.Color(0, 0, 1);
      const i1 = fx.splats.splatSurface(new THREE.Vector3(9.05, 1.02, -3), new THREE.Vector3(0, 0, 1), blue, undefined, 43);
      assert.equal(i1, i0, "merged into the same splat");
      assert.equal(S.seeds.getX(i0), seed0, "same shape (seed kept)");
      assert.equal(S.rot[i0], rot0, "same rotation");
      assert.ok(S.grow[i0] > grow0, "grows a little");
      const got = new THREE.Color();
      fx.splats.surfaceMesh.getColorAt(i0, got);
      assert.ok(got.b > 0.99 && got.r < 0.01, "newest colour on top");
      fx.clearAll();
      for (let i = 0; i < 60; i++) {
        fx.splats.splatSurface(new THREE.Vector3(5 + (i % 5) * 0.01, 1, -3), new THREE.Vector3(0, 0, 1), c, undefined, 1000 + i);
      }
    }
    // 3× splat: the quad of the first splat is ~0.96 m wide.
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    fx.splats.surfaceMesh.getMatrixAt(0, m);
    m.decompose(p, q, s);
    console.log(`    splat size ≈ ${Math.max(s.x, s.y).toFixed(2)} m`);
    assert.ok(Math.max(s.x, s.y) > 0.6, "3× the pack splat (0.96 m base)");
    assert.ok(added <= 8, "merged (no quad pile-up)");
    fx.clearAll();
    assert.equal(fx.splats.surfaceCount, 0);
    assert.equal(worldScene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh).length, 3, "+3 draw calls total (paint jets, droplets, splats)");
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

  await test("REAL weapon: every ball on the exact crosshair ray (no spread, no shake), predicted remote hit → immediate hitmarker", async () => {
    const { PaintballRifleWeapon } = await server.ssrLoadModule("/src/weapons/paintball/PaintballRifleWeapon.ts");
    const { HitZone } = await server.ssrLoadModule("/src/combat/HitZone.ts");
    const cam = new THREE.PerspectiveCamera(92, 16 / 9, 0.1, 400);
    cam.position.set(0, 1.6, 0);
    cam.rotation.set(0.05, 0.2, 0, "YXZ");
    cam.updateMatrixWorld(true);
    const scene = new THREE.Scene();
    const vm2 = new ViewmodelSystem(16 / 9);
    await vm2.ready;
    const w = new PaintballRifleWeapon(cam, scene, vm2);
    await w.ready;
    w.networkAuthority = true; // multiplayer: no local damage, server volumes
    let shakes = 0;
    w.onCameraShake = () => shakes++;
    const sent: { seed: number; spread: number }[] = [];
    w.onNetFire = (seed: number, spread: number) => sent.push({ seed, spread });
    const rays: THREE.Vector3[] = [];
    // Remote avatar straight ahead, 60 m away, on the crosshair ray.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    w.resolveRemoteHit = (_o: THREE.Vector3, d: THREE.Vector3, maxDist: number) => {
      rays.push(d.clone());
      return maxDist > 60 ? { distance: 60, root: null, head: rays.length % 2 === 0 } : null;
    };
    const markers: number[] = [];
    w.onPredictedRemoteHit = (zone: number) => markers.push(zone);
    w.takePresentation();
    const input = {
      fireHeld: true, reloadPressed: false, inspectPressed: false, aimHeld: false, canAct: true,
      hittables: [] as THREE.Object3D[], grounded: true, verticalVelocity: 0, jumpSequence: 0, sliding: false, speed: 0,
    };
    for (let f = 0; f < 144 * 2; f++) { // 2 s held at 144 Hz, camera never moves
      w.update(1 / 144, input);
      vm2.syncCamera(cam);
      w.postCameraUpdate(1 / 144);
    }
    const aim = R.paintballAimDirection(fwd);
    console.log(`    ${rays.length} balls, ${markers.length} immediate hitmarkers, max ray error ${Math.max(...rays.map((d) => THREE.MathUtils.radToDeg(d.angleTo(new THREE.Vector3(aim.x, aim.y, aim.z))))).toExponential(1)}°`);
    assert.ok(rays.length >= 18, `a 2 s burst (${rays.length} balls)`);
    for (const d of rays) assert.ok(d.angleTo(new THREE.Vector3(aim.x, aim.y, aim.z)) < 1e-9, "every ball EXACTLY on the crosshair ray");
    assert.ok(sent.every((s) => s.spread === 0), "0° cone sent to the server");
    assert.equal(shakes, 0, "no camera shake per ball (the ray camera never jitters)");
    assert.equal(markers.length, rays.length, "one immediate hitmarker per ball that connects");
    assert.ok(markers.includes(HitZone.HEAD) && markers.includes(HitZone.BODY), "zone forwarded (head / body)");
    w.releasePresentation();
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

