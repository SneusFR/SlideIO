import * as THREE from "three";

/**
 * PERF (render submission): ONE skeleton update per skeleton per frame.
 *
 * three.js rebuilds a skinned mesh's bone matrices and flags its bone texture
 * for re-upload once per `renderer.info.render.frame` — but that counter
 * advances at EVERY renderer.render() call, and once more inside each call,
 * between the scene projection and the shadow pass. A game frame on Givre is
 * several renders (world + its live shadow pass, the outline normal
 * pre-pass, FP overlay, FP outline pre-pass): every skeleton was rebuilt and
 * its bone texture uploaded TWICE per frame, from the same bones (the shadow
 * pass or the outline pre-pass came back to it).
 *
 * Inside a frame scope (`inSkeletonFrame` around the renders of one frame —
 * every bone is final by then) a skeleton is updated the first time three
 * asks, and the later requests of the same frame are skipped: same bone
 * matrices, same texture content, identical pixels. Outside a scope (warm-up
 * renders, captures, tools) three's own behaviour is untouched.
 */
const update = THREE.Skeleton.prototype.update;
let frameId = 0;
let inFrame = false;

type Stamped = THREE.Skeleton & { __skelFrame?: number };

THREE.Skeleton.prototype.update = function (this: Stamped): void {
  if (inFrame) {
    if (this.__skelFrame === frameId) return;
    this.__skelFrame = frameId;
  }
  update.call(this);
};

/** Runs the renders of ONE frame (bones final) with one update per skeleton. */
export function inSkeletonFrame(render: () => void): void {
  if (inFrame) {
    render(); // nested: the outer scope already dedupes
    return;
  }
  frameId++;
  inFrame = true;
  try {
    render();
  } finally {
    inFrame = false;
  }
}
