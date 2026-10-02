/**
 * Converts the GIVRE 01 Blender export (format "givre.physics.v1",
 * src/assets/MAP/Givre/source/givre_01.source.physics.json) into the SAME
 * physics schema as YARD 01 (src/assets/MAP/Yard/yard_01.physics.json),
 * then derives the SHARED map data files from it:
 *
 *   src/assets/MAP/Givre/givre_01.physics.json — Yard-format physics
 *     (fixed cuboids = position + halfExtents, identity rotation; convex
 *      hulls = absolute world vertices; `ramps` start/end/width/slope;
 *      `spawns` feet/position/yaw; `expansion.mapEnvelope`; empty hazards)
 *     + Givre extras: `playerClips` (character-only blockers — they never
 *       stop shots), `killPlaneY`, `zones`, `viewpoints`, `lighting`,
 *       `materials`.
 *   shared/map/GivreColliders.ts — AABB list for the backend hitscan
 *     (cuboids as-is; the 3 movement-ramp hulls approximated by 6 stacked
 *      step slabs each from the `ramps` metadata; the remaining solid hulls
 *      by their vertex AABB). playerClips are NOT included: they must never
 *      occlude shots.
 *   shared/map/GivreSpawns.ts — the 8 spawn points (capsule centers + yaw).
 *
 * Never a trimesh: only fixed cuboids and convex hulls.
 *
 * Run after every map re-export:  node scripts/generate-givre-colliders.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "src/assets/MAP/Givre/source/givre_01.source.physics.json";
const OUTPUT = "src/assets/MAP/Givre/givre_01.physics.json";

const src = JSON.parse(readFileSync(join(root, SOURCE), "utf8"));
if (src.format !== "givre.physics.v1") {
  throw new Error(`unexpected source format: ${src.format}`);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const fmtBox = (b) => `  [${b.join(", ")}],`;
const IDENTITY = [0, 0, 0, 1];

// ---------------------------------------------------------------------------
// 1) Yard-format physics JSON
// ---------------------------------------------------------------------------
const rampColliderIds = new Set(src.ramps.map((r) => r.colliderId));

function toYardCollider(c, purpose) {
  if (c.shape === "box") {
    return {
      id: c.id,
      type: "cuboid",
      position: c.center.map(r3),
      halfExtents: c.halfExtents.map(r3),
      rotation: IDENTITY,
      purpose,
    };
  }
  if (c.shape === "convexHull") {
    if (!Array.isArray(c.points) || c.points.length < 4) {
      throw new Error(`convexHull ${c.id}: needs at least 4 points`);
    }
    return {
      id: c.id,
      type: "convexHull",
      vertices: c.points.map((p) => p.map(r3)),
      purpose,
    };
  }
  throw new Error(`unsupported collider shape "${c.shape}" (${c.id}) — trimesh is forbidden`);
}

const colliders = src.colliders.map((c) =>
  toYardCollider(c, rampColliderIds.has(c.id) ? "movement_ramp" : "solid"),
);
const playerClips = src.playerClips.map((c) => {
  if (c.shape !== "box") throw new Error(`playerClip ${c.id}: only boxes are supported`);
  return toYardCollider(c, "player_clip");
});

// Ramps: Yard's { start (low edge centre), end (high edge centre), width, slopeDegrees }.
const ramps = src.ramps.map((r) => ({
  id: r.id,
  colliderId: r.colliderId,
  start: r.lowCenter.map(r3),
  end: r.highCenter.map(r3),
  width: r3(r.width),
  slopeDegrees: r.slopeDeg,
}));

// Spawns: same convention as Yard (position = capsule centre, yaw =
// Object3D.rotation.y, 0 = facing −Z). `room` is kept as metadata.
const spawns = src.spawns.map((s) => ({
  id: s.id,
  feet: s.feet.map(r3),
  position: s.position.map(r3),
  yaw: s.yaw,
  room: s.room,
}));

const yardFormat = {
  formatVersion: 2,
  name: src.displayName,
  map: src.map,
  units: "metres",
  coordinateSystem:
    "right-handed Y-up; already converted from Blender (X,Z,-Y); north = -Z, east = +X",
  generatedFrom: SOURCE,
  player: {
    height: src.playerReference.capsuleHeight,
    capsuleRadius: src.playerReference.capsuleRadius,
    capsuleHalfHeight: src.playerReference.capsuleHalfHeight,
  },
  colliders,
  playerClips,
  ramps,
  spawns,
  floorY: src.floorY,
  upperLevelHeight: src.galleryY,
  killPlaneY: src.killPlaneY,
  expansion: {
    // Yard stores the envelope SIZE ([x, z]); Givre adds explicit XZ bounds.
    mapEnvelope: src.envelope.size,
    envelopeMin: src.envelope.min,
    envelopeMax: src.envelope.max,
  },
  hazards: [],
  zones: src.zones,
  viewpoints: src.viewpoints,
  lighting: src.lighting,
  materials: src.materials,
};
writeFileSync(join(root, OUTPUT), JSON.stringify(yardFormat, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 2) shared/map/GivreColliders.ts — backend hitscan AABBs
// ---------------------------------------------------------------------------
const cuboidLines = [];
for (const c of colliders) {
  if (c.type !== "cuboid") continue;
  cuboidLines.push(
    fmtBox([...c.position.map(r3), ...c.halfExtents.map((h) => r3(h * 2))]) + ` // ${c.id}`,
  );
}

// Movement ramps: 6 stacked step slabs each (same approximation as Yard).
const SLABS = 6;
const rampLines = [];
for (const ramp of ramps) {
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

// Remaining SOLID hulls (rails, central block, boiler pipes, traverse roof): vertex AABB.
const hullLines = [];
for (const c of colliders) {
  if (c.type !== "convexHull" || c.purpose === "movement_ramp") continue;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of c.vertices) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v[i]);
      max[i] = Math.max(max[i], v[i]);
    }
  }
  hullLines.push(
    fmtBox([
      r3((min[0] + max[0]) / 2),
      r3((min[1] + max[1]) / 2),
      r3((min[2] + max[2]) / 2),
      r3(max[0] - min[0]),
      r3(max[1] - min[1]),
      r3(max[2] - min[2]),
    ]) + ` // ${c.id} (hull AABB)`,
  );
}

const hullCount = colliders.length - cuboidLines.length;
const collidersTs = `/**
 * SHARED GIVRE 01 map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from ${OUTPUT}
 * by scripts/generate-givre-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes, world AABB). The
 * frontend builds its Rapier world from the exact physics JSON
 * (${cuboidLines.length} cuboids + ${hullCount} convex hulls + ${playerClips.length} player-only clips, see
 * src/world/GivreMap.ts); the backend raycasts THIS list so walls occlude
 * shots. The playerClips are deliberately ABSENT: they block characters
 * only, never shots.
 *
 * NOTE: the ${ramps.length} movement-ramp convex hulls are approximated here by
 * ${SLABS} stacked step slabs each; the remaining solid hulls use their AABB.
 */
