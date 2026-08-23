import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MovementConfig as moveCfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import type { RemoteCharacterClips } from "../network/remote/RemotePlayerAnimationController";
// Character GLB (mesh + skeleton + "Alert" idle clip) — loaded ONCE, cloned
// per avatar. The run/jump/slide clips live in sibling GLBs (same skeleton).
//
// NOTE: the Meshy "Sprouty Smile" export FILENAMES are mislabeled — each
// file's actual clip was verified with scripts/inspect-glb.mjs and the
// clips are always selected by CLIP NAME, never by filename:
//   Regular_Jump_withSkin.glb → "Armature|Alert|baselayer"        (IDLE)
//   Walking_withSkin.glb      → "Armature|running|baselayer"      (RUN)
//   Running_withSkin.glb      → "Armature|Regular_Jump|baselayer" (JUMP)
//   Character_output.glb      → "Armature|slide_right|baselayer"  (SLIDE)
import characterUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Regular_Jump_withSkin.glb?url";
import runClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Walking_withSkin.glb?url";
import jumpClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Running_withSkin.glb?url";
import slideClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Character_output.glb?url";

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
 * Shared, cached Sprouty Smile character asset (load once → clone per
 * avatar). Used by BOTH the multiplayer remote avatars AND the solo bots —
 * every humanoid enemy in the game shares this exact model + animations.
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
    loader.loadAsync(runClipUrl),
    loader.loadAsync(jumpClipUrl),
    loader.loadAsync(slideClipUrl),
  ]).then(([gltf, runGltf, jumpGltf, slideGltf]: [GLTF, GLTF, GLTF, GLTF]) => {
    const model = gltf.scene;

    // Normalize ONCE on the template: target height, feet at local y = 0,
    // facing -Z at yaw 0. Clones inherit this for free.
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
        // Skinned bounds move with the animation; avoid stale-culling pops.
        mesh.frustumCulled = false;
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
      rim.frustumCulled = false;
      rim.userData.enemyRim = true;
      // Purely visual: never a raycast target.
      rim.raycast = () => {};
      src.parent!.add(rim);
    }

    // Wrap in a container so the clone root is a plain, unrotated group.
    const template = new THREE.Group();
    template.add(model);

    // Real clips (inspected in the assets): "Armature|Alert|baselayer"
    // (idle), "Armature|running|baselayer" (run),
    // "Armature|Regular_Jump|baselayer" (jump) and
    // "Armature|slide_right|baselayer" (slide). Same skeleton — the clips
    // retarget onto every clone by bone name.
    const idle =
      gltf.animations?.find((c) => /alert|idle/i.test(c.name)) ?? gltf.animations?.[0];
    const run =
      runGltf.animations?.find((c) => /run/i.test(c.name)) ?? runGltf.animations?.[0];
    const jump =
      jumpGltf.animations?.find((c) => /jump/i.test(c.name)) ?? jumpGltf.animations?.[0];
    const slide =
      slideGltf.animations?.find((c) => /slide/i.test(c.name)) ?? slideGltf.animations?.[0];
    if (!idle || !run || !jump || !slide) throw new Error("Remote character clips missing");

    // The jump clip carries hips ROOT MOTION (the character rises inside
    // the clip). The avatar's actual jump arc already comes from the
    // GAME position — keeping both would double the motion and leave
    // the model floating above its capsule. Flatten the hips translation.
    // (Verified offline with scripts/inspect-glb-hips.mjs on the Sprouty
    // Smile export: Hips.translation is the ONLY animated position track
    // in the jump GLB — Y 27→60 cm, pinned to its first key 38.1 cm.
    // No Armature/Root-level position track exists.)
    stripHipsRootMotion(jump);
    // The slide clip travels ~1.9 m forward (baked hips X/Z motion) — the
    // game position provides the real travel, so flatten X/Z. The hips
    // Y is KEPT: it carries the crouch (drop to the ground) of the slide
    // pose itself, which must play on the spot.
    stripHipsRootMotion(slide, { keepY: true });

    const clips: RemoteCharacterClips = { idle, run, jump, slide };
    return { template, clips };
  });
  return cachedCharacter;
}

/**
 * Flatten the Hips translation track of a clip to its FIRST keyframe:
 * removes the baked root motion (vertical jump arc / forward travel)
 * while keeping every rotation — the character animates in place and the
 * GAME position provides the real trajectory.
 *
 * `keepY` preserves the vertical hips channel: used for clips where the
 * hips height IS the pose (slide crouch) rather than world travel.
 */
export function stripHipsRootMotion(
  clip: THREE.AnimationClip,
  { keepY = false }: { keepY?: boolean } = {},
): void {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/i.test(track.name)) continue;
    const values = track.values;
    for (let i = 3; i < values.length; i += 3) {
      values[i] = values[0];
      if (!keepY) values[i + 1] = values[1];
      values[i + 2] = values[2];
    }
  }
}