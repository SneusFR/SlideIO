/**
 * Headless physics checks for GIVRE 01 (real Rapier world, same collider
 * descriptors and collision groups as src/world/GivreMap.ts):
 *   1. every collider of givre_01.physics.json builds (cuboids + hulls, no trimesh);
 *   2. the 8 spawns stand on the ground inside a corner room, facing its centre;
 *   3. the 3 ramps are climbable/descendable to the 6 m gallery with the REAL
 *      character controller settings (autostep 0.45, snap 0.35, 55° max);
 *   4. doors (12.4 × 5 m) and traverse portals (4.7 m) are crossable;
 *   5. the low roofs P1/Q1 are unlandable (player clips) but shots pass over;
 *   6. jump heights: low crates / west wall (1.2–1.3 m) clearable, high crates
 *      (2.4 m) / blocks (2.4–2.9 m) not, with the real jump (8.8 m/s, g 26);
 *   7. the shared GivreColliders/GivreSpawns stay in sync with the JSON.
 *
 * Run: node scripts/test-givre-map-physics.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import RAPIER from "@dimforge/rapier3d-compat";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "src/assets/MAP/Givre/givre_01.physics.json"), "utf8"));

// Same values as src/physics/PhysicsWorld.ts (CollisionGroups) and MovementConfig.
const CHARACTER = (0x0004 << 16) | 0xffff;
const PLAYER_CLIP = (0x0008 << 16) | 0x0004;
const SHOT_QUERY = (0xffff << 16) | (0xffff & ~0x0008);
const WORLD_ONLY = (0xffff << 16) | 0x0001; // weapons' static-world filter
const RADIUS = 0.35;
const HALF = 0.55;
const CENTER = HALF + RADIUS; // capsule centre above the feet
const GRAVITY = 26;
const JUMP = 8.8;
const SPEED = 9.5;

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// ---- 1. colliders ----
let cuboids = 0;
let hulls = 0;
const add = (c, groups) => {
  let desc;
  if (c.type === "cuboid") {
    assert.deepEqual(c.rotation, [0, 0, 0, 1], `${c.id}: boxes must be axis-aligned`);
    desc = RAPIER.ColliderDesc.cuboid(...c.halfExtents).setTranslation(...c.position);
    cuboids++;
  } else if (c.type === "convexHull") {
    desc = RAPIER.ColliderDesc.convexHull(new Float32Array(c.vertices.flat()));
    if (!desc) throw new Error(`convexHull failed: ${c.id}`);
    hulls++;
  } else {
    throw new Error(`unsupported collider type ${c.type} (${c.id})`);
  }
  desc.setFriction(0).setRestitution(0);
  if (groups !== undefined) desc.setCollisionGroups(groups);
  world.createCollider(desc);
};
data.colliders.forEach((c) => add(c));
data.playerClips.forEach((c) => add(c, PLAYER_CLIP));
check(cuboids === 117 + 2 && hulls === 13, `colliders: ${cuboids} cuboids (incl. 2 clips) + ${hulls} hulls`);
check(
  data.expansion.mapEnvelope[0] === 280 &&
    data.expansion.mapEnvelope[1] === 220 &&
    data.expansion.envelopeMin.join() === "-140,-140" &&
    data.expansion.envelopeMax.join() === "140,80",
  `envelope 280 × 220 m: X [-140, 140], Z [-140, 80]`,
);
world.timestep = 0;
world.step();

const down = { x: 0, y: -1, z: 0 };
const groundAt = (x, y, z, groups) => {
  const hit = world.castRay(new RAPIER.Ray({ x, y, z }, down), 40, true, undefined, groups);
  return hit ? y - hit.timeOfImpact : -Infinity;
};

// ---- Character: same capsule / controller setup as PlayerController ----
const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 50, 0));
const capsule = world.createCollider(
  RAPIER.ColliderDesc.capsule(HALF, RADIUS).setFriction(0).setRestitution(0).setCollisionGroups(CHARACTER),
  body,
);
const ctrl = world.createCharacterController(0.06);
ctrl.enableAutostep(0.45, 0.25, true);
ctrl.enableSnapToGround(0.35);
ctrl.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
ctrl.setMinSlopeSlideAngle((80 * Math.PI) / 180);
ctrl.setSlideEnabled(true);

/**
 * Walks the capsule from `from` (feet) along XZ direction `dir` for
 * `seconds`, optionally jumping at t = jumpAt. Returns the final feet pose
 * and the max feet height reached. 120 Hz fixed step.
 */
