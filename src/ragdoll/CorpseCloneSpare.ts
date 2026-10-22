import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { shareOutlineSkeletons, stripEnemyOutline } from "../characters/PotatoCharacter";
import { adoptSkinnedBounds } from "../effects/skinnedBounds";
import { isRigidPartsBatch } from "../effects/RigidPartsBatch";
import { prepareBoneTexture } from "../effects/KillPrep";

/**
 * The corpse copy of a living character model: an independent
 * SkeletonUtils clone (own bones and skeletons, shared geometries and
 * materials) without the red enemy contour, one shared skeleton, bounds
 * ready for its first draw. Reference path of every corpse.
 */
export function cloneCorpseModel(model: THREE.Object3D): THREE.Object3D {
  const clone = skeletonClone(model);
  // A dead body is no longer a threat: the red enemy contour dies with it
  // (also keeps the shared outline material out of the CorpseManager's
  // fade clones).
  stripEnemyOutline(clone);
  shareOutlineSkeletons(clone); // one skeleton for the whole corpse
  // PERF: a skinned piece the living character never drew (weapon picked
  // up at the respawn, off screen until death) has no sphere yet — the
  // corpse's first frame would CPU-skin it in full (adoptSkinnedBounds).
  adoptSkinnedBounds(clone);
  return clone;
}

/**
 * Node classes whose `copy(source, false)` the spare relies on (see take)
 * — plus the weapons' rigid-part batches (a SkinnedMesh whose bind() only
 * tags its skeleton). Any other class: no spare, the corpse is cloned.
 */
const SUPPORTED = new Set<unknown>([
  THREE.Object3D,
  THREE.Group,
  THREE.Bone,
  THREE.Mesh,
  THREE.SkinnedMesh,
  THREE.InstancedMesh,
  THREE.Line,
  THREE.LineSegments,
  THREE.LineLoop,
  THREE.Points,
  THREE.Sprite,
]);

interface SparePair {
  spare: THREE.Object3D;
  live: THREE.Object3D;
  /** Parent of `live` when the spare was built (tree shape check). */
  liveParent: THREE.Object3D | null;
  children: number;
}

interface SpareSkin {
  spare: THREE.SkinnedMesh;
  /** The spare's own skeleton (after shareOutlineSkeletons). */
  skeleton: THREE.Skeleton;
  live: THREE.SkinnedMesh;
  liveSkeleton: THREE.Skeleton;
  liveBones: THREE.Bone[];
  liveInverses: THREE.Matrix4[];
}

/**
 * PERF — the corpse clone, built OUTSIDE the kill frame.
 *
 * Cloning a whole character (~100 nodes: bones, skinned pieces, weapon)
 * at the moment of death allocated every node, matrix and skeleton in
 * the frame that already pays the kill feedback, the ragdoll and the
 * particles. A spare clone is built ahead of time (`prepare`, on a calm
 * frame of the character's life); at death `take` only brings it to the
 * live model's CURRENT state: every node gets `copy(live, false)` — the
 * very copy SkeletonUtils.clone runs, minus the allocations — then the
 * skeletons are re-bound exactly as the clone path binds them. The result
 * is the clone `cloneCorpseModel` would return at that instant
 * (scripts/test-corpse-spare.mts compares them property by property).
 *
 * The spare is only used while the live model has EXACTLY the shape it
 * had when the spare was built (same nodes, same parents, same skeletons,
 * supported node classes only); anything else (weapon swapped, outfit
 * changed…) and `take` returns null: the caller clones as before.
 *
 * KILLPREP (effects/KillPrep.ts): the spare's skeletons may get their bone
 * textures ahead (prepareBoneTextures) — handed over with the corpse
 * (CorpseManager disposes its skeletons), disposed with a spare that is
 * dropped instead.
 */
export class CorpseCloneSpare {
  private clone: THREE.Object3D | null = null;
  private source: THREE.Object3D | null = null;
  private pairs: SparePair[] = [];
  private skins: SpareSkin[] = [];

  get ready(): boolean {
    return this.clone !== null;
  }

  /**
   * KILLPREP: the bone texture of each skeleton of the spare, created and
   * uploaded now (three does it at the corpse's first draw otherwise).
   * The kill frame's skeleton update rewrites every matrix of it before
   * that first draw uploads it again — same texture content. Returns the
   * number of textures created.
   */
  prepareBoneTextures(renderer: THREE.WebGLRenderer): number {
    let made = 0;
    for (const skin of this.skins) if (prepareBoneTexture(skin.skeleton, renderer)) made++;
    return made;
  }

