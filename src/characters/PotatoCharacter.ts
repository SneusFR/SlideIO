import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MovementConfig as moveCfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { CHARACTER_HITBOX_SCALE } from "../../shared/combat/NetworkWeapons";
import { getQualitySettings } from "../game/GraphicsQuality";
import type {
  RemoteCharacterClips,
  ArmedProfileClips,
} from "../network/remote/RemotePlayerAnimationController";
import { loadBrickMaulTPClips } from "../weapons/brickmaul/BrickMaulModel";
import { BrickMaulProfile } from "../weapons/brickmaul/BrickMaulProfile";
// POTATO character pack (src/assets/potato) — the common third-person model
// for remote players AND bots. One GLB carries mesh + skeleton + the four
// locomotion clips (Run_Goofy / Jump / Dash / Slide, all in place — no root
// motion, verified with scripts/inspect-potato.mjs); the HexSniper TP pose
// library (no meshes) retargets onto the same skeleton by bone name.
import characterUrl from "../assets/potato/Potato_TP_Character.glb?url";
import tpPosesUrl from "../assets/potato/HexSniper_TP_Poses.glb?url";

/** Capsule center → feet distance (model root sits at the feet). */
export const FEET_OFFSET = moveCfg.standHalfHeight + moveCfg.capsuleRadius;
/**
 * Visual upscale of the character model. SAME central factor as every
 * damage hitbox (shared/combat/NetworkWeapons.CHARACTER_HITBOX_SCALE) so
 * the shot volumes always match the rendered silhouette. The MOVEMENT
 * capsule stays unscaled.
 */
export const CHARACTER_SCALE = CHARACTER_HITBOX_SCALE;
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
 * Shared "enemy readability" outline material (ONE instance for every
 * enemy avatar): a thin, crisp red contour hugging the animated
 * silhouette — stencil-masked inverted hull.
 *
 * How it stays CLEAN (the old per-part rim showed red lines INSIDE the
 * silhouette — nose/tongue/arm hulls bleeding over the face/torso):
 *  1. Every enemy body material writes stencil ref 1 where it renders
 *     (markEnemyOutlineOccluder) — pure GL state, no shader change.
 *  2. The hull (back faces inflated along the bind-pose normals) renders
 *     AFTER all bodies (renderOrder 1) and only where stencil != 1, so
 *     the red survives ONLY on the outer silhouette ring.
 * Opaque (no transparency double-blend), depth test ON → walls occlude
 * it (no X-ray). Cost: native stencil buffer — no post-processing.
 */
