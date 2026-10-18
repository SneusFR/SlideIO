import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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
import { loadGoofyBasketTPClips } from "../weapons/goofybasket/GoofyBasketModel";
import { GoofyBasketProfile } from "../weapons/goofybasket/GoofyBasketProfile";
import { loadPopcornShotgunTPClips } from "../weapons/popcorn/PopcornShotgunModel";
import { PopcornShotgunProfile } from "../weapons/profiles/PopcornShotgunProfile";
import { loadPaintballRifleTPClips } from "../weapons/paintball/PaintballRifleModel";
import { PaintballRifleProfile } from "../weapons/profiles/PaintballRifleProfile";
import { loadWaterFamasTPClips } from "../weapons/waterfamas/WaterFamasModel";
import { WaterFamasProfile } from "../weapons/profiles/WaterFamasProfile";
import { loadFrisbeeLauncherTPClips } from "../weapons/frisbee/FrisbeeLauncherModel";
import { FrisbeeLauncherProfile } from "../weapons/profiles/FrisbeeLauncherProfile";
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
 * Skinned parts of Potato_TP_Character.glb (all children of "Armature", one
 * shared skin). The BODY keeps its exact name and geometry: the paintball /
 * water FAMAS effects and the astronaut outfit (masks.json signature) find
 * and validate it by name. The small parts are merged at load time (see
 * consolidateCharacterParts).
 */
export const POTATO_BODY_MESH = "Potato";
/** Both eyes + mouth + teeth + leaf, merged into ONE mesh (see consolidateCharacterParts). */
export const POTATO_DETAILS_MESH = "Potato_Details";
/** Fallback split: both eyes (same material and texture). */
export const POTATO_EYES_MESH = "Potato_Eyes";
/** Fallback split: mouth + teeth + leaf (per-part colour / roughness palette). */
export const POTATO_ACCESSORIES_MESH = "Potato_Accessories";
// Blender names; GLTFLoader sanitizes node names ("Eye Image.001" →
// "Eye_Image001"), both spellings are looked up.
const EYE_PARTS = ["Eye Image", "Eye Image.001"] as const;
const ACCESSORY_PARTS = ["Potato.001", "Teth", "Plant"] as const; // mouth, teeth, leaf

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
 * PERF: SkeletonUtils.clone() gives EVERY skinned mesh of a clone its own
 * Skeleton, although every part of the Potato (body, eyes, accessories and
 * their red outline hulls) is skinned to the SAME 37 bones with the SAME
 * inverse bind matrices (one glTF skin). Each duplicate skeleton cost a
 * full bone-matrix pass + a bone-texture upload per frame — 12 per avatar.
 * Rebind every skinned mesh of the clone onto ONE skeleton (the body's,
 * which the astronaut outfit also binds to): one update + one upload per
 * avatar and per frame. Meshes skinned to a different rig are left alone.
 * Call once on each fresh character clone (living avatars AND corpses).
 */
export function shareOutlineSkeletons(root: THREE.Object3D): void {
  const skinned: THREE.SkinnedMesh[] = [];
  root.traverse((obj) => {
    const sm = obj as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) skinned.push(sm);
  });
  const reference =
    skinned.find((sm) => sm.name === POTATO_BODY_MESH && !sm.userData.enemyOutline) ?? skinned[0];
  if (!reference) return;
  const shared = reference.skeleton;
  for (const sm of skinned) {
    if (sm.skeleton === shared || !sameRig(sm.skeleton, shared)) continue;
    sm.bind(shared, sm.bindMatrix);
  }
}