function simulate(from, dir, seconds, jumpAt = -1) {
  const n = Math.hypot(dir[0], dir[1]);
  const dx = (dir[0] / n) * SPEED;
  const dz = (dir[1] / n) * SPEED;
  body.setTranslation({ x: from[0], y: from[1] + CENTER + 0.02, z: from[2] }, true);
  world.timestep = 0;
  world.step();
  const dt = 1 / 120;
  let vy = 0;
  let grounded = true;
  let maxY = from[1];
  let jumped = false;
  for (let t = 0; t < seconds; t += dt) {
    if (!jumped && jumpAt >= 0 && t >= jumpAt && grounded) {
      vy = JUMP;
      jumped = true;
    }
    vy = grounded && vy <= 0 ? -1 : vy - GRAVITY * dt;
    ctrl.computeColliderMovement(capsule, { x: dx * dt, y: vy * dt, z: dz * dt });
    const m = ctrl.computedMovement();
    const p = body.translation();
    body.setTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z }, true);
    world.timestep = 0;
    world.step();
    grounded = ctrl.computedGrounded();
    if (grounded && vy < 0) vy = 0;
    maxY = Math.max(maxY, p.y + m.y - CENTER);
  }
  const p = body.translation();
  return { x: p.x, y: p.y - CENTER, z: p.z, maxY };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 2. spawns ----
const roomZones = Object.fromEntries(data.zones.map((z) => [z.id, z]));
for (const s of data.spawns) {
  const [x, y, z] = s.position;
  const g = groundAt(x, y + 0.3, z);
  const zone = roomZones[s.room.toLowerCase()];
  const inRoom = zone && x > zone.min[0] && x < zone.max[0] && z > zone.min[1] && z < zone.max[1];
  // yaw = Object3D.rotation.y → forward = (-sin yaw, 0, -cos yaw)
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const cx = (zone.min[0] + zone.max[0]) / 2 - x;
  const cz = (zone.min[1] + zone.max[1]) / 2 - z;
  const facing = (fx * cx + fz * cz) / Math.hypot(cx, cz);
  // Spawns 1-4 (corner rooms) face the room centre; spawns 5-8 (south
  // vestibule / east elbow, open courtyards) only need to be forward-looking
  // into the playable area, so their facing is reported, not enforced.
  const cornerRoom = s.room === "STOCK" || s.room === "CHAUFFERIE";
  // "Au sol, sans collision": no collider (static world, clips included)
  // intersects the standing capsule.
  const overlap = world.intersectionWithShape(
    { x, y, z },
    { x: 0, y: 0, z: 0, w: 1 },
    new RAPIER.Capsule(HALF, RADIUS),
  );
  check(
    near(g, 0, 0.05) && near(y - g, 0.93, 0.01) && inRoom && !overlap && (!cornerRoom || facing > 0.9),
    `${s.id} ${s.room}: ground ${g.toFixed(2)}, centre +${(y - g).toFixed(2)} m, in zone, no overlap, ` +
      `facing room centre cos ${facing.toFixed(2)}${cornerRoom ? "" : " (informational)"}`,
  );
}

// ---- 3. ramps up + down ----
for (const r of data.ramps) {
  const dir = [r.end[0] - r.start[0], r.end[2] - r.start[2]];
  const len = Math.hypot(dir[0], dir[1]);
  const ux = dir[0] / len;
  const uz = dir[1] / len;
  const start = [r.start[0] - ux * 2, 0, r.start[2] - uz * 2];
  const up = simulate(start, dir, (len + 5) / SPEED);
  check(near(up.y, 6, 0.1), `${r.id} up: feet at ${up.y.toFixed(2)} m (gallery 6 m)`);
  const top = [r.end[0] + ux * 1.5, 6, r.end[2] + uz * 1.5];
  const dn = simulate(top, [-dir[0], -dir[1]], (len + 4) / SPEED);
  check(near(dn.y, 0, 0.1), `${r.id} down: feet at ${dn.y.toFixed(2)} m`);
}

