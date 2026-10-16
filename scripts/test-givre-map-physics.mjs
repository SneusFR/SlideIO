/**
 * Headless physics checks for GIVRE 01 (real Rapier world, same collider
 * descriptors and collision groups as src/world/GivreMap.ts):
 *   1. every collider of givre_01.physics.json builds (cuboids + hulls, no trimesh);
 *   2. the 8 spawns stand on the ground inside a corner room, facing its centre;
 *   3. the 3 ramps are climbable/descendable to the 6 m gallery with the REAL
 *      character controller settings (autostep 0.45, snap 0.35, 55° max);
 *   4. doors (12.4 × 5 m) and traverse portals (4.7 m) are crossable;
 *   5. the 10 player clips (v3: 9 boxes + 1 convex hull) stop characters but
 *      never shots; the low roofs P1/Q1 stay unlandable from the gallery;
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
  return world.createCollider(desc);
};
data.colliders.forEach((c) => add(c));
const solidCount = { cuboids, hulls };
/** Player-clip colliders by id (shots must never hit one of them). */
const clipById = new Map();
data.playerClips.forEach((c) => clipById.set(c.id, add(c, PLAYER_CLIP)));
const clipHandles = new Set([...clipById.values()].map((col) => col.handle));
// Export v3: 516 solids (307 boxes + 209 hulls) + 10 player clips (9 boxes + 1 hull).
check(
  solidCount.cuboids === 307 && solidCount.hulls === 209,
  `solid colliders: ${solidCount.cuboids} cuboids + ${solidCount.hulls} convex hulls (v3: 307 + 209)`,
);
check(
  cuboids - solidCount.cuboids === 9 && hulls - solidCount.hulls === 1 && data.playerClips.length === 10,
  `player clips: ${data.playerClips.length} (${cuboids - solidCount.cuboids} boxes + ${hulls - solidCount.hulls} convex hull)`,
);
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
/** World AABB of one JSON collider (hulls: AABB of their vertices). */
const clipBounds = (c) => {
  if (c.type === "cuboid") {
    return {
      min: c.position.map((p, i) => p - c.halfExtents[i]),
      max: c.position.map((p, i) => p + c.halfExtents[i]),
    };
  }
  const min = [0, 1, 2].map((i) => Math.min(...c.vertices.map((v) => v[i])));
  const max = [0, 1, 2].map((i) => Math.max(...c.vertices.map((v) => v[i])));
  return { min, max };
};

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
  // v3: SPAWN_01 / SPAWN_02 were re-oriented in Blender (SPAWN_01 now looks
  // toward the Stock door, ~48° off the room centre) — "facing inward" =
  // within 60° of the room centre (cos > 0.5).
  check(
    near(g, 0, 0.05) && near(y - g, 0.93, 0.01) && inRoom && !overlap && (!cornerRoom || facing > 0.5),
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
    // Crossed = the capsule fully cleared the frame (+1.5 m). v3 adds décor
    // (market stalls…) a few metres behind some portals, so the walk may stop
    // there — the opening itself is what this check is about.
    const depth = alongX ? a.halfExtents[2] : a.halfExtents[0];
    const crossed = alongX ? end.z > mz + depth + 1.5 : end.x > mx + depth + 1.5;
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
// Covered link end to end (west end x = −64.5 → east end x = 83.8). v3 fills
// it with market décor (stalls, kiosk, carousel, fir tree…): there is no
// straight lane any more, so the check is a capsule-sized path search on a
// 0.25 m floor grid. A cell is blocked by any solid whose AABB (hulls: vertex
// AABB, i.e. conservative) overlaps the body between the autostep height
// (0.45 m) and head height (1.85 m), inflated by the capsule radius.
{
  const CELL = 0.25;
  const X0 = -64.5;
  const X1 = 83.8;
  const Z0 = 45.45; // zone liaison_sud
  const Z1 = 65;
  const nx = Math.ceil((X1 - X0) / CELL);
  const nz = Math.ceil((Z1 - Z0) / CELL);
  const blocked = new Uint8Array(nx * nz);
  const solids = data.colliders.map(clipBounds).filter((b) => b.min[1] < 1.85 && b.max[1] > 0.45);
  for (const b of solids) {
    const i0 = Math.max(0, Math.floor((b.min[0] - RADIUS - X0) / CELL));
    const i1 = Math.min(nx - 1, Math.floor((b.max[0] + RADIUS - X0) / CELL));
    const j0 = Math.max(0, Math.floor((b.min[2] - RADIUS - Z0) / CELL));
    const j1 = Math.min(nz - 1, Math.floor((b.max[2] + RADIUS - Z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1;
  }
  // Outer walls of the link (zone edges) also block the capsule.
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const z = Z0 + (j + 0.5) * CELL;
      if (z < Z0 + RADIUS || z > Z1 - RADIUS) blocked[j * nx + i] = 1;
    }
  }
  const seen = new Uint8Array(nx * nz);
  const queue = [];
  for (let j = 0; j < nz; j++) {
    if (!blocked[j * nx]) {
      seen[j * nx] = 1;
      queue.push(j * nx);
    }
  }
  let reachedEast = false;
  for (let q = 0; q < queue.length && !reachedEast; q++) {
    const c = queue[q];
    const i = c % nx;
    const j = (c - i) / nx;
    if (i === nx - 1) reachedEast = true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const k = jj * nx + ii;
      if (blocked[k] || seen[k]) continue;
      seen[k] = 1;
      queue.push(k);
    }
  }
  check(reachedEast, `covered south link: a capsule-wide path exists from x ${X0} to x ${X1} through the v3 market décor`);
}

// ---- 5. player clips block CHARACTERS only, never shots ----
// v3: 10 clips (9 boxes + CLIP_COULO_Citerne_02 convex hull). Each one is
// probed straight down through its XZ centre:
//   - a CHARACTER ray stops ON the clip (its top) → décor / roof unlandable;
//   - a SHOT ray never hits the clip (it reaches the décor or roof below);
//   - a WORLD_ONLY ray (weapons' static filter) never hits it either.
for (const clip of data.playerClips) {
  const { min, max } = clipBounds(clip);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const from = max[1] + 10;
  const ray = () => new RAPIER.Ray({ x: cx, y: from, z: cz }, down);
  const charHit = world.castRay(ray(), 40, true, undefined, CHARACTER);
  const shotHit = world.castRay(ray(), 40, true, undefined, SHOT_QUERY);
  const worldHit = world.castRay(ray(), 40, true, undefined, WORLD_ONLY);
  const charY = charHit ? from - charHit.timeOfImpact : -Infinity;
  const shotY = shotHit ? from - shotHit.timeOfImpact : -Infinity;
  const charOnClip = charHit !== null && clipHandles.has(charHit.collider.handle);
  const shotThrough = shotHit === null || !clipHandles.has(shotHit.collider.handle);
  const worldThrough = worldHit === null || !clipHandles.has(worldHit.collider.handle);
  check(
    charOnClip && near(charY, max[1], 0.05) && shotThrough && worldThrough && shotY < max[1] - 0.5,
    `${clip.id} (${clip.type}): character stops on the clip at ${charY.toFixed(1)} m, ` +
      `shots pass through to ${shotY.toFixed(1)} m`,
  );
}
// Low roofs P1/Q1 (unchanged since v2): never landable from the gallery
// edge, and a horizontal gallery → courtyard shot at Y = 7.6 is clear.
for (const id of ["CLIP_Toit_P1", "CLIP_Toit_Q1"]) {
  const clip = data.playerClips.find((c) => c.id === id);
  const [cx, , cz] = clip.position;
  const over = world.castRay(
    new RAPIER.Ray({ x: cx, y: 7.6, z: -87 }, { x: 0, y: 0, z: 1 }), 40, true, undefined, SHOT_QUERY,
  );
  check(over === null, `${id}: gallery shot over the roof clear`);
  const drop = simulate([cx, 16.2, cz], [0, 1], 0.5);
  check(drop.y > 15.9 || drop.y < 0.1, `${id}: no landing on the 4 m roof (feet ${drop.y.toFixed(2)} m)`);
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
// v3: a snowdrift (COL_PLACE_Congeres_04, 2.42 m) now leans against the SOUTH
// face of COL_COUV_CourCentrale_Bloc_00 — the block is jump-tested from the
// NORTH (sign −1 = approach from +Z, walking toward −Z), and the drift is
// reported separately below (level-design decision, not a regression).
const approachFromMax = new Set(["COL_COUV_CourCentrale_Bloc_00"]);
for (const [id, clearable] of jumpCases) {
  const c = data.colliders.find((k) => k.id === id);
  const top = c.position[1] + c.halfExtents[1];
  const thinX = c.halfExtents[0] <= c.halfExtents[2];
  const half = thinX ? c.halfExtents[0] : c.halfExtents[2];
  const run = 4;
  const sign = approachFromMax.has(id) ? -1 : 1;
  const from = thinX
    ? [c.position[0] - sign * (half + run), 0, c.position[2]]
    : [c.position[0], 0, c.position[2] - sign * (half + run)];
  const dir = thinX ? [sign, 0] : [0, sign];
  const res = simulate(from, dir, (2 * half + 2 * run) / SPEED, (run - 1.6) / SPEED);
  const along = thinX ? (res.x - c.position[0]) * sign : (res.z - c.position[2]) * sign;
  const passed = along > half + 0.5;
  const landedOn = near(res.y, top, 0.05);
  const ok = clearable ? passed || landedOn : !passed && !landedOn;
  check(ok, `${id} (${top.toFixed(2)} m): ${clearable ? "clearable" : "NOT clearable"} — passed=${passed}, max feet ${res.maxY.toFixed(2)} m`);
}
// Informational (never fails): can the central block be climbed via the v3
// snowdrift on its south face?
{
  const c = data.colliders.find((k) => k.id === "COL_COUV_CourCentrale_Bloc_00");
  const top = c.position[1] + c.halfExtents[1];
  const res = simulate([c.position[0] - 1, 0, c.position[2] - c.halfExtents[2] - 6], [0, 1], 1.5, 0.35);
  const onTop = res.maxY > top - 0.1;
  console.log(
    `INFO COL_COUV_CourCentrale_Bloc_00 via COL_PLACE_Congeres_04 (south): ` +
      `${onTop ? "CLIMBABLE" : "not climbable"} (max feet ${res.maxY.toFixed(2)} m, block top ${top.toFixed(2)} m)`,
  );
}

// ---- 7. shared files in sync with the JSON ----
const sharedColliders = readFileSync(join(root, "shared/map/GivreColliders.ts"), "utf8");
const sharedSpawns = readFileSync(join(root, "shared/map/GivreSpawns.ts"), "utf8");
const boxLines = (sharedColliders.match(/^\s+\[[^\]]+\],/gm) ?? []).length;
// v3: 307 cuboids + 3 ramps × 6 slabs + (209 hulls − 3 ramp hulls) AABBs.
check(boxLines === 307 + 18 + 206, `GivreColliders.ts: ${boxLines} AABBs (307 cuboids + 18 ramp slabs + 206 hull AABBs)`);
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
