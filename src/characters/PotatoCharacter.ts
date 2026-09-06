import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MovementConfig as moveCfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import type { RemoteCharacterClips } from "../network/remote/RemotePlayerAnimationController";
// POTATO character pack (src/assets/potato) — the common third-person model
// for remote players AND bots. One GLB carries mesh + skeleton + the four
// locomotion clips (Run_Goofy / Jump / Dash / Slide, all in place — no root
// motion, verified with scripts/inspect-potato.mjs); the HexSniper TP pose
// library (no meshes) retargets onto the same skeleton by bone name.
import characterUrl from "../assets/potato/Potato_TP_Character.glb?url";
import tpPosesUrl from "../assets/potato/HexSniper_TP_Poses.glb?url";

/** Capsule center → feet distance (model root sits at the feet). */
export const FEET_OFFSET = moveCfg.standHalfHeight + moveCfg.capsuleRadius;
/** Visual upscale of the character model (purely cosmetic — hitbox unchanged). */
export const CHARACTER_SCALE = 1.25;
/** Visual character height (capsule height × cosmetic upscale). */
export const CHARACTER_HEIGHT = FEET_OFFSET * 2 * CHARACTER_SCALE;
/** Top of the (scaled) model relative to the capsule center (feet at -FEET_OFFSET). */
export const MODEL_TOP = CHARACTER_HEIGHT - FEET_OFFSET;
/** Raw GLB faces +Z; game convention: yaw = 0 → forward = -Z. */
export const MODEL_YAW_OFFSET = Math.PI;

/**
 * Skeleton role map of the Potato rig — the single place that knows the
 * REAL bone names. Animation, weapon mounts, hitboxes and ragdolls all
 * resolve bones through these names (the GLB bones are NEVER renamed).
 */
export const POTATO_BONES = {
  root: "Root",
  hips: "Hips",
  spine: "Spine",
  spineMid: "Spine_1",
  chest: "Chest",
  neck: "Neck",
  head: "Head",
  shoulderL: "Shoulder_L",
  shoulderR: "Shoulder_R",
  upperArmL: "UpperArm_L",
  upperArmR: "UpperArm_R",
  lowerArmL: "LowerArm_L",
  lowerArmR: "LowerArm_R",
  handL: "Hand_L",
  handR: "Hand_R",
  upperLegL: "UpperLeg_L",
  upperLegR: "UpperLeg_R",
  lowerLegL: "LowerLeg_L",
  lowerLegR: "LowerLeg_R",
  footL: "Foot_L",
  footR: "Foot_R",
  plantRoot: "Plant_Root",
  plantTip: "Plant_Tip",
  weaponSocketR: "Weapon_R",
  weaponSocketL: "Weapon_L",
  headSocket: "Head_Socket",
  faceSocket: "Face_Socket",
  backSocket: "Back_Socket",
} as const;

/**
 * Shared, cached Potato character asset (load once → clone per avatar).
 * Used by BOTH the multiplayer remote avatars AND the solo bots — every
 * humanoid enemy in the game shares this exact model + animations.
 */
export interface CharacterAsset {
  template: THREE.Object3D;
  clips: RemoteCharacterClips;
}
let cachedCharacter: Promise<CharacterAsset> | null = null;

/**
 * Shared "enemy readability" rim material (one instance for every enemy
 * avatar): back faces of a duplicated skinned mesh, displaced along the
 * vertex normals, render as a light red glow hugging the animated
 * silhouette. Depth test stays ON → walls occlude it (no X-ray).
 */
