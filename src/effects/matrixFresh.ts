import * as THREE from "three";
import { optSwitch } from "../ui/perfDiag";

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
 * ~40 per corpse for nothing. Same for the map (its animated décor — 140
 * nodes recomposed at each pass — is driven by its mixer before the first
 * pass, and nothing writes a map node after it: `markFrozenMapsFresh`), and
 * for the first-person arms + weapon under the FP camera, which
 * `ViewmodelSystem.syncCamera` computes (forced) right before the FP render
 * pass recomputed them all once more.
 *
 * A dead bot waiting for its respawn does not change at all for seconds
 * (hidden, nothing animates or moves it — Bot.postStep): it is marked
 * BEFORE the frame's explicit pass, which then skips it as well — its
 * matrices are the ones the previous frames computed.
 *
 * A subtree root opted in with `skipFreshMatrixUpdate` ignores ONE
 * non-forced `updateMatrixWorld()` after `markMatrixFresh` — the renderer's
 * pass. Anything else stays exact: a forced update (an ancestor moved)
 * always runs, an unmarked root behaves exactly like three.js, and a mark
 * never outlives the task that set it (the game frame: cleared in a
 * microtask, e.g. after a frame that did not render).
 * `?diag=nofreshskip`: the map, the FP arms and the dead bots are
 * recomputed as before (the render-pass skip of the bots and corpses
 * predates the switch and stays).
 */
const fresh = new Set<THREE.Object3D>();
let clearQueued = false;
const clearMarks = (): void => {
  clearQueued = false;
  // (a rendered frame consumed every mark: nothing to clear — `clear` allocates a new table)
  if (fresh.size !== 0) fresh.clear();
};

/** Marks for the map, the FP arms and dead bots (`?diag=nofreshskip`: off; DEV: `__cpuOpt.freshskip`). */
export const freshSkip = optSwitch("freshskip");

export function skipFreshMatrixUpdate(root: THREE.Object3D): void {
  // The object's own method (a camera keeps its matrixWorldInverse update).
  const update = root.updateMatrixWorld;
  root.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean): void {
    if (fresh.delete(this) && !force) return;
    update.call(this, force);
  };
}

/** The subtree's world matrices were just computed and stay final until the render. */
export function markMatrixFresh(root: THREE.Object3D): void {
  fresh.add(root);
  if (!clearQueued) {
    clearQueued = true;
    queueMicrotask(clearMarks);
  }
}

/**
 * Static map roots (frozen by `MapBatching.freezeStaticTransforms`, animated décor inside).
 * A map lives as long as the page (changing map reloads it): kept here for good.
 */
const frozenMaps: THREE.Object3D[] = [];

/** A frozen map root: may skip the renderer's pass once marked (`markFrozenMapsFresh`). */
export function registerFrozenMap(root: THREE.Object3D): void {
  if (frozenMaps.includes(root)) return;
  skipFreshMatrixUpdate(root);
  frozenMaps.push(root);
}

/**
 * Right after the frame's explicit scene pass (Game.frame): the maps' matrices
 * are final until the render — their mixer ran before, nothing writes them after.
 */
export function markFrozenMapsFresh(): void {
  if (!freshSkip.on) return;
  for (const root of frozenMaps) if (root.parent) markMatrixFresh(root);
}
