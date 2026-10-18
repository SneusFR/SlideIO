import * as THREE from "three";

/**
 * PERF — skip the renderer's REDUNDANT scene-graph pass over subtrees that
 * are already final for the frame.
 *
 * Every frame updates the world matrices twice: once explicitly after the
 * simulation (Game.frame — bots, corpses and props must be exact for the
 * weapon raycasts), then again inside `renderer.render()`. Between the two,
 * nothing moves a bot or a corpse (weapon logic, visibility, billboards and
 * the camera only touch materials, instanced buffers, world-space FX and
 * the camera) — the second pass recomputed ~70 node matrices per bot and
 * ~40 per corpse for nothing.
 *
 * A subtree root opted in with `skipFreshMatrixUpdate` ignores ONE
 * non-forced `updateMatrixWorld()` after `markMatrixFresh` — the renderer's
 * pass. Anything else stays exact: a forced update (an ancestor moved)
 * always runs, and an unmarked root behaves exactly like three.js.
 */
const fresh = new WeakSet<THREE.Object3D>();

export function skipFreshMatrixUpdate(root: THREE.Object3D): void {
  root.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean): void {
    if (!force && fresh.delete(this)) return;
    fresh.delete(this);
    THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
  };
}

/** The subtree's world matrices were just computed and stay final until the render. */
export function markMatrixFresh(root: THREE.Object3D): void {
  fresh.add(root);
}
