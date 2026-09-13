import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { markEnemyOutlineOccluder } from "../../characters/PotatoCharacter";
import { GoofyBasketProfile, GOOFY_BALL, GOOFY_BALL_MOTION_URL, GOOFY_LOD1_URL } from "./GoofyBasketProfile";
import { GoofyBasketPresentation, type BasketCurveLibrary } from "./GoofyBasketPresentation";

/**
 * Shared, cached GoofyBasket assets:
 *   - the ball GLB (ONE mesh, THREE materials, ZERO textures — shape,
 *     colors, materials and UVs are preserved), loaded exactly once; every
 *     rendered ball is a plain clone sharing geometry + materials (detaching
 *     an instance never disposes a common resource);
 *   - the optional LOD1 (distant projectiles);
 *   - the TP pose library clips (gltf.animations only — never its scene);
 *   - the ball-motion curve library (validated once by the presentation
 *     helper; ONE GoofyBasketPresentation per view is created by callers).
 * The FP pose library goes through FPArmsRig.loadFPPoseClips.
 */

let ballPromise: Promise<GLTF> | null = null;
let lod1Promise: Promise<GLTF> | null = null;
let tpClipsPromise: Promise<THREE.AnimationClip[]> | null = null;
let motionPromise: Promise<unknown> | null = null;

/** Load + cache the ball GLB exactly once. */
export function loadGoofyBasketGltf(): Promise<GLTF> {
  if (ballPromise) return ballPromise;
  ballPromise = new GLTFLoader().loadAsync(GoofyBasketProfile.weaponUrl).then((gltf) => {
    // In-hand balls mask the red enemy contour like every held weapon.
    markEnemyOutlineOccluder(gltf.scene);
    return gltf;
  });
  return ballPromise;
}

/** Load + cache the LOD1 ball (distant remote projectiles). */
export function loadGoofyBasketLod1Gltf(): Promise<GLTF> {
  if (lod1Promise) return lod1Promise;
  lod1Promise = new GLTFLoader().loadAsync(GOOFY_LOD1_URL);
  return lod1Promise;
}

/** Load + cache the TP pose library clips (gltf.animations only). */
export function loadGoofyBasketTPClips(): Promise<THREE.AnimationClip[]> {
  if (tpClipsPromise) return tpClipsPromise;
  tpClipsPromise = new GLTFLoader().loadAsync(GoofyBasketProfile.tpPosesUrl!).then((gltf) => gltf.animations);
  return tpClipsPromise;
}

/** Fetch + cache the raw ball-motion JSON (validated by each presentation instance). */
export function loadGoofyBasketMotionJson(): Promise<unknown> {
  if (motionPromise) return motionPromise;
  motionPromise = fetch(GOOFY_BALL_MOTION_URL).then((r) => {
    if (!r.ok) throw new Error(`GoofyBasket: ball motion fetch failed (${r.status})`);
    return r.json();
  });
  return motionPromise;
}

/**
 * One presentation sampler over the cached curves (one per VIEW owner) +
 * the validated library reference (read-only: used for per-curve lookups
 * such as the lowest free sample of a dribble).
 */
export async function createGoofyBasketPresentation(): Promise<{
  presentation: GoofyBasketPresentation;
  library: BasketCurveLibrary;
}> {
  const json = await loadGoofyBasketMotionJson();
  const presentation = new GoofyBasketPresentation(json); // validates once
  return { presentation, library: json as BasketCurveLibrary };
}

/**
 * New rendered ball instance: the COMPLETE scene cloned (geometry +
 * materials shared), no normalization, no recentering, no bounding-box
 * fitting. The caller chooses the scale contract of its parent:
 *   - mounted under Weapon_R through the profile mount → scale 1 (the
 *     mount already includes the ball scale);
 *   - free ball under the FP camera / normalized TP glTF scene →
 *     GOOFY_BALL.freePresentationScale (0.88);
 *   - stand-alone world projectile → GOOFY_BALL.projectileRootScale.
 */
export function instantiateGoofyBasket(gltf: GLTF, scale = 1): THREE.Object3D {
  const ball = gltf.scene.clone(true);
  ball.scale.setScalar(scale);
  ball.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // follows an animated hand / fast flight
      mesh.raycast = () => {}; // visual only — never a gameplay target
    }
  });
  return ball;
}

/** Ball radius in the instance's parent space for a given root scale. */
export function goofyBasketRadiusForScale(scale: number): number {
  return GOOFY_BALL.sourceRadiusMeters * scale;
}
