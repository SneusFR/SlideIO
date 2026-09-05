/**
 * Generates the SHARED map data files from the Ancient Jungle City
 * physics export (src/assets/MAP/ancient_jungle_city.physics.json):
 *
 *   shared/map/MapColliders.ts — AABB list for the backend hitscan
 *     (cuboids passed through; convex-hull ramps approximated by
 *      6 stacked step slabs each so shots skim slopes correctly)
 *   shared/map/MapSpawns.ts    — the 8 spawn points (capsule centers)
 *
 * Run after every map re-export:  node scripts/generate-map-colliders.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(
  readFileSync(join(root, "src/assets/MAP/ancient_jungle_city.physics.json"), "utf8"),
);

const r3 = (n) => Math.round(n * 1000) / 1000;
const fmtBox = (b) => `  [${b.join(", ")}],`;

// ---- Cuboids: [cx, cy, cz, sizeX, sizeY, sizeZ] (full sizes) ----
const cuboidLines = [];
for (const c of data.colliders) {
  if (c.type !== "cuboid") continue;
  cuboidLines.push(
    fmtBox([
      r3(c.position[0]),
      r3(c.position[1]),
      r3(c.position[2]),
      r3(c.halfExtents[0] * 2),
      r3(c.halfExtents[1] * 2),
      r3(c.halfExtents[2] * 2),
    ]) + ` // ${c.id}`,
  );
}

// ---- Ramps (convex hulls): approximated by stacked step slabs ----
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

const collidersTs = `/**
 * SHARED map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/ancient_jungle_city.physics.json
 * by scripts/generate-map-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes). The frontend
 * builds its Rapier world from the exact physics JSON (cuboids + convex
 * hulls, see src/world/JungleMap.ts); the backend raycasts THIS list so
 * walls occlude shots.
 *
 * NOTE: the ${data.ramps.length} convex-hull stair ramps are approximated here by
 * ${SLABS} stacked step slabs each — close enough for bullet occlusion.
 */
export type ColliderBox = [number, number, number, number, number, number];

export const MAP_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (${cuboidLines.length}) ----
${cuboidLines.join("\n")}
  // ---- Stair ramps as step slabs (${rampLines.length}) ----
${rampLines.join("\n")}
];
`;

// ---- Spawns (capsule centers + yaw, straight from the export) ----
const spawnLines = data.spawns.map(
  (s) =>
    `  { x: ${r3(s.position[0])}, y: ${r3(s.position[1])}, z: ${r3(s.position[2])}, yaw: ${s.yaw} }, // ${s.id}`,
);

const spawnsTs = `/**
 * SHARED spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/ancient_jungle_city.physics.json
 * by scripts/generate-map-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included). yaw is in radians (0 = facing -Z).
 * Used by the frontend SpawnManager AND the backend RespawnManager so
 * both sides always agree on where players can appear.
 */
export interface MapSpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const MAP_SPAWN_POINTS: MapSpawnPoint[] = [
${spawnLines.join("\n")}
];
`;

writeFileSync(join(root, "shared/map/MapColliders.ts"), collidersTs);
writeFileSync(join(root, "shared/map/MapSpawns.ts"), spawnsTs);
console.log(
  `MapColliders.ts: ${cuboidLines.length} cuboids + ${rampLines.length} ramp slabs`,
);
console.log(`MapSpawns.ts: ${data.spawns.length} spawns`);