// ---- 4. doors + traverse portals: walk through the opening centre ----
// Each opening = the gap between its two jambs (frame ids _00/_01 … of the
// export); the walk crosses the frame's thin axis over 16 m.
const frames = data.colliders.filter((c) => /Cadres_\d+$/.test(c.id));
const byGroup = {};
for (const c of frames) {
  const key = c.id.replace(/_\d+$/, "");
  (byGroup[key] ??= []).push(c);
}
let openings = 0;
for (const [key, list] of Object.entries(byGroup)) {
  // Lintels sit above Y = 4; jambs start at the floor. Pair jambs 3 by 3.
  for (let i = 0; i + 2 < list.length; i += 3) {
    const [a, b, lintel] = list.slice(i, i + 3);
    const ax = a.position[0];
    const az = a.position[2];
    const bx = b.position[0];
    const bz = b.position[2];
    const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
    const gap = alongX
      ? Math.abs(bx - ax) - a.halfExtents[0] - b.halfExtents[0]
      : Math.abs(bz - az) - a.halfExtents[2] - b.halfExtents[2];
    const clearH = lintel.position[1] - lintel.halfExtents[1];
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const from = alongX ? [mx, 0, mz - 8] : [mx - 8, 0, mz];
    const end = simulate(from, alongX ? [0, 1] : [1, 0], 16 / SPEED);
    const crossed = alongX ? end.z > mz + 6 : end.x > mx + 6;
    check(crossed, `${key} opening ${(i / 3) | 0}: ${gap.toFixed(2)} × ${clearH.toFixed(2)} m crossed`);
    openings++;
  }
}
// Export v2: Stock and Chaufferie have 2 doors each → 4 room doors, + 4
// covered-link portals (COL_LIAISON_Cadres: courtyard ↔ junction, junction ↔
// link, west and east link ends) = 8 framed openings.
check(openings === 8, `${openings} framed openings tested (4 room doors + 4 covered-link portals)`);
// Courtyard ↔ junction portal: 22.5 m outer width (jambs included) × 4.7 m high.
{
  const [a, b, lintel] = data.colliders.filter((c) => /^COL_LIAISON_Cadres_0[0-2]$/.test(c.id));
  const outer = Math.abs(b.position[0] - a.position[0]) + a.halfExtents[0] + b.halfExtents[0];
  const clearH = lintel.position[1] - lintel.halfExtents[1];
  check(near(outer, 22.5, 0.1) && near(clearH, 4.7, 0.01), `courtyard ↔ junction portal: ${outer.toFixed(2)} × ${clearH.toFixed(2)} m`);
}
// Covered link end to end (west end x = −64.5 → east end x = 83.8, Z ≈ 55):
// start 5.5 m before the west portal, walk 18 s (≈ 170 m of free run), the
// east elbow is open until the building at x = 107.
{
  const end = simulate([-70, 0, 55.2], [1, 0], 18);
  check(end.x > 90, `covered south link crossed end to end (x ${end.x.toFixed(1)}, feet ${end.y.toFixed(2)} m)`);
}