let enemyRimMat: THREE.MeshBasicMaterial | null = null;
export function getEnemyRimMaterial(): THREE.MeshBasicMaterial {
  if (!enemyRimMat) {
    enemyRimMat = new THREE.MeshBasicMaterial({
      color: cc.enemyOutlineColor,
      side: THREE.BackSide,
      toneMapped: false,
      transparent: true,
      opacity: 0.85,
    });
    // Inflate along the (bind-pose) normals BEFORE skinning: the offset
    // vertex then follows the bones exactly like the body vertex does.
    enemyRimMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n\ttransformed += normal * ${cc.enemyOutlineThickness.toFixed(4)};`,
      );
    };
  }
  return enemyRimMat;
}

export function loadCharacterAsset(): Promise<CharacterAsset> {
  if (cachedCharacter) return cachedCharacter;
  const loader = new GLTFLoader();
  cachedCharacter = Promise.all([
    loader.loadAsync(characterUrl),
    loader.loadAsync(tpPosesUrl),
  ]).then(([gltf, posesGltf]: [GLTF, GLTF]) => {
    const model = gltf.scene;

    // Normalize ONCE on the template, measured from the REST pose (the
    // mixer never ran on the template — this is the bind-pose box, never
    // an animated per-frame box): target height CHARACTER_HEIGHT, feet at
    // local y = 0, facing -Z at yaw 0. Clones inherit this for free.
    // Potato native height (leaf included) ≈ 0.83545 m → scale ≈ 2.693.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(CHARACTER_HEIGHT / Math.max(size.y, 1e-6));
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    model.rotation.y = MODEL_YAW_OFFSET;

    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        // PERF: frustum culling STAYS ON. Skinned bounds move with the
        // animation, so the bind-pose bounding sphere is inflated once
        // (per shared geometry) with a generous margin covering every
        // in-place pose (the pack clips carry no root motion). An
        // off-screen character then skips BOTH its skinning and its draw.
        inflateCullingBounds(mesh.geometry);
      }
    });

    // ---- Enemy readability: light red glow rim on the TEMPLATE ----
    // A sibling SkinnedMesh per body part, bound to the SAME skeleton:
    // it follows every animation for free and SkeletonUtils.clone()
    // duplicates it per avatar (geometry + material stay shared). Rim
    // meshes are TAGGED (userData.enemyRim) so per-avatar code can find
    // the clones (e.g. bots toggle them with line-of-sight visibility).
    const skinnedParts: THREE.SkinnedMesh[] = [];
    model.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) skinnedParts.push(sm);
    });
    for (const src of skinnedParts) {
      const rim = new THREE.SkinnedMesh(src.geometry, getEnemyRimMaterial());
      rim.bind(src.skeleton, src.bindMatrix);
      rim.position.copy(src.position);
      rim.quaternion.copy(src.quaternion);
      rim.scale.copy(src.scale);
      rim.castShadow = false;
      rim.receiveShadow = false;
      rim.userData.enemyRim = true;
      // Purely visual: never a raycast target.
      rim.raycast = () => {};
      src.parent!.add(rim);
    }

    // Wrap in a container so the clone root is a plain, unrotated group.
    const template = new THREE.Group();
    template.add(model);

    const byName = (list: THREE.AnimationClip[] | undefined, name: string) =>
      list?.find((c) => c.name === name);
    const run = byName(gltf.animations, "Run_Goofy");
    const jump = byName(gltf.animations, "Jump");
    const dash = byName(gltf.animations, "Dash");
    const slide = byName(gltf.animations, "Slide");
    if (!run || !jump || !dash || !slide) {
      throw new Error("Potato character clips missing (Run_Goofy/Jump/Dash/Slide)");
    }
    // NOTE: the pack clips are authored IN PLACE — Hips.position only
    // carries the pose (crouch/bounce), never world travel (verified:
    // X/Z stay within ±8 cm). The old Meshy stripHipsRootMotion pass is
    // intentionally NOT applied here: it would flatten real pose motion.

    // No unarmed Idle clip ships with the pack: derive a STABLE constant
    // idle pose from the neutral first frames of the four clips (union —
    // every animated bone gets a value, so no T-pose and no residue when
    // fading out of a clip that animates more bones than the next one).
    const idle = buildConstantPoseClip("Potato_Idle_Derived", [jump, slide, run, dash]);

    // ---- HexSniper TP pose library (no meshes — clips only) ----
    const armedHoldSrc = byName(posesGltf.animations, "TP_Hold_HexSniper");
    const armedRun = byName(posesGltf.animations, "TP_Run_HexSniper");
    const armedAim = byName(posesGltf.animations, "TP_Aim_HexSniper");
    const armedRaise = byName(posesGltf.animations, "TP_Raise_HexSniper");
    const armedLower = byName(posesGltf.animations, "TP_Lower_HexSniper");
    if (!armedHoldSrc || !armedRun || !armedAim || !armedRaise || !armedLower) {
      throw new Error("HexSniper TP pose clips missing");
    }

    // Armed jump/dash/slide: MASKED composites cached once on the shared
    // asset. Track ownership (explicit, per the integration contract):
    //   - BODY (base locomotion clip): Hips, Spine, Spine_1, Chest, Neck,
    //     Head, Plant_Root/Tip, legs + feet — the full-body motion.
    //   - ARMS (TP_Hold pose, first frame, constant): shoulders, arms,
    //     hands, fingers and the animated Weapon_R socket correction —
    //     the two-hand grip survives every airborne/dash/slide state.
    const armedJump = buildArmedVariant(jump, armedHoldSrc);
    const armedDash = buildArmedVariant(dash, armedHoldSrc);
    const armedSlide = buildArmedVariant(slide, armedHoldSrc);

    const clips: RemoteCharacterClips = {
      idle,
      run,
      jump,
      dash,
      slide,
      armedHold: armedHoldSrc,
      armedRun,
      armedAim,
      armedRaise,
      armedLower,
      armedJump,
      armedDash,
      armedSlide,
    };
    return { template, clips };
  });
  return cachedCharacter;
}

/** Bounding-sphere inflation factor for skinned culling (see above). */
const SKINNED_CULL_MARGIN = 2.5;

/**
 * Inflate a geometry's bounding sphere so frustum culling stays valid
 * for every animated pose. Idempotent — geometries shared between the
 * body mesh and its rim duplicate are only inflated once.
 */
function inflateCullingBounds(geometry: THREE.BufferGeometry): void {
  if (geometry.userData.cullBoundsInflated) return;
  geometry.userData.cullBoundsInflated = true;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius *= SKINNED_CULL_MARGIN;
}

/**
 * Bone names owned by the ARMED UPPER-BODY layer (TP weapon poses).
 * Everything else (hips, spine chain, neck, head, plant, legs) belongs to
 * the base locomotion clip in a masked armed composite.
 */
const ARMED_LAYER_BONES = new Set<string>([
  "Shoulder_L",
  "Shoulder_R",
  "UpperArm_L",
  "UpperArm_R",
  "LowerArm_L",
  "LowerArm_R",
  "Hand_L",
  "Hand_R",
  "Index_L_1",
  "Index_R_1",
  "Middle_L_1",
  "Middle_R_1",
  "Ring_L_1",
  "Ring_R_1",
  "Thumb_L_1",
  "Thumb_R_1",
  "Weapon_R",
  "Weapon_L",
]);

/** Bone name of a "NodeName.property" track. */
function trackBone(trackName: string): string {
  const dot = trackName.lastIndexOf(".");
  return dot >= 0 ? trackName.slice(0, dot) : trackName;
}

/** Single-key CONSTANT copy of a track (its first keyframe, held forever). */
function constantTrack(track: THREE.KeyframeTrack): THREE.KeyframeTrack {
  const stride = track.getValueSize();
  const values = track.values.slice(0, stride);
  const TrackType = track.constructor as new (
    name: string,
    times: ArrayLike<number>,
    values: ArrayLike<number>,
  ) => THREE.KeyframeTrack;
  return new TrackType(track.name, [0], values);
}

/**
 * Derived constant-pose clip: for every track present in ANY source clip
 * (first source wins), hold its first keyframe. Cached on the shared
 * asset — never rebuilt per instance, never mutates the source clips.
 */
function buildConstantPoseClip(
  name: string,
  sources: THREE.AnimationClip[],
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const covered = new Set<string>();
  for (const clip of sources) {
    for (const track of clip.tracks) {
      if (covered.has(track.name)) continue;
      covered.add(track.name);
      tracks.push(constantTrack(track));
    }
  }
  return new THREE.AnimationClip(name, 1, tracks);
}

/**
 * Masked ARMED variant of a locomotion clip: body tracks from the base
 * clip + a constant two-hand grip (TP hold pose, first frame) on the
 * armed-layer bones. Derived clips only — the cached originals are never
 * modified. The animated Weapon_R correction of the TP pose is preserved
 * through its first-frame value (the arms are constant, so the socket
 * correction must be too — a swaying socket under frozen arms drifts).
 */
function buildArmedVariant(
  base: THREE.AnimationClip,
  holdPose: THREE.AnimationClip,
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of base.tracks) {
    if (!ARMED_LAYER_BONES.has(trackBone(track.name))) tracks.push(track.clone());
  }
  for (const track of holdPose.tracks) {
    if (ARMED_LAYER_BONES.has(trackBone(track.name))) tracks.push(constantTrack(track));
  }
  return new THREE.AnimationClip(`${base.name}_Armed`, base.duration, tracks);
}