import type { ColliderBox } from "./MapColliders";

export const GIVRE_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (${cuboidLines.length}) ----
${cuboidLines.join("\n")}
  // ---- Movement ramps as step slabs (${rampLines.length}) ----
${rampLines.join("\n")}
  // ---- Solid convex hulls as AABBs (${hullLines.length}) ----
${hullLines.join("\n")}
];
`;

// ---------------------------------------------------------------------------
// 3) shared/map/GivreSpawns.ts
// ---------------------------------------------------------------------------
const spawnLines = spawns.map(
  (s) =>
    `  { x: ${r3(s.position[0])}, y: ${r3(s.position[1])}, z: ${r3(s.position[2])}, yaw: ${s.yaw} }, // ${s.id} (${s.room})`,
);

const spawnsTs = `/**
 * SHARED GIVRE 01 spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from ${OUTPUT}
 * by scripts/generate-givre-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included — the export's "position", NOT the
 * "feet" field). yaw is in radians (Object3D.rotation.y, 0 = facing -Z);
 * each spawn faces the centre of its corner room. Used by the frontend
 * SpawnManager AND the backend RespawnManager so both sides always agree.
 */
import type { MapSpawnPoint } from "./MapSpawns";

export const GIVRE_SPAWN_POINTS: MapSpawnPoint[] = [
${spawnLines.join("\n")}
];
`;

writeFileSync(join(root, "shared/map/GivreColliders.ts"), collidersTs);
writeFileSync(join(root, "shared/map/GivreSpawns.ts"), spawnsTs);

console.log(
  `${OUTPUT}: ${cuboidLines.length} cuboids + ${hullCount} convex hulls + ${playerClips.length} playerClips, ${ramps.length} ramps, ${spawns.length} spawns`,
);
console.log(
  `GivreColliders.ts: ${cuboidLines.length} cuboids + ${rampLines.length} ramp slabs + ${hullLines.length} hull AABBs`,
);
console.log(`GivreSpawns.ts: ${spawns.length} spawns`);
