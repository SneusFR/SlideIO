import * as THREE from "three";

/**
 * Margin applied to a bind-pose sphere so it still contains the animated
 * mesh (same value as the characters' culling bounds, PotatoCharacter).
 */
const SKINNED_BOUNDS_MARGIN = 2.5;

/**
 * PERF — three.js orders (and, when `frustumCulled`, culls) a SkinnedMesh
 * with its OWN `boundingSphere`. Left null, WebGLRenderer.projectObject
 * computes it at the FIRST draw of every instance with a full CPU skinning
 * pass over all its vertices — even when the mesh is never frustum-culled
 * (the sphere centre is the sort depth). On the Hex Sniper creature
 * (16 220 vertices) that was a 15–50 ms frame each time a new clone was
 * first drawn: a bot respawning with the sniper, the corpse of a bot that
 * died holding one before it had ever been drawn.
 *
 * Every SkinnedMesh under `root` that has no sphere gets the bind-pose
 * sphere of its geometry (computed once, without skinning), inflated like
 * the characters'. Call it on a TEMPLATE: SkinnedMesh.copy() clones the
 * sphere into every SkeletonUtils clone for free. Meshes that already have
 * one (characters, rigid-part batches) are left untouched.
 */
export function adoptSkinnedBounds(root: THREE.Object3D): void {
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || sm.boundingSphere) return;
    const geometry = sm.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingSphere) return;
    const sphere = geometry.boundingSphere.clone();
    sphere.radius *= SKINNED_BOUNDS_MARGIN;
    sm.boundingSphere = sphere;
  });
}
