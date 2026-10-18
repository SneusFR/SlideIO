import type * as THREE from "three";

/**
 * PERF: an InstancedMesh whose `count` is 0 still costs a full draw setup
 * every frame — program switch, every material uniform, VAO bind — before
 * drawing nothing (three.js only skips the GL draw itself). The VFX pools
 * (popcorn kernels, paint jets / drops / splats, water jets, footprints)
 * are empty most of the time: ties `visible` to the instance count so an
 * empty pool leaves the render list. Call once at creation; the owner keeps
 * writing `mesh.count` exactly as before.
 */
export function hideWhenEmpty<T extends THREE.InstancedMesh>(mesh: T): T {
  let count = mesh.count;
  Object.defineProperty(mesh, "count", {
    configurable: true,
    enumerable: true,
    get: () => count,
    set: (value: number) => {
      count = value;
      mesh.visible = value > 0;
    },
  });
  mesh.visible = count > 0;
  return mesh;
}