  /**
   * KILLPREP: the spare showing what `take` will copy onto it from the live
   * model — materials, geometries, visibility (paint and outfits swap
   * them during a life) — or null without a spare. `take` copies them
   * again: nothing else of the spare changes.
   */
  showLiveSurfaces(): THREE.Object3D | null {
    if (!this.clone) return null;
    for (const { spare, live } of this.pairs) {
      spare.visible = live.visible;
      const drawable = spare as THREE.Mesh;
      if (drawable.material !== undefined) {
        drawable.material = (live as THREE.Mesh).material;
        drawable.geometry = (live as THREE.Mesh).geometry;
      }
    }
    return this.clone;
  }

  /** Build the spare for `model` now (a fresh clone, kept off-scene). */
  prepare(model: THREE.Object3D): void {
    this.reset();
    let supported = true;
    model.traverse((o) => {
      if (!SUPPORTED.has(o.constructor) && !isRigidPartsBatch(o)) supported = false;
    });
    if (!supported) return;
    const clone = skeletonClone(model);
    const liveOf = new Map<THREE.Object3D, THREE.Object3D>();
    parallelTraverse(model, clone, (live, spare) => liveOf.set(spare, live));
    stripEnemyOutline(clone);
    shareOutlineSkeletons(clone);
    adoptSkinnedBounds(clone);
    const pairs: SparePair[] = [];
    const skins: SpareSkin[] = [];
    clone.traverse((spare) => {
      const live = liveOf.get(spare)!;
      pairs.push({ spare, live, liveParent: live.parent, children: spare.children.length });
      const sm = spare as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton) {
        const lm = live as THREE.SkinnedMesh;
        skins.push({
          spare: sm,
          skeleton: sm.skeleton,
          live: lm,
          liveSkeleton: lm.skeleton,
          liveBones: lm.skeleton.bones.slice(),
          liveInverses: lm.skeleton.boneInverses,
        });
      }
    });
    this.clone = clone;
    this.source = model;
    this.pairs = pairs;
    this.skins = skins;
  }

  /** Is the spare still the right shape for `model` (no change since prepare)? */
  matches(model: THREE.Object3D): boolean {
    if (!this.clone || this.source !== model) return false;
    const pairs = this.pairs;
    let i = 0;
    const walk = (node: THREE.Object3D, parent: THREE.Object3D | null): boolean => {
      // Outline hulls (and their subtrees) are stripped from every corpse.
      if (node.userData.enemyOutline) return true;
      const pair = pairs[i++];
      if (!pair || pair.live !== node || pair.liveParent !== parent) return false;
      for (const child of node.children) if (!walk(child, node)) return false;
      return true;
    };
    if (!walk(model, model.parent) || i !== pairs.length) return false;
    for (const skin of this.skins) {
      const skeleton = skin.live.skeleton;
      if (skeleton !== skin.liveSkeleton || skeleton.boneInverses !== skin.liveInverses) return false;
      const bones = skeleton.bones;
      if (bones.length !== skin.liveBones.length) return false;
      for (let b = 0; b < bones.length; b++) if (bones[b] !== skin.liveBones[b]) return false;
    }
    return true;
  }

  /**
   * The spare, brought to `model`'s current state — or null (no spare, or
   * the model changed shape since prepare: clone it instead). Consumed:
   * the caller owns the returned object.
   */
  take(model: THREE.Object3D): THREE.Object3D | null {
    const clone = this.clone;
    if (!clone || !this.matches(model)) {
      this.reset();
      return null;
    }
    for (const { spare, live } of this.pairs) {
      // Constructor state of what copy() only writes when the source has it.
      const bounded = spare as unknown as { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; boundingBox: unknown; boundingSphere: unknown; instanceColor: unknown; morphTexture: unknown };
      if (bounded.isSkinnedMesh || bounded.isInstancedMesh) {
        bounded.boundingBox = null;
        bounded.boundingSphere = null;
      }
      if (bounded.isInstancedMesh) {
        bounded.instanceColor = null;
        bounded.morphTexture = null;
      }
      spare.copy(live, false);
    }
    for (const skin of this.skins) skin.spare.bind(skin.skeleton, skin.spare.bindMatrix);
    adoptSkinnedBounds(clone);
    let intact = true;
    for (const pair of this.pairs) if (pair.spare.children.length !== pair.children) intact = false;
    if (!intact) {
      this.reset();
      return null;
    }
    this.forget(); // handed over: its skeletons (and bone textures) are the corpse's now
    return clone;
  }

  /** Drop the spare (its prepared bone textures with it). */
  reset(): void {
    for (const skin of this.skins) {
      // (only KILLPREP creates one on a spare: free when there is none)
      if (skin.skeleton.boneTexture !== null) skin.skeleton.dispose();
    }
    this.forget();
  }

  private forget(): void {
    this.clone = null;
    this.source = null;
    this.pairs = [];
    this.skins = [];
  }
}

/** Same walk as SkeletonUtils' parallelTraverse (identical trees). */
function parallelTraverse(
  a: THREE.Object3D,
  b: THREE.Object3D,
  callback: (a: THREE.Object3D, b: THREE.Object3D) => void,
): void {
  callback(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], callback);
}