/** Same bones (by identity) with the same inverse bind matrices? */
function sameRig(a: THREE.Skeleton, b: THREE.Skeleton): boolean {
  if (a.bones.length !== b.bones.length) return false;
  for (let i = 0; i < a.bones.length; i++) {
    if (a.bones[i] !== b.bones[i]) return false;
    if (!a.boneInverses[i].equals(b.boneInverses[i])) return false;
  }
  return true;
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
    // GoofyBasket TP pose library (clips only) — same failure policy.
    loadGoofyBasketTPClips().catch((err) => {
      console.error("GoofyBasket: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
    // Popcorn Shotgun TP pose library (clips only) — same failure policy.
    loadPopcornShotgunTPClips().catch((err) => {
      console.error("PopcornShotgun: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
    // Paintball Rifle TP pose library (clips only) — same failure policy.
    loadPaintballRifleTPClips().catch((err) => {
      console.error("PaintballRifle: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
    // Water FAMAS TP pose library (clips only) — same failure policy.
    loadWaterFamasTPClips().catch((err) => {
      console.error("WaterFamas: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
    // Frisbee Launcher TP pose library (clips only) — same failure policy.
    loadFrisbeeLauncherTPClips().catch((err) => {
      console.error("FrisbeeLauncher: TP pose library failed to load", err);
      return [] as THREE.AnimationClip[];
    }),
  ]).then(([gltf, posesGltf, maulClips, basketClips, popcornClips, paintballClips, famasClips, frisbeeClips]: [
    GLTF,
    GLTF,
    THREE.AnimationClip[],
    THREE.AnimationClip[],
    THREE.AnimationClip[],
    THREE.AnimationClip[],
    THREE.AnimationClip[],
    THREE.AnimationClip[],
  ]) => {
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

    // PERF: 6 skinned parts → 2 (body untouched; eyes + mouth + teeth +
    // leaf merged into one "details" mesh). Every avatar then costs 2 draws
    // instead of 6 in the world pass, 2 red outline hulls instead of 6 and
    // 2 shadow draws instead of 6 — same image.
    consolidateCharacterParts(model);

    // LOW preset bakes a STATIC shadow map once at load (see Game /
    // GraphicsQuality): moving characters must NOT cast shadows there or
    // their silhouette would be frozen into the bake. HIGH keeps them
    // (fallback split only: the separate eyes mesh does not cast — it sits
    // inside the head's shadow).
    const characterShadows = !getQualitySettings().staticShadows;
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = characterShadows && mesh.name !== POTATO_EYES_MESH;
        mesh.receiveShadow = false;
        // PERF: frustum culling STAYS ON. Skinned bounds move with the
        // animation, so the bind-pose bounding sphere is inflated once
        // (per shared geometry) with a generous margin covering every
        // in-place pose (the pack clips carry no root motion). An
        // off-screen character then skips BOTH its skinning and its draw.
        inflateCullingBounds(mesh.geometry);
        adoptCullingBounds(mesh);
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
    // PERF: parts sharing one binding (body + merged details) get ONE hull
    // (merged geometry, same skeleton): one outline draw per enemy instead
    // of one per part — same contour (same material, same inflated normals,
    // opaque single colour).
    const merged = mergedOutlineHull(skinnedParts);
    for (const src of merged ? [skinnedParts[0]] : skinnedParts) {
      const outline = new THREE.SkinnedMesh(merged?.geometry ?? src.geometry, getEnemyOutlineMaterial());
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
      if (merged) outline.boundingSphere = merged.bounds.clone();
      else adoptCullingBounds(outline);
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
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(BrickMaulProfile.tpClips!.actions ?? {})) {
        const clip = byName(maulClips, def.clip);
        if (clip) actions[key] = { clip, loop: def.loop }; // explicit profile flag (Slam_Dive loops)
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

    // ---- GoofyBasket TP profile set (Potato_TP_GoofyBasket.glb) ----
    // ONE-HAND right grip: the authored rightArmMask (right arm + right
    // fingers + Weapon_R) is the hold layer; body, legs, head, leaf and the
    // whole LEFT arm keep the unarmed locomotion. Run keeps the right side
    // ANIMATED (TP_GoofyBasket_Run, the dribble — retimed to Run_Goofy);
    // jump / dash / slide freeze the Hold grip (ball held). Every phase
    // clip (charge / throw / catch / dribble) is a LAYER reduced to the
    // mask and played over the lower-body locomotion — the legs never stop.
    let goofybasket: ArmedProfileClips | null = null;
    const gbHold = byName(basketClips, GoofyBasketProfile.tpClips!.hold);
    const gbRun = byName(basketClips, GoofyBasketProfile.tpClips!.run);
    if (gbHold && gbRun && GoofyBasketProfile.upperBodyMask) {
      const mask = new Set<string>(GoofyBasketProfile.upperBodyMask);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, gbHold, mask, "_GoofyBasket");
      const gbJumpVariants = jumpVariants.map(masked);
      const gbRunComposite = buildMaskedVariant(run, gbRun, mask, "_GoofyBasket", true);
      const gbDash = masked(dash);
      const gbSlide = masked(slide);
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(GoofyBasketProfile.tpClips!.actions ?? {})) {
        const clip = byName(basketClips, def.clip);
        if (clip) actions[key] = { clip: keepBones(clip, mask, "_Layer"), loop: def.loop, layered: true };
      }
      const gbInspect = byName(basketClips, GoofyBasketProfile.tpClips!.inspect!) ?? null;
      // The idle "hold" of this set is the FULL Hold clip (animated breathing
      // grip); its lower-body variant drops the mask so a layer can sit on it.
      goofybasket = {
        hold: gbHold,
        run: gbRunComposite,
        jump: gbJumpVariants[0],
        jumpVariants: gbJumpVariants,
        dash: gbDash,
        slide: gbSlide,
        equip: byName(basketClips, GoofyBasketProfile.tpClips!.equip!) ?? null,
        unequip: byName(basketClips, GoofyBasketProfile.tpClips!.unequip!) ?? null,
        inspect: gbInspect,
        inspectUpper: gbInspect ? keepBones(gbInspect, mask, "_Layer") : null,
        lowerBody: {
          hold: stripBones(gbHold, mask, "_Lower"),
          run: stripBones(gbRunComposite, mask, "_Lower"),
          jump: stripBones(gbJumpVariants[0], mask, "_Lower"),
          jumpVariants: gbJumpVariants.map((c) => stripBones(c, mask, "_Lower")),
          dash: stripBones(gbDash, mask, "_Lower"),
          slide: stripBones(gbSlide, mask, "_Lower"),
        },
        actions,
      };
    }

    // ---- Popcorn Shotgun TP profile set (PopcornShotgun_TP_Poses.glb) ----
    // TWO-HAND "always aiming" stance. The authored upperBodyMask (both
    // arms + fingers, shoulders, Spine_1 bladed 3/4, Plant_Root, Weapon_R)
    // is the hold layer. TP_Hold animates ONLY that mask, so every other
    // bone is filled from the unarmed locomotion (never the bind pose):
    //   idle  = derived idle body + the animated TP_Hold (2 s breathing);
    //   run   = TP_Run (authored with its own legs, 0.8 s like Run_Goofy)
    //           + Run_Goofy for the bones it does not key (head, neck…);
    //   jump / dash / slide = locomotion body + the Hold grip frozen.
    // Fire / FireLast / Reload are LAYERS reduced to the mask, played over
    // the lower-body locomotion (GoofyBasket pattern): a player firing or
    // reloading while running keeps running.
    let popcornshotgun: ArmedProfileClips | null = null;
    const pcTp = PopcornShotgunProfile.tpClips!;
    const pcHoldSrc = byName(popcornClips, pcTp.hold);
    const pcRunSrc = byName(popcornClips, pcTp.run);
    if (pcHoldSrc && pcRunSrc && PopcornShotgunProfile.upperBodyMask) {
      const mask = new Set<string>(PopcornShotgunProfile.upperBodyMask);
      const pcHold = overlayClip(idle, pcHoldSrc, `${pcHoldSrc.name}_Full`);
      const pcRun = overlayClip(run, pcRunSrc, `${pcRunSrc.name}_Full`);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, pcHoldSrc, mask, "_PopcornShotgun");
      const pcJumpVariants = jumpVariants.map(masked);
      const pcDash = masked(dash);
      const pcSlide = masked(slide);
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(pcTp.actions ?? {})) {
        const clip = byName(popcornClips, def.clip);
        if (clip) actions[key] = { clip: keepBones(clip, mask, "_Layer"), loop: def.loop, layered: true };
      }
      popcornshotgun = {
        hold: pcHold,
        run: pcRun,
        jump: pcJumpVariants[0],
        jumpVariants: pcJumpVariants,
        dash: pcDash,
        slide: pcSlide,
        equip: null,
        unequip: null,
        inspect: null,
        lowerBody: {
          hold: stripBones(pcHold, mask, "_Lower"),
          run: stripBones(pcRun, mask, "_Lower"),
          jump: stripBones(pcJumpVariants[0], mask, "_Lower"),
          jumpVariants: pcJumpVariants.map((c) => stripBones(c, mask, "_Lower")),
          dash: stripBones(pcDash, mask, "_Lower"),
          slide: stripBones(pcSlide, mask, "_Lower"),
        },
        actions,
      };
    }

    // ---- Paintball Rifle TP profile set (PaintballRifle_TP_Poses.glb) ----
    // Same TWO-HAND "always aiming" construction as the Popcorn Shotgun
    // (identical upperBodyMask: arms + fingers, shoulders, Spine_1 bladed
    // 3/4, Plant_Root, Weapon_R). Fire is a LOOPING layer (0.1 s, one kick
    // per ball) started on the first ball of a burst, FireEnd a one-shot
    // layer at the release, Reload the hopper swap layer — all over the
    // lower-body locomotion (a player firing while running keeps running).
    let paintballrifle: ArmedProfileClips | null = null;
    const pbTp = PaintballRifleProfile.tpClips!;
    const pbHoldSrc = byName(paintballClips, pbTp.hold);
    const pbRunSrc = byName(paintballClips, pbTp.run);
    if (pbHoldSrc && pbRunSrc && PaintballRifleProfile.upperBodyMask) {
      const mask = new Set<string>(PaintballRifleProfile.upperBodyMask);
      const pbHold = overlayClip(idle, pbHoldSrc, `${pbHoldSrc.name}_Full`);
      const pbRun = overlayClip(run, pbRunSrc, `${pbRunSrc.name}_Full`);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, pbHoldSrc, mask, "_PaintballRifle");
      const pbJumpVariants = jumpVariants.map(masked);
      const pbDash = masked(dash);
      const pbSlide = masked(slide);
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(pbTp.actions ?? {})) {
        const clip = byName(paintballClips, def.clip);
        if (clip) actions[key] = { clip: keepBones(clip, mask, "_Layer"), loop: def.loop, layered: true };
      }
      paintballrifle = {
        hold: pbHold,
        run: pbRun,
        jump: pbJumpVariants[0],
        jumpVariants: pbJumpVariants,
        dash: pbDash,
        slide: pbSlide,
        equip: null,
        unequip: null,
        inspect: null,
        lowerBody: {
          hold: stripBones(pbHold, mask, "_Lower"),
          run: stripBones(pbRun, mask, "_Lower"),
          jump: stripBones(pbJumpVariants[0], mask, "_Lower"),
          jumpVariants: pbJumpVariants.map((c) => stripBones(c, mask, "_Lower")),
          dash: stripBones(pbDash, mask, "_Lower"),
          slide: stripBones(pbSlide, mask, "_Lower"),
        },
        actions,
      };
    }

    // ---- Water FAMAS TP profile set (WaterFamas_TP_Poses.glb) ----
    // ONE-HANDED pistol grip (right hand only, at chest height): the left arm
    // hangs along the belly and swings while running. Same construction as
    // the other profile sets: the authored upperBodyMask (Spine_1 + Weapon_R
    // + the arms) is the hold layer, everything else comes from the unarmed
    // locomotion. Fire is a ONE-SHOT layer (a burst of 3 jets, 0.42 s — NOT a
    // loop), Reload the refill layer (bottle taken from the belt) — both over
    // the lower-body locomotion (a player firing while running keeps running).
    let waterfamas: ArmedProfileClips | null = null;
    const wfTp = WaterFamasProfile.tpClips!;
    const wfHoldSrc = byName(famasClips, wfTp.hold);
    const wfRunSrc = byName(famasClips, wfTp.run);
    if (wfHoldSrc && wfRunSrc && WaterFamasProfile.upperBodyMask) {
      const mask = new Set<string>(WaterFamasProfile.upperBodyMask);
      const wfHold = overlayClip(idle, wfHoldSrc, `${wfHoldSrc.name}_Full`);
      const wfRun = overlayClip(run, wfRunSrc, `${wfRunSrc.name}_Full`);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, wfHoldSrc, mask, "_WaterFamas");
      const wfJumpVariants = jumpVariants.map(masked);
      const wfDash = masked(dash);
      const wfSlide = masked(slide);
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(wfTp.actions ?? {})) {
        const clip = byName(famasClips, def.clip);
        if (clip) actions[key] = { clip: keepBones(clip, mask, "_Layer"), loop: def.loop, layered: true };
      }
      waterfamas = {
        hold: wfHold,
        run: wfRun,
        jump: wfJumpVariants[0],
        jumpVariants: wfJumpVariants,
        dash: wfDash,
        slide: wfSlide,
        equip: null,
        unequip: null,
        inspect: null,
        lowerBody: {
          hold: stripBones(wfHold, mask, "_Lower"),
          run: stripBones(wfRun, mask, "_Lower"),
          jump: stripBones(wfJumpVariants[0], mask, "_Lower"),
          jumpVariants: wfJumpVariants.map((c) => stripBones(c, mask, "_Lower")),
          dash: stripBones(wfDash, mask, "_Lower"),
          slide: stripBones(wfSlide, mask, "_Lower"),
        },
        actions,
      };
    }

    // ---- Frisbee Launcher TP profile set (FrisbeeLauncher_TP_Poses.glb) ----
    // TWO-HAND crossbow (right hand on the pistol grip, left on the foregrip), same
    // construction as the Popcorn Shotgun / Paintball Rifle sets: the authored
    // upperBodyMask is the hold layer, everything else comes from the unarmed
    // locomotion. Fire (throw + automatic re-cock, 1.58 s), FireLast, Reload and
    // ReloadEmpty are ONE-SHOT layers over the lower-body locomotion (a player
    // firing or swapping the cage while running keeps running).
    let frisbeelauncher: ArmedProfileClips | null = null;
    const flTp = FrisbeeLauncherProfile.tpClips!;
    const flHoldSrc = byName(frisbeeClips, flTp.hold);
    const flRunSrc = byName(frisbeeClips, flTp.run);
    if (flHoldSrc && flRunSrc && FrisbeeLauncherProfile.upperBodyMask) {
      const mask = new Set<string>(FrisbeeLauncherProfile.upperBodyMask);
      const flHold = overlayClip(idle, flHoldSrc, `${flHoldSrc.name}_Full`);
      const flRun = overlayClip(run, flRunSrc, `${flRunSrc.name}_Full`);
      const masked = (base: THREE.AnimationClip) => buildMaskedVariant(base, flHoldSrc, mask, "_FrisbeeLauncher");
      const flJumpVariants = jumpVariants.map(masked);
      const flDash = masked(dash);
      const flSlide = masked(slide);
      const actions: ArmedProfileClips["actions"] = {};
      for (const [key, def] of Object.entries(flTp.actions ?? {})) {
        const clip = byName(frisbeeClips, def.clip);
        if (clip) actions[key] = { clip: keepBones(clip, mask, "_Layer"), loop: def.loop, layered: true };
      }
      frisbeelauncher = {
        hold: flHold,
        run: flRun,
        jump: flJumpVariants[0],
        jumpVariants: flJumpVariants,
        dash: flDash,
        slide: flSlide,
        equip: null,
        unequip: null,
        inspect: null,
        lowerBody: {
          hold: stripBones(flHold, mask, "_Lower"),
          run: stripBones(flRun, mask, "_Lower"),
          jump: stripBones(flJumpVariants[0], mask, "_Lower"),
          jumpVariants: flJumpVariants.map((c) => stripBones(c, mask, "_Lower")),
          dash: stripBones(flDash, mask, "_Lower"),
          slide: stripBones(flSlide, mask, "_Lower"),
        },
        actions,
      };
    }

    const profiles: Record<string, ArmedProfileClips> = {};
    if (brickmaul) profiles.brickmaul = brickmaul;
    if (goofybasket) profiles[GoofyBasketProfile.id] = goofybasket;
    if (popcornshotgun) profiles[PopcornShotgunProfile.id] = popcornshotgun;
    if (paintballrifle) profiles[PaintballRifleProfile.id] = paintballrifle;
    if (waterfamas) profiles[WaterFamasProfile.id] = waterfamas;
    if (frisbeelauncher) profiles[FrisbeeLauncherProfile.id] = frisbeelauncher;

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
      profiles,
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

/**
 * Full-body composite: EVERY track of `layer` (kept verbatim, its own
 * duration) + the tracks of `base` for the bones the layer does NOT key.
 * Used when a pose library clip only animates part of the skeleton
 * (Popcorn Shotgun TP_Hold / TP_Run) so no bone falls back to the bind
 * pose. `base` must share the layer duration or be a constant pose.
 */
function overlayClip(base: THREE.AnimationClip, layer: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const keyed = new Set(layer.tracks.map((t) => trackBone(t.name)));
  const tracks: THREE.KeyframeTrack[] = layer.tracks.map((t) => t.clone());
  for (const track of base.tracks) {
    if (!keyed.has(trackBone(track.name))) tracks.push(track.clone());
  }
  return new THREE.AnimationClip(name, layer.duration, tracks);
}

/**
 * Merge the small skinned parts of the Potato (load time, ONCE on the
 * template — every clone inherits it): both eyes + mouth + teeth + leaf →
 * ONE skinned mesh (POTATO_DETAILS_MESH) with ONE material:
 *   - colour: the eye texture (eyes keep their UVs) × a per-vertex colour.
 *     The mouth / teeth / leaf were untextured flat colours: their UVs all
 *     point at the centre of a large uniform white block of the eye image
 *     (verified at load) and their vertex colour is their base colour
 *     divided by that texel → the exact same albedo;
 *   - roughness: a tiny palette texture read through `uv1` (one texel per
 *     part), metalness shared.
 * The body is NEVER touched (name + geometry are a contract: paint, wet
 * marks, astronaut masks). All parts share one skin and one parent, so the
 * merge is exact: same bones, same bind matrix, geometries concatenated.
 * If the eye texture does not have the expected white block, the eyes and
 * the accessories are merged separately (POTATO_EYES_MESH +
 * POTATO_ACCESSORIES_MESH, palette colours). Anything else unexpected
 * (renamed parts, another rig, textured accessories) → model left as-is.
 */
function consolidateCharacterParts(model: THREE.Object3D): void {
  const parts = new Map<string, THREE.SkinnedMesh>();
  model.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) parts.set(sm.name, sm);
  });
  const body = parts.get(POTATO_BODY_MESH);
  if (!body?.parent) return;
  const find = (names: readonly string[]) => names.map((n) => parts.get(n) ?? parts.get(THREE.PropertyBinding.sanitizeNodeName(n)));
  const eyes = find(EYE_PARTS);
  const accessories = find(ACCESSORY_PARTS);
  if ([...eyes, ...accessories].some((m) => !m)) return;
  const eyeMeshes = eyes as THREE.SkinnedMesh[];
  const accMeshes = accessories as THREE.SkinnedMesh[];
  const sameBinding = (m: THREE.SkinnedMesh) =>
    m.parent === body.parent &&
    sameRig(m.skeleton, body.skeleton) &&
    m.bindMatrix.equals(body.bindMatrix) &&
    m.position.equals(body.position) &&
    m.quaternion.equals(body.quaternion) &&
    m.scale.equals(body.scale) &&
    !Array.isArray(m.material) &&
    (m.material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
  if (![...eyeMeshes, ...accMeshes].every(sameBinding)) return;

  // Eyes: the plain material (the other copy only differs by an all-white
  // COLOR_0 attribute, which made GLTFLoader compile a vertex-colour variant).
  const eyeMats = eyeMeshes.map((m) => m.material as THREE.MeshStandardMaterial);
  const eyeMaterial = eyeMats.find((m) => !m.vertexColors) ?? eyeMats[0];
  const accMats = accMeshes.map((m) => m.material as THREE.MeshStandardMaterial);
  const plain = (m: THREE.MeshStandardMaterial) =>
    !m.roughnessMap && !m.metalnessMap && !m.normalMap && !m.emissiveMap && !m.aoMap && !m.alphaMap && !m.transparent;
  if (!accMats.every((m) => plain(m) && !m.map) || !eyeMats.every(plain)) return;

  const KEEP = ["position", "normal", "uv", "skinIndex", "skinWeight"];
  const prepare = (m: THREE.SkinnedMesh): THREE.BufferGeometry | null => {
    const g = m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
    if (KEEP.some((name) => !g.getAttribute(name))) return null;
    g.morphAttributes = {};
    g.clearGroups();
    return g;
  };
  const replace = (sources: THREE.SkinnedMesh[], geometry: THREE.BufferGeometry, material: THREE.Material, name: string) => {
    const merged = new THREE.SkinnedMesh(geometry, material);
    merged.name = name;
    merged.position.copy(body.position);
    merged.quaternion.copy(body.quaternion);
    merged.scale.copy(body.scale);
    merged.bind(body.skeleton, body.bindMatrix);
    body.parent!.add(merged);
    for (const m of sources) {
      m.removeFromParent();
      m.geometry.dispose();
    }
  };
  const fillUv = (g: THREE.BufferGeometry, name: string, u: number, v: number) => {
    const count = g.getAttribute("position").count;
    const data = new Float32Array(count * 2);
    for (let k = 0; k < count; k++) {
      data[k * 2] = u;
      data[k * 2 + 1] = v;
    }
    g.setAttribute(name, new THREE.Float32BufferAttribute(data, 2));
  };
  const fillColor = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const count = g.getAttribute("position").count;
    const data = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) data.set([c.r, c.g, c.b], k * 3);
    g.setAttribute("color", new THREE.Float32BufferAttribute(data, 3));
  };
  /** n-texel palette (sRGB colours or linear values), nearest, no mipmaps. */
  const palette = (data: Uint8Array, n: number, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
    t.colorSpace = colorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const roughnessTexels = (values: number[]) => {
    const data = new Uint8Array(values.length * 4);
    values.forEach((r, i) => {
      const b = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255);
      data.set([b, b, b, 255], i * 4);
    });
    return palette(data, values.length, THREE.NoColorSpace);
  };
  const metalness = eyeMaterial.metalness;
  const sameMetal = accMats.every((m) => m.metalness === metalness);

  // ---- ONE details mesh (needs a uniform white block in the eye image) ----
  const white = sameMetal ? eyeWhiteTexel(eyeMaterial.map) : null;
  if (white) {
    const pieces: THREE.BufferGeometry[] = [];
    const rough: number[] = [];
    const color = new THREE.Color();
    eyeMeshes.forEach((m, i) => {
      const g = prepare(m);
      if (!g) return;
      fillColor(g, color.setRGB(1, 1, 1));
      rough.push(eyeMats[i].roughness);
      pieces.push(g);
    });
    accMeshes.forEach((m, i) => {
      const g = prepare(m);
      if (!g) return;
      fillUv(g, "uv", white.u, white.v);
      // Albedo = texel × vertex colour → vertex colour = base / texel.
      const base = accMats[i].color;
      fillColor(g, color.setRGB(base.r / white.linear, base.g / white.linear, base.b / white.linear));
      rough.push(accMats[i].roughness);
      pieces.push(g);
    });
    if (pieces.length === eyeMeshes.length + accMeshes.length) {
      const n = rough.length;
      pieces.forEach((g, i) => fillUv(g, "uv1", (i + 0.5) / n, 0.5));
      const geometry = mergeGeometries(pieces, false);
      pieces.forEach((g) => g.dispose());
      if (geometry) {
        const roughnessMap = roughnessTexels(rough);
        roughnessMap.channel = 1;
        const material = new THREE.MeshStandardMaterial({
          name: "Details",
          map: eyeMaterial.map,
          vertexColors: true,
          roughness: 1,
          roughnessMap,
          metalness,
          side: eyeMaterial.side,
        });
        geometry.name = POTATO_DETAILS_MESH;
        replace([...eyeMeshes, ...accMeshes], geometry, material, POTATO_DETAILS_MESH);
        for (const m of new Set([...eyeMats, ...accMats])) m.dispose(); // (the eye texture lives on in `material`)
        return;
      }
    } else {
      pieces.forEach((g) => g.dispose());
    }
  }

  // ---- Fallback: eyes merged together, accessories merged (palette) ----
  const eyeGeoms = eyeMeshes.map(prepare);
  const eyeGeometry = eyeGeoms.every(Boolean) ? mergeGeometries(eyeGeoms as THREE.BufferGeometry[], false) : null;
  eyeGeoms.forEach((g) => g?.dispose());
  if (!eyeGeometry) return;
  for (const m of eyeMats) if (m !== eyeMaterial) m.dispose();
  eyeMaterial.vertexColors = false;
  eyeMaterial.name = "Eyes";
  eyeGeometry.name = POTATO_EYES_MESH;
  replace(eyeMeshes, eyeGeometry, eyeMaterial, POTATO_EYES_MESH);

  const n = accMeshes.length;
  const colors = new Uint8Array(n * 4);
  const srgb = new THREE.Color();
  accMats.forEach((m, i) => {
    // material.color is LINEAR (three colour management) → sRGB texel.
    srgb.copy(m.color).convertLinearToSRGB();
    colors.set([Math.round(srgb.r * 255), Math.round(srgb.g * 255), Math.round(srgb.b * 255), 255], i * 4);
  });
  const accGeoms = accMeshes.map(prepare);
  if (accGeoms.some((g) => !g)) {
    accGeoms.forEach((g) => g?.dispose());
    return;
  }
  accGeoms.forEach((g, i) => fillUv(g!, "uv", (i + 0.5) / n, 0.5));
  const accGeometry = mergeGeometries(accGeoms as THREE.BufferGeometry[], false);
  accGeoms.forEach((g) => g?.dispose());
  if (!accGeometry) return;
  const accMaterial = new THREE.MeshStandardMaterial({
    name: "Accessories",
    map: palette(colors, n, THREE.SRGBColorSpace),
    roughnessMap: roughnessTexels(accMats.map((m) => m.roughness)),
    roughness: 1,
    metalness: accMats[0].metalness,
    side: accMats[0].side,
  });
  accGeometry.name = POTATO_ACCESSORIES_MESH;
  replace(accMeshes, accGeometry, accMaterial, POTATO_ACCESSORIES_MESH);
  for (const m of accMats) m.dispose();
}

/**
 * Centre of a uniform, opaque, near-white 9 × 9 block of the Potato eye
 * image (asset-specific location, VERIFIED on the decoded pixels) — the
 * flat-coloured parts sample it. Null when the image differs / is not
 * readable (→ fallback path, no visual change).
 */
const EYE_WHITE_PX = { x: 741, y: 1382 } as const;
function eyeWhiteTexel(map: THREE.Texture | null): { u: number; v: number; linear: number } | null {
  const image = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!map || !image || !image.width || !image.height || map.flipY) return null;
  if (map.repeat.x !== 1 || map.repeat.y !== 1 || map.offset.x !== 0 || map.offset.y !== 0 || map.rotation !== 0) return null;
  const R = 4;
  const { x, y } = EYE_WHITE_PX;
  if (x - R < 0 || y - R < 0 || x + R >= image.width || y + R >= image.height) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2 * R + 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, x - R, y - R, 2 * R + 1, 2 * R + 1, 0, 0, 2 * R + 1, 2 * R + 1);
    const d = ctx.getImageData(0, 0, 2 * R + 1, 2 * R + 1).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[0] || d[i + 2] !== d[0] || d[i + 3] !== 255) return null;
    }
    if (d[0] < 240) return null;
    const value = d[0] / 255;
    // (THREE.SRGBToLinear is typed but not exported by the three build.)
    const linear =
      map.colorSpace === THREE.SRGBColorSpace ? new THREE.Color().setRGB(value, value, value, THREE.SRGBColorSpace).r : value;
    return { u: (x + 0.5) / image.width, v: (y + 0.5) / image.height, linear };
  } catch {
    return null; // tainted / undecodable image
  }
}

