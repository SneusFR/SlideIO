/**
 * Generates the SHARED map data files from the YARD 01 Expanded physics
 * export (src/assets/MAP/Yard/yard_01.physics.json):
 *
 *   shared/map/YardColliders.ts — AABB list for the backend hitscan
 *     (cuboids converted to world AABBs — rotated boxes included;
 *      movement-ramp convex hulls approximated by 6 stacked step slabs
 *      from the `ramps` metadata; the remaining solid hulls — ramp
 *      cheeks + P07 — approximated by their vertex AABB)
 *     + the acid hazard zones (server-authoritative danger volumes)
 *   shared/map/YardSpawns.ts    — the 8 spawn points (capsule centers)
 *
 * Run after every map re-export:  node scripts/generate-yard-colliders.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(
  readFileSync(join(root, "src/assets/MAP/Yard/yard_01.physics.json"), "utf8"),
);

const r3 = (n) => Math.round(n * 1000) / 1000;
const fmtBox = (b) => `  [${b.join(", ")}],`;

/** World-space AABB half extents of a rotated box: |R| · h (per axis). */
function rotatedHalfExtents(halfExtents, quaternion) {
  const [hx, hy, hz] = halfExtents;
  let [x, y, z, w] = quaternion;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len;
  y /= len;
  z /= len;
  w /= len;
  // Rotation matrix from the quaternion (row-major).
  const m = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  return [0, 1, 2].map((i) =>
    Math.abs(m[i][0]) * hx + Math.abs(m[i][1]) * hy + Math.abs(m[i][2]) * hz,
  );
}

// ---- Cuboids: [cx, cy, cz, sizeX, sizeY, sizeZ] (world AABB, full sizes) ----
const cuboidLines = [];
for (const c of data.colliders) {
  if (c.type !== "cuboid") continue;
  const h = rotatedHalfExtents(c.halfExtents, c.rotation ?? [0, 0, 0, 1]);
  cuboidLines.push(
    fmtBox([
      r3(c.position[0]),
      r3(c.position[1]),
      r3(c.position[2]),
      r3(h[0] * 2),
      r3(h[1] * 2),
      r3(h[2] * 2),
    ]) + ` // ${c.id}`,
  );
}

// ---- Movement ramps (convex hulls): 6 stacked step slabs each ----
const SLABS = 6;
const rampLines = [];
for (const ramp of data.ramps) {
  const [sx, sy, sz] = ramp.start;
  const [ex, ey, ez] = ramp.end;
  const dx = ex - sx;
  const dz = ez - sz;
  const len = Math.hypot(dx, dz);
  const alongX = Math.abs(dx) > Math.abs(dz);
  const bottom = Math.min(sy, ey) - 0.25;
  for (let k = 0; k < SLABS; k++) {
    const fm = (k + 0.5) / SLABS;
    const top = sy + (ey - sy) * fm;
    const run = len / SLABS + 0.02;
    rampLines.push(
      fmtBox([
        r3(sx + dx * fm),
        r3((top + bottom) / 2),
        r3(sz + dz * fm),
        r3(alongX ? run : ramp.width),
        r3(top - bottom),
        r3(alongX ? ramp.width : run),
      ]) + (k === 0 ? ` // ${ramp.id} (${SLABS} slabs)` : ""),
    );
  }
}

// ---- Remaining SOLID convex hulls (ramp cheeks + P07): vertex AABB ----
const hullLines = [];
for (const c of data.colliders) {
  if (c.type !== "convexHull") continue;
  if (c.purpose === "movement_ramp") continue; // replaced by the slabs above
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [vx, vy, vz] of c.vertices) {
    if (vx < minX) minX = vx;
    if (vy < minY) minY = vy;
    if (vz < minZ) minZ = vz;
    if (vx > maxX) maxX = vx;
    if (vy > maxY) maxY = vy;
    if (vz > maxZ) maxZ = vz;
  }
  hullLines.push(
    fmtBox([
      r3((minX + maxX) / 2),
      r3((minY + maxY) / 2),
      r3((minZ + maxZ) / 2),
      r3(maxX - minX),
      r3(maxY - minY),
      r3(maxZ - minZ),
    ]) + ` // ${c.id} (hull AABB)`,
  );
}

// ---- Hazard zones (acid pool — server-authoritative death volume) ----
const hazardEntries = (data.hazards ?? []).map(
  (h) => `  {
    id: ${JSON.stringify(h.id)},
    type: ${JSON.stringify(h.type)},
    min: [${h.min.map(r3).join(", ")}],
    max: [${h.max.map(r3).join(", ")}],
    respawnFeet: [${(h.respawnFeet ?? [0, 0, 0]).map(r3).join(", ")}],
  },`,
);

const collidersTs = `/**
 * SHARED YARD 01 Expanded map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Yard/yard_01.physics.json
 * by scripts/generate-yard-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes, world AABB —
 * rotated cuboids are enclosed by their axis-aligned bounds). The frontend
 * builds its Rapier world from the exact physics JSON (372 cuboids +
 * 16 convex hulls, see src/world/YardMap.ts); the backend raycasts THIS
 * list so walls occlude shots.
 *
 * NOTE: the ${data.ramps.length} movement-ramp convex hulls are approximated here by
 * ${SLABS} stacked step slabs each; the remaining solid hulls use their AABB.
 */
import type { ColliderBox } from "./MapColliders";

export const YARD_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (${cuboidLines.length}) ----
${cuboidLines.join("\n")}
  // ---- Movement ramps as step slabs (${rampLines.length}) ----
${rampLines.join("\n")}
  // ---- Solid convex hulls as AABBs (${hullLines.length}) ----
${hullLines.join("\n")}
];

/** Axis-aligned danger volume (feet position inside = hazard triggers). */
export interface HazardZone {
  id: string;
  type: string;
  min: [number, number, number];
  max: [number, number, number];
  /** Suggested FEET respawn position next to the hazard (metadata). */
  respawnFeet: [number, number, number];
}

/** Acid pool(s) — the SERVER validates these independently of rendering. */
export const YARD_HAZARD_ZONES: HazardZone[] = [
${hazardEntries.join("\n")}
];
`;

// ---- Spawns (capsule centers + yaw, straight from the export) ----
const spawnLines = data.spawns.map(
  (s) =>
    `  { x: ${r3(s.position[0])}, y: ${r3(s.position[1])}, z: ${r3(s.position[2])}, yaw: ${s.yaw} }, // ${s.id}`,
);

const spawnsTs = `/**
 * SHARED YARD 01 Expanded spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Yard/yard_01.physics.json
 * by scripts/generate-yard-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included — the export's "position", NOT the
 * "feet" field). yaw is in radians (0 = facing -Z). Used by the frontend
 * SpawnManager AND the backend RespawnManager so both sides always agree.
 */
import type { MapSpawnPoint } from "./MapSpawns";

export const YARD_SPAWN_POINTS: MapSpawnPoint[] = [
${spawnLines.join("\n")}
];
`;

writeFileSync(join(root, "shared/map/YardColliders.ts"), collidersTs);
writeFileSync(join(root, "shared/map/YardSpawns.ts"), spawnsTs);
console.log(
  `YardColliders.ts: ${cuboidLines.length} cuboids + ${rampLines.length} ramp slabs + ${hullLines.length} hull AABBs`,
);
console.log(`YardSpawns.ts: ${data.spawns.length} spawns, ${hazardEntries.length} hazard zone(s)`);
