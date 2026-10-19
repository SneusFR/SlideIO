import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

/**
 * Raycast BVHs of the map meshes (three-mesh-bvh) — built OUTSIDE the
 * loading screen.
 *
 * The stock Raycaster tests every triangle of a mesh — catastrophic on the
 * 120-250k-triangle maps where every beam / shot raycasts the map, hence one
 * BVH per map mesh (`acceleratedRaycast` uses it, falls back to the stock
 * raycast for meshes without one: characters, proxies, targets).
 *
 * PERF (loading): those BVHs used to be built while the loading screen was
 * up (≈ 0.1 s on Givre). Nothing raycasts the map before play — the menu
 * only renders it — so they are QUEUED at load (queueMapBvh), built one per
 * idle slot of the menu's frames (buildMapBvhsWhenIdle), the rest at the
 * latest when play starts (flushMapBvhs). A raycast meeting a mesh whose BVH
 * is still queued builds it first: the same BVH, the same hits — never a
 * brute-force raycast against the map.
 *
 * Building a BVH reorders the geometry's index in place (triangle order
 * only); once the geometry may already be on the GPU, its index is flagged
 * for re-upload so the GPU draws the same order as before (BVH order).
 */
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const pending = new Set<THREE.BufferGeometry>();

THREE.Mesh.prototype.raycast = function (
  this: THREE.Mesh,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[],
): void {
  if (pending.size > 0 && pending.has(this.geometry)) build(this.geometry);
  acceleratedRaycast.call(this, raycaster, intersects);
};

function build(geometry: THREE.BufferGeometry): void {
  if (!pending.delete(geometry)) return;
  geometry.computeBoundsTree();
  if (geometry.index) geometry.index.needsUpdate = true;
}

/** Map mesh geometry: its BVH will be built after the loading screen. */
export function queueMapBvh(geometry: THREE.BufferGeometry): void {
  pending.add(geometry);
}

/** Every queued BVH, now (play starts). */
export function flushMapBvhs(): void {
  for (const geometry of [...pending]) build(geometry);
}

let idleRunning = false;

/** Builds the queued BVHs one per idle slot of the page (menu up). */
export function buildMapBvhsWhenIdle(): void {
  if (idleRunning) return;
  idleRunning = true;
  const schedule = (): void => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(step, { timeout: 500 });
    else setTimeout(step, 16);
  };
  const step = (): void => {
    const next = pending.values().next();
    if (next.done) {
      idleRunning = false;
      return;
    }
    build(next.value);
    schedule();
  };
  schedule();
}
