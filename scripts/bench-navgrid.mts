// NAVGRID - headless benchmark + equivalence check on the REAL map colliders
// (same Rapier collider descriptors as JungleMap / YardMap / GivreMap).
//   1. the shipped NavGrid (region labels + binary heap) is compared to the
//      PREVIOUS implementation (linear open-set scan, no region check) on the
//      same random roam requests: every reachable request must give the SAME
//      optimal A* cost, every unreachable one must still fail;
//   2. pickRoamGoal must only return reachable goals;
//   3. timings (avg / p95 / worst) are printed for both implementations.
// Usage (repo root):  npx --prefix backend tsx scripts/bench-navgrid.mts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PhysicsWorld, CollisionGroups } from "../src/physics/PhysicsWorld";
import {
  NavGrid,
  type NavGridBounds,
  JUNGLE_NAV_BOUNDS,
  YARD_NAV_BOUNDS,
  GIVRE_NAV_BOUNDS,
} from "../src/navigation/NavGrid";

interface ColliderEntry {
  id?: string;
  type: string;
  position?: number[];
  halfExtents?: number[];
  rotation?: number[];
  vertices?: number[][];
}

const MAPS: { name: string; file: string; bounds: NavGridBounds }[] = [
  { name: "JUNGLE", file: "src/assets/MAP/ancient_jungle_city.physics.json", bounds: JUNGLE_NAV_BOUNDS },
  { name: "YARD", file: "src/assets/MAP/Yard/yard_01.physics.json", bounds: YARD_NAV_BOUNDS },
  { name: "GIVRE", file: "src/assets/MAP/Givre/givre_01.physics.json", bounds: GIVRE_NAV_BOUNDS },
];

function addCollider(physics: PhysicsWorld, c: ColliderEntry, groups?: number): void {
  if (c.type === "cuboid" && c.position && c.halfExtents) {
    const [qx, qy, qz, qw] = c.rotation ?? [0, 0, 0, 1];
    physics.addStaticBox(
      c.position[0], c.position[1], c.position[2],
      c.halfExtents[0] * 2, c.halfExtents[1] * 2, c.halfExtents[2] * 2,
      { x: qx, y: qy, z: qz, w: qw },
      groups !== undefined ? { collisionGroups: groups } : undefined,
    );
  } else if (c.type === "convexHull" && c.vertices) {
    const col = physics.addStaticConvexHull(new Float32Array(c.vertices.flat()));
    if (col && groups !== undefined) col.setCollisionGroups(groups);
  }
}

/** The PREVIOUS findPath core (linear open-set scan): optimal cost or null. */
function legacyCost(nav: NavGrid, from: THREE.Vector3, to: THREE.Vector3): number | null {
  const n = nav as unknown as {
    nx: number; nz: number; walkable: Uint8Array; groundY: Float32Array;
    nearestCell(x: number, z: number): number;
  };
  const start = n.nearestCell(from.x, from.z);
  const goal = n.nearestCell(to.x, to.z);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return 0;
  const size = n.nx * n.nz;
  const g = new Float32Array(size);
  const state = new Uint8Array(size);
  const open: number[] = [start];
  state[start] = 1;
  const gi = goal % n.nx;
  const gj = Math.floor(goal / n.nx);
  let it = 0;
  while (open.length > 0 && it < 20000) {
    it++;
    let best = 0;
    let bestF = Infinity;
    for (let k = 0; k < open.length; k++) {
      const id = open[k];
      const f = g[id] + Math.hypot((id % n.nx) - gi, Math.floor(id / n.nx) - gj);
      if (f < bestF) { bestF = f; best = k; }
    }
    const cur = open[best];
    open[best] = open[open.length - 1];
    open.pop();
    if (cur === goal) return g[cur];
    state[cur] = 2;
    const ci = cur % n.nx;
    const cj = Math.floor(cur / n.nx);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n.nx || nj >= n.nz) continue;
        const nid = nj * n.nx + ni;
        if (!n.walkable[nid] || state[nid] === 2) continue;
        if (Math.abs(n.groundY[nid] - n.groundY[cur]) > 0.8) continue;
        if (di !== 0 && dj !== 0) {
          if (!n.walkable[cj * n.nx + ci + di]) continue;
          if (!n.walkable[(cj + dj) * n.nx + ci]) continue;
        }
        const cost = g[cur] + (di !== 0 && dj !== 0 ? 1.4142 : 1);
        if (state[nid] === 1 && cost >= g[nid]) continue;
        g[nid] = cost;
        if (state[nid] !== 1) { state[nid] = 1; open.push(nid); }
      }
    }
  }
  return null;
}