/** Bounding-sphere inflation factor for skinned culling (see above). */
const SKINNED_CULL_MARGIN = 2.5;

/**
 * Inflate a geometry's bounding sphere so frustum culling stays valid
 * for every animated pose. Idempotent — geometries shared between the
 * body mesh and its rim duplicate are only inflated once.
 */
/**
 * One outline hull geometry for skinned parts that share the SAME binding
 * (parent, bones, bind matrix, local transform): the parts' positions /
 * normals / skin attributes merged as float data (in the shared mesh space),
 * with the union of the parts' inflated culling spheres. Null when the parts
 * differ in any of these (one hull per part then, as before).
 */
function mergedOutlineHull(
  parts: readonly THREE.SkinnedMesh[],
): { geometry: THREE.BufferGeometry; bounds: THREE.Sphere } | null {
  if (parts.length < 2) return null;
  const ref = parts[0];
  const same = (m: THREE.SkinnedMesh) =>
    m.parent === ref.parent &&
    sameRig(m.skeleton, ref.skeleton) &&
    m.bindMatrix.equals(ref.bindMatrix) &&
    m.position.equals(ref.position) &&
    m.quaternion.equals(ref.quaternion) &&
    m.scale.equals(ref.scale);
  if (!parts.every(same)) return null;
  const pieces: THREE.BufferGeometry[] = [];
  const bounds = new THREE.Sphere();
  for (const part of parts) {
    const src = part.geometry;
    const g = new THREE.BufferGeometry();
    for (const [name, type] of [
      ["position", Float32Array],
      ["normal", Float32Array],
      ["skinIndex", Uint16Array],
      ["skinWeight", Float32Array],
    ] as const) {
      const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a) return null;
      const out = new type(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
      }
      g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
    }
    if (src.index) g.setIndex(src.index.clone());
    else g.setIndex([...Array(g.getAttribute("position").count).keys()]);
    pieces.push(g);
    inflateCullingBounds(src);
    if (src.boundingSphere) {
      if (bounds.isEmpty()) bounds.copy(src.boundingSphere);
      else bounds.union(src.boundingSphere);
    }
  }
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (!geometry) return null;
  geometry.name = "Potato_OutlineHull";
  return { geometry, bounds };
}

function inflateCullingBounds(geometry: THREE.BufferGeometry): void {
  if (geometry.userData.cullBoundsInflated) return;
  geometry.userData.cullBoundsInflated = true;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius *= SKINNED_CULL_MARGIN;
}

/**
 * three.js frustum-tests a SkinnedMesh with its OWN `boundingSphere`, not
 * the geometry's: left null, the renderer computes it once per clone with a
 * full CPU skinning pass over every vertex (a hitch at each bot / avatar
 * spawn) and the result is NOT inflated (popping on animated poses). Give
 * the template mesh the inflated geometry sphere — SkinnedMesh.copy() clones
 * it into every SkeletonUtils clone for free.
 */
function adoptCullingBounds(mesh: THREE.Mesh): void {
  const sm = mesh as THREE.SkinnedMesh;
  if (!sm.isSkinnedMesh) return;
  inflateCullingBounds(sm.geometry);
  if (sm.geometry.boundingSphere) sm.boundingSphere = sm.geometry.boundingSphere.clone();
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