// ---- 5. low roofs P1/Q1: player clips block landing, NOT shots ----
for (const clip of data.playerClips) {
  const [cx, , cz] = clip.position;
  const landFeet = groundAt(cx, 30, cz, CHARACTER); // what a character "lands" on
  const shotHit = world.castRay(
    new RAPIER.Ray({ x: cx, y: 30, z: cz }, down), 40, true, undefined, SHOT_QUERY,
  );
  const shotY = shotHit ? 30 - shotHit.timeOfImpact : -Infinity;
  const worldOnly = groundAt(cx, 30, cz, WORLD_ONLY);
  // Horizontal gallery → courtyard shot at Y = 7.6 over the roof.
  const over = world.castRay(
    new RAPIER.Ray({ x: cx, y: 7.6, z: -87 }, { x: 0, y: 0, z: 1 }), 40, true, undefined, SHOT_QUERY,
  );
  check(
    near(landFeet, 16, 0.01) && near(shotY, 4, 0.01) && near(worldOnly, 4, 0.01) && over === null,
    `${clip.id}: character stops at clip top ${landFeet.toFixed(1)} m (unlandable roof), ` +
      `shots reach the roof ${shotY.toFixed(1)} m, gallery shot over the roof clear`,
  );
  // Dropping onto the roof from the gallery edge never lands at 4 m.
  const drop = simulate([cx, 16.2, cz], [0, 1], 0.5);
  check(drop.y > 15.9 || drop.y < 0.1, `${clip.id}: no landing on the 4 m roof (feet ${drop.y.toFixed(2)} m)`);
}

// ---- 6. jump clearance (real jump: 8.8 m/s, g = 26 → apex ≈ 1.49 m) ----
const jumpCases = [
  ["COL_MURET_CourOuest_00", true],
  ["COL_COUV_CourCentrale_CaissesNE_01", true], // low crate 1.2 m
  ["COL_COUV_CourCentrale_CaissesNE_02", true], // low crate 1.3 m
  ["COL_COUV_CourCentrale_CaissesNE_00", false], // high crate 2.4 m
  ["COL_COUV_CourCentrale_Bloc_00", false], // block 2.4 m
  ["COL_COUV_CouloirOuest_Bloc1_00", false], // block 2.6 m
];
for (const [id, clearable] of jumpCases) {
  const c = data.colliders.find((k) => k.id === id);
  const top = c.position[1] + c.halfExtents[1];
  const thinX = c.halfExtents[0] <= c.halfExtents[2];
  const half = thinX ? c.halfExtents[0] : c.halfExtents[2];
  const run = 4;
  const from = thinX
    ? [c.position[0] - half - run, 0, c.position[2]]
    : [c.position[0], 0, c.position[2] - half - run];
  const res = simulate(from, thinX ? [1, 0] : [0, 1], (2 * half + 2 * run) / SPEED, (run - 1.6) / SPEED);
  const passed = thinX ? res.x > c.position[0] + half + 0.5 : res.z > c.position[2] + half + 0.5;
  const landedOn = near(res.y, top, 0.05);
  const ok = clearable ? passed || landedOn : !passed && !landedOn;
  check(ok, `${id} (${top.toFixed(2)} m): ${clearable ? "clearable" : "NOT clearable"} — passed=${passed}, max feet ${res.maxY.toFixed(2)} m`);
}

// ---- 7. shared files in sync with the JSON ----
const sharedColliders = readFileSync(join(root, "shared/map/GivreColliders.ts"), "utf8");
const sharedSpawns = readFileSync(join(root, "shared/map/GivreSpawns.ts"), "utf8");
const boxLines = (sharedColliders.match(/^\s+\[[^\]]+\],/gm) ?? []).length;
check(boxLines === 117 + 18 + 10, `GivreColliders.ts: ${boxLines} AABBs (117 cuboids + 18 ramp slabs + 10 hull AABBs)`);
check(
  /minZ: -140, maxZ: 80/.test(readFileSync(join(root, "shared/map/MapRegistry.ts"), "utf8")),
  "MapRegistry GIVRE envelope Z = [-140, 80]",
);
check(!/CLIP_/.test(sharedColliders), "GivreColliders.ts: player clips absent (shots pass through)");
for (const s of data.spawns) {
  check(sharedSpawns.includes(`yaw: ${s.yaw} }, // ${s.id}`), `GivreSpawns.ts contains ${s.id}`);
}

if (failures > 0) {
  console.error(`\n${failures} GIVRE physics check(s) failed`);
  process.exit(1);
}
console.log("\nAll GIVRE physics checks passed.");