/** Optimal cost of the NEW A* (same core as findPath, smoothing excluded). */
function newCost(nav: NavGrid, from: THREE.Vector3, to: THREE.Vector3): number | null {
  const path: THREE.Vector3[] = [];
  if (nav.findPath(from, to, path) === 0) return null;
  const n = nav as unknown as { gScore: Float32Array; nearestCell(x: number, z: number): number };
  const goal = n.nearestCell(to.x, to.z);
  const start = n.nearestCell(from.x, from.z);
  return start === goal ? 0 : n.gScore[goal];
}

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const avg = s.reduce((p, c) => p + c, 0) / Math.max(1, s.length);
  return { avg, p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s[s.length - 1] ?? 0 };
};
const fmt = (v: { avg: number; p95: number; max: number }) =>
  `avg ${v.avg.toFixed(2)} ms  p95 ${v.p95.toFixed(2)} ms  worst ${v.max.toFixed(2)} ms`;

let failures = 0;
for (const map of MAPS) {
  const data = JSON.parse(readFileSync(map.file, "utf8")) as { colliders: ColliderEntry[]; playerClips?: ColliderEntry[] };
  const physics = await PhysicsWorld.create();
  for (const c of data.colliders) addCollider(physics, c);
  for (const c of data.playerClips ?? []) addCollider(physics, c, CollisionGroups.PLAYER_CLIP);
  physics.refreshQueries();
  const t0 = performance.now();
  const nav = new NavGrid(physics, map.bounds);
  const buildMs = performance.now() - t0;

  // Deterministic random roam requests (same generator as pickRoamGoal, but
  // goals are NOT filtered by region so unreachable requests are exercised).
  let seed = 1234;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = nav as unknown as { nx: number; nz: number; walkable: Uint8Array; groundY: Float32Array; region: Int32Array };
  const cellPos = (id: number) => {
    const i = id % n.nx;
    const j = (id - i) / n.nx;
    return new THREE.Vector3(map.bounds.minX + i * 1.5, n.groundY[id] + 1, map.bounds.minZ + j * 1.5);
  };
  const walk: number[] = [];
  for (let i = 0; i < n.walkable.length; i++) if (n.walkable[i]) walk.push(i);

  const N = 150;
  const oldT: number[] = [];
  const newT: number[] = [];
  let reachable = 0;
  let unreachable = 0;
  for (let k = 0; k < N; k++) {
    const from = cellPos(walk[Math.floor(rnd() * walk.length)]);
    const to = cellPos(walk[Math.floor(rnd() * walk.length)]);
    let t = performance.now();
    const a = legacyCost(nav, from, to);
    oldT.push(performance.now() - t);
    t = performance.now();
    const b = newCost(nav, from, to);
    newT.push(performance.now() - t);
    if (a === null) {
      unreachable++;
      if (b !== null) { failures++; console.error(`FAIL ${map.name}: new A* found a path the old one could not`); }
    } else {
      reachable++;
      if (b === null || Math.abs(a - b) > 1e-3) {
        failures++;
        console.error(`FAIL ${map.name}: cost mismatch old=${a} new=${b}`);
      }
    }
  }

  // pickRoamGoal never returns an unreachable goal.
  const out = new THREE.Vector3();
  let picks = 0;
  for (let k = 0; k < 200; k++) {
    const from = cellPos(walk[Math.floor(rnd() * walk.length)]);
    if (!nav.pickRoamGoal(from, 12, out)) continue;
    picks++;
    if (!nav.isReachable(from, out)) { failures++; console.error(`FAIL ${map.name}: pickRoamGoal returned an unreachable goal`); }
  }

  const regions = new Set<number>();
  for (const r of n.region) if (r >= 0) regions.add(r);
  console.log(`${map.name.padEnd(6)} grid ${n.nx}x${n.nz}  build ${buildMs.toFixed(0)} ms  regions ${regions.size}  requests ${reachable} reachable / ${unreachable} unreachable  roam picks ${picks}`);
  console.log(`       BEFORE: ${fmt(stats(oldT))}`);
  console.log(`       AFTER : ${fmt(stats(newT))}  (smoothing included)`);
}

assert.equal(failures, 0, `${failures} navgrid check(s) failed`);
console.log("NAVGRID BENCH PASSED (identical optimal paths, unreachable goals rejected)");
