/**
 * Runtime smoke test for the three-mesh-bvh integration (perf fix for
 * bot/beam raycasts on Ancient Jungle City):
 *   1. BVH mesh + firstHitOnly still returns the correct NEAREST hit.
 *   2. A non-BVH mesh (bot model / player proxy) placed in front of a BVH
 *      wall is still returned FIRST by intersectObjects (sorted), so the
 *      castBeam owner/corpse skipping keeps working.
 *   3. BVH raycast is measurably faster than brute force on dense geometry.
 *
 * Run: node scripts/test-bvh-raycast.mjs
 */
import * as THREE from "three";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";

// Same prototype wiring as src/world/JungleMap.ts.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// Dense "map wall" at z = -10 (high subdivision ≈ heavy map batch).
const wallGeo = new THREE.PlaneGeometry(40, 40, 400, 400);
const wall = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial());
wall.position.set(0, 0, -10);
wall.updateMatrixWorld(true);

// "Bot capsule" (NO BVH) between the shooter and the wall, at z = -5.
const botGeo = new THREE.SphereGeometry(0.5, 12, 8);
const bot = new THREE.Mesh(botGeo, new THREE.MeshBasicMaterial());
bot.position.set(0, 0, -5);
bot.updateMatrixWorld(true);

const raycaster = new THREE.Raycaster();
const origin = new THREE.Vector3(0, 0, 0);
const dir = new THREE.Vector3(0, 0, -1);

// ---- 1. Brute-force reference (before BVH) ----
raycaster.set(origin, dir);
raycaster.far = 160; // wc.beamRange
const before = raycaster.intersectObjects([wall, bot], true);
check(
  "brute-force reference: nearest hit is the bot at ~4.5 m",
  before.length >= 2 && Math.abs(before[0].distance - 4.5) < 1e-6,
);

// ---- 2. BVH on the wall + firstHitOnly (the new code path) ----
wall.geometry.computeBoundsTree();
raycaster.firstHitOnly = true;
raycaster.set(origin, dir);
const after = raycaster.intersectObjects([wall, bot], true);
check(
  "BVH + firstHitOnly: non-BVH bot still sorted FIRST (owner skip works)",
  after.length >= 2 && Math.abs(after[0].distance - 4.5) < 1e-6,
);
check(
  "BVH + firstHitOnly: wall hit distance identical (10 m)",
  after.some((h) => h.object === wall && Math.abs(h.distance - 10) < 1e-6),
);
check(
  "BVH + firstHitOnly: wall reports exactly ONE hit",
  after.filter((h) => h.object === wall).length === 1,
);
check(
  "face normal still available for beam impact VFX",
  after[0].face !== null && after.find((h) => h.object === wall)?.face !== null,
);

// ---- 3. Micro-benchmark: wall-only raycast, BVH vs brute force ----
const N = 2000;
const bench = () => {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    raycaster.set(origin, dir);
    raycaster.intersectObjects([wall], true);
  }
  return performance.now() - t0;
};
const bvhMs = bench();
wall.geometry.disposeBoundsTree();
raycaster.firstHitOnly = false;
const bruteMs = bench();
console.log(
  `bench (${N} rays vs 320k-tri wall): brute ${bruteMs.toFixed(0)} ms → BVH ${bvhMs.toFixed(0)} ms (×${(bruteMs / bvhMs).toFixed(1)})`,
);
check("BVH raycast is faster than brute force", bvhMs < bruteMs);

process.exit(failures === 0 ? 0 : 1);