let enemyOutlineMat: THREE.MeshBasicMaterial | null = null;
export function getEnemyOutlineMaterial(): THREE.MeshBasicMaterial {
  if (!enemyOutlineMat) {
    enemyOutlineMat = new THREE.MeshBasicMaterial({
      color: cc.enemyOutlineColor,
      side: THREE.BackSide,
      toneMapped: false,
    });
    // Stencil TEST only (writeMask 0): draw strictly OUTSIDE the body
    // silhouette. stencilWrite=true is what enables the stencil unit in
    // three.js — the zeroed write mask keeps the buffer untouched.
    enemyOutlineMat.stencilWrite = true;
    enemyOutlineMat.stencilWriteMask = 0;
    enemyOutlineMat.stencilRef = 1;
    enemyOutlineMat.stencilFunc = THREE.NotEqualStencilFunc;
    // Inflate along the (bind-pose) normals BEFORE skinning: the offset
    // vertex then follows the bones exactly like the body vertex does.
    enemyOutlineMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n\ttransformed += normal * ${cc.enemyOutlineThickness.toFixed(4)};`,
      );
    };
  }
  return enemyOutlineMat;
}

/**
 * Mark every mesh material under `root` as an outline OCCLUDER: it writes
 * stencil ref 1 where it renders (and passes depth), masking the enemy
 * outline out of the silhouette interior. Applied to the enemy body AND
 * to the held weapon templates (so the contour never bleeds over a gun
 * crossing the body edge). Pure GL state — no recompile. Idempotent and
 * safe on shared materials: only enemies render the stencil-tested hull.
 */
export function markEnemyOutlineOccluder(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      mat.stencilWrite = true;
      mat.stencilRef = 1;
      mat.stencilFunc = THREE.AlwaysStencilFunc;
      mat.stencilZPass = THREE.ReplaceStencilOp;
    }
  });
}

/**
 * Remove every outline hull mesh under `root` (corpse clones: a dead body
 * is no longer a threat — the red contour must die with it). Also spares
 * the CorpseManager from claiming/fading the shared outline material.
 */
export function stripEnemyOutline(root: THREE.Object3D): void {
  const doomed: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (obj.userData.enemyOutline) doomed.push(obj);
  });
  for (const mesh of doomed) mesh.removeFromParent();
}

export function loadCharacterAsset(): Promise<CharacterAsset> {
  if (cachedCharacter) return cachedCharacter;
  const loader = new GLTFLoader();
  cachedCharacter = Promise.all([
    loader.loadAsync(characterUrl),
    loader.loadAsync(tpPosesUrl),
    // Brick Maul TP pose library (clips only). A failed load never blocks
    // the character: the maul profile simply stays unavailable in TP.
    loadBrickMaulTPClips().catch((err) => {
      console.error("BrickMaul: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
  ]).then(([gltf, posesGltf, maulClips]: [GLTF, GLTF, THREE.AnimationClip[]]) => {
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

    // LOW preset bakes a STATIC shadow map once at load (see Game /
    // GraphicsQuality): moving characters must NOT cast shadows there or
    // their silhouette would be frozen into the bake. HIGH keeps them.
    const characterShadows = !getQualitySettings().staticShadows;
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = characterShadows;
        mesh.receiveShadow = false;
        // PERF: frustum culling STAYS ON. Skinned bounds move with the
        // animation, so the bind-pose bounding sphere is inflated once
        // (per shared geometry) with a generous margin covering every
        // in-place pose (the pack clips carry no root motion). An
        // off-screen character then skips BOTH its skinning and its draw.
        inflateCullingBounds(mesh.geometry);
      }
    });

    // ---- Enemy readability: crisp red contour on the TEMPLATE ----
    // Body materials become stencil occluders, then a sibling hull
    // SkinnedMesh per body part is bound to the SAME skeleton: it follows
    // every animation for free and SkeletonUtils.clone() duplicates it
    // per avatar (geometry + material stay shared). Outline meshes are
    // TAGGED (userData.enemyOutline) so per-avatar code can find the
    // clones (bots toggle them with line-of-sight visibility; corpses
    // strip them). renderOrder 1 → hulls draw AFTER every body mesh,
    // once the stencil silhouette mask is complete for ALL enemies.
    markEnemyOutlineOccluder(model);
    const skinnedParts: THREE.SkinnedMesh[] = [];
    model.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) skinnedParts.push(sm);
    });
    for (const src of skinnedParts) {
      const outline = new THREE.SkinnedMesh(src.geometry, getEnemyOutlineMaterial());
      outline.bind(src.skeleton, src.bindMatrix);
      outline.position.copy(src.position);
      outline.quaternion.copy(src.quaternion);
      outline.scale.copy(src.scale);
      outline.castShadow = false;
      outline.receiveShadow = false;
      outline.renderOrder = 1;
      outline.userData.enemyOutline = true;
      // Purely visual: never a raycast target.
      outline.raycast = () => {};
      src.parent!.add(outline);
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
    const armedRunSrc = byName(posesGltf.animations, "TP_Run_HexSniper");
    const armedAim = byName(posesGltf.animations, "TP_Aim_HexSniper");
    const armedRaise = byName(posesGltf.animations, "TP_Raise_HexSniper");
    const armedLower = byName(posesGltf.animations, "TP_Lower_HexSniper");
    if (!armedHoldSrc || !armedRunSrc || !armedAim || !armedRaise || !armedLower) {
      throw new Error("HexSniper TP pose clips missing");
    }

    // The TP grip the other players see is TP_Aim (weapon held STRAIGHT,
    // barrel along the aim direction) — the FP viewmodel never shows the
    // lowered TP_Hold carry, so the remote avatar must not either (a hit
    // must come from where the gun visibly points). TP_Hold stays loaded
    // as the Raise/Lower transition endpoint only. TP_Aim is a static pose
    // (Weapon_R world orientation drifts 0° over its 2 s; 55° away from
    // TP_Hold) — its first sample is the constant grip for every composite.
    const armedGrip = armedAim;

    // Armed run/jump/dash/slide: MASKED composites cached once on the
    // shared asset. Track ownership (explicit, per the integration
    // contract):
    //   - BODY (base locomotion clip): Hips, Spine, Spine_1, Chest, Neck,
    //     Head, Plant_Root/Tip, legs + feet — the full-body motion. The run
    //     body is TP_Run_HexSniper (hips/legs calibrated for the carry).
    //   - ARMS (TP_Aim pose, first frame, constant): shoulders, arms,
    //     hands, fingers and the animated Weapon_R socket correction —
    //     the straight two-hand grip survives every locomotion state.
    const jumpVariants = [jump, ...gltf.animations.filter(c =>
      c.name === "Jump_LeftLead" || c.name === "Jump_RightLead")];
    const armedRun = buildArmedVariant(armedRunSrc, armedGrip);
    const armedJumpVariants = jumpVariants.map(c => buildArmedVariant(c, armedGrip));
    const armedJump = armedJumpVariants[0];
    const armedDash = buildArmedVariant(dash, armedGrip);
    const armedSlide = stabilizeSlideGrip(buildArmedVariant(slide, armedGrip), armedGrip, template);

    // ---- Brick Maul TP profile set (Potato_TP_BrickMaul.glb) ----
    // Locomotion uses EXACTLY the authored upperBodyMask (right arm + right
    // fingers + Weapon_R): body, legs, head, leaf, shoulders and the whole
    // LEFT arm come from the unarmed clips. Run keeps the right-side tracks
    // animated (TP_BrickMaul_Run, full clip); jump/dash/slide freeze the
    // Hold grip at its first sample. No Spine_1 / slide grip corrections
    // (those belong to the two-hand sniper hold).
    let brickmaul: ArmedProfileClips | null = null;
    const maulHold = byName(maulClips, BrickMaulProfile.tpClips!.hold);
    const maulRun = byName(maulClips, BrickMaulProfile.tpClips!.run);
    if (maulHold && maulRun && BrickMaulProfile.upperBodyMask) {
      const mask = new Set<string>(BrickMaulProfile.upperBodyMask);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, maulHold, mask, "_BrickMaul");
      const maulJumpVariants = jumpVariants.map(masked);
      const maulRunComposite = buildMaskedVariant(run, maulRun, mask, "_BrickMaul", true);
      const maulDash = masked(dash);
      const maulSlide = masked(slide);
      const actions: Record<string, THREE.AnimationClip> = {};
      for (const [key, def] of Object.entries(BrickMaulProfile.tpClips!.actions ?? {})) {
        const clip = byName(maulClips, def.clip);
        if (clip) actions[key] = clip;
      }
      const maulInspect = byName(maulClips, BrickMaulProfile.tpClips!.inspect!) ?? null;
      // Inspection that survives movement: the Inspect clip only animates
      // the arms + head (its body chain is the Hold body, verified 0° on
      // every body bone), so it is split into an UPPER layer played on top
      // of LOWER-body locomotion variants (the same composites minus the
      // layer bones). Disjoint track sets → both actions at weight 1 with
      // no mixer renormalisation, each clip on its own clock.
      const lowerBody = maulInspect
        ? {
            hold: stripBones(maulHold, INSPECT_UPPER_BONES, "_Lower"),
            run: stripBones(maulRunComposite, INSPECT_UPPER_BONES, "_Lower"),
            jump: stripBones(maulJumpVariants[0], INSPECT_UPPER_BONES, "_Lower"),
            jumpVariants: maulJumpVariants.map((c) => stripBones(c, INSPECT_UPPER_BONES, "_Lower")),
            dash: stripBones(maulDash, INSPECT_UPPER_BONES, "_Lower"),
            slide: stripBones(maulSlide, INSPECT_UPPER_BONES, "_Lower"),
          }
        : null;
      brickmaul = {
        hold: maulHold,
        run: maulRunComposite,
        jump: maulJumpVariants[0],
        jumpVariants: maulJumpVariants,
        dash: maulDash,
        slide: maulSlide,
        equip: byName(maulClips, BrickMaulProfile.tpClips!.equip!) ?? null,
        unequip: byName(maulClips, BrickMaulProfile.tpClips!.unequip!) ?? null,
        inspect: maulInspect,
        inspectUpper: maulInspect ? keepBones(maulInspect, INSPECT_UPPER_BONES, "_Upper") : null,
        lowerBody,
        actions,
      };
    }

    const clips: RemoteCharacterClips = {
      idle,
      run,
      jump,
      dash,
      slide,
      armedHold: armedGrip, // TP_Aim — straight grip, FP parity (see above)
      armedRun,
      armedAim,
      armedRaise,
      armedLower,
      armedJump,
      jumpVariants,
      armedJumpVariants,
      armedDash,
      armedSlide,
      profiles: brickmaul ? { brickmaul } : {},
    };
    return { template, clips };
  });
  return cachedCharacter;
}

/**
 * Generic masked composite for a PROFILE hold layer: `mask` bones come
 * from `layer` (first sample held — or the full animated tracks when
 * `animatedLayer` is true, e.g. the maul Run), everything else from the
 * base locomotion clip. Derived clips only — sources never mutate.
 */
function buildMaskedVariant(
  base: THREE.AnimationClip,
  layer: THREE.AnimationClip,
  mask: Set<string>,
  suffix: string,
  animatedLayer = false,
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of base.tracks) {
    if (!mask.has(trackBone(track.name))) tracks.push(track.clone());
  }
  for (const track of layer.tracks) {
    if (!mask.has(trackBone(track.name))) continue;
    tracks.push(animatedLayer ? track.clone() : constantTrack(track));
  }
  // An animated layer of a different length is time-scaled by the mixer
  // through the base duration: keep the base duration as the clip length
  // (the maul Run is 0.72 s vs Run_Goofy 0.8 s → the layer is retimed).
  if (animatedLayer && Math.abs(layer.duration - base.duration) > 1e-4) {
    const scale = base.duration / layer.duration;
    for (const track of tracks) {
      if (!mask.has(trackBone(track.name))) continue;
      for (let i = 0; i < track.times.length; i++) track.times[i] *= scale;
    }
  }
  return new THREE.AnimationClip(`${base.name}${suffix}`, base.duration, tracks);
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

/**
 * Bones owned by the UPPER layer of a moving maul inspection: both arms
 * (the maul is flipped/rotated with both hands), fingers, the weapon
 * sockets and the head (the character looks at the maul). Everything
 * below (hips, spine chain, legs, plant) keeps the locomotion. The
 * shoulders stay with the body: the Inspect clip never rotates them.
 */
const INSPECT_UPPER_BONES = new Set<string>([
  "UpperArm_L",
  "LowerArm_L",
  "Hand_L",
  "Index_L_1",
  "Middle_L_1",
  "Ring_L_1",
  "Thumb_L_1",
  "Weapon_L",
  "UpperArm_R",
  "LowerArm_R",
  "Hand_R",
  "Index_R_1",
  "Middle_R_1",
  "Ring_R_1",
  "Thumb_R_1",
  "Weapon_R",
  "Head",
]);

/** Derived clip keeping ONLY the tracks of `bones` (same duration). */
function keepBones(clip: THREE.AnimationClip, bones: Set<string>, suffix: string): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => bones.has(trackBone(t.name))).map((t) => t.clone());
  return new THREE.AnimationClip(`${clip.name}${suffix}`, clip.duration, tracks);
}

/** Derived clip WITHOUT the tracks of `bones` (same duration). */
function stripBones(clip: THREE.AnimationClip, bones: Set<string>, suffix: string): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => !bones.has(trackBone(t.name))).map((t) => t.clone());
  return new THREE.AnimationClip(`${clip.name}${suffix}`, clip.duration, tracks);
}

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
  // The calibrated grip includes Spine_1: its hold-space basis must stay
  // with the arms during Jump. Hips/Spine/Chest still carry body motion.
  const ownsGrip = (name: string) => ARMED_LAYER_BONES.has(name) ||
    ((base.name.startsWith("Jump") || base.name === "Slide") && name === "Spine_1");
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of base.tracks) {
    if (!ownsGrip(trackBone(track.name))) tracks.push(track.clone());
  }
  for (const track of holdPose.tracks) {
    if (ownsGrip(trackBone(track.name))) tracks.push(constantTrack(track));
  }
  return new THREE.AnimationClip(`${base.name}_Armed`, base.duration, tracks);
}

/** Bake shoulder compensation once: a reclined slide must not aim the gun skyward.
 * All arm/finger/socket tracks stay in the same calibrated two-hand hold space.
 * The temporary hierarchy is used for transforms only (no skinning/rendering).
 */
function stabilizeSlideGrip(
  clip: THREE.AnimationClip,
  hold: THREE.AnimationClip,
  template: THREE.Object3D,
): THREE.AnimationClip {
  const hierarchy = template.clone(true);
  const shoulderBase = hierarchy.getObjectByName("Spine_1");
  if (!shoulderBase?.parent) return clip;
  const mixer = new THREE.AnimationMixer(hierarchy);
  const reference = mixer.clipAction(hold).play();
  mixer.update(0);
  hierarchy.updateMatrixWorld(true);
  const heldWorld = shoulderBase.getWorldQuaternion(new THREE.Quaternion());
  reference.stop();
  const action = mixer.clipAction(clip).play();
  action.paused = true;
  const q = new THREE.Quaternion(), previous = new THREE.Quaternion();
  const times: number[] = [], values: number[] = [];
  const count = Math.round(clip.duration * 120);
  for (let i = 0; i <= count; i++) {
    const t = i * clip.duration / count;
    action.time = t;
    mixer.update(0);
    hierarchy.updateMatrixWorld(true);
    shoulderBase.parent.getWorldQuaternion(q).invert().multiply(heldWorld);
    if (i > 0 && previous.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    previous.copy(q);
    times.push(t);
    values.push(q.x, q.y, q.z, q.w);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(hierarchy);
  return new THREE.AnimationClip(clip.name, clip.duration, [
    ...clip.tracks.filter(t => t.name !== "Spine_1.quaternion"),
    new THREE.QuaternionKeyframeTrack("Spine_1.quaternion", times, values),
  ]);
}
