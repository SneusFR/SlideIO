import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { MovementConfig as mc } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { HitZone } from "../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";
import { NetworkMovementState } from "../network/NetworkMovementState";
import { shortestAngleDelta } from "../network/interpolation/SnapshotBuffer";
import { RemotePlayerAnimationController } from "../network/remote/RemotePlayerAnimationController";
import {
  loadRemoteWeaponTemplate,
  REMOTE_WEAPON_CONFIG,
} from "../network/remote/RemoteWeaponController";
import { NetworkWeaponId } from "../../shared/combat/NetworkWeapons";
import {
  loadCharacterAsset,
  stripEnemyOutline,
  FEET_OFFSET,
  MODEL_TOP,
  CHARACTER_HEIGHT,
  POTATO_BONES,
} from "../characters/PotatoCharacter";
import { CHARACTER_HITBOX_SCALE } from "../../shared/combat/NetworkWeapons";
import { CharacterOutfitSlot } from "../cosmetics/astronaut/AstronautRuntime";
import type { CharacterCosmeticsSelection } from "../../shared/combat/CharacterCosmetics";

/** Per-frame pose data fed by the Bot (drives the animation state). */
export interface BotPose {
  /** Horizontal speed (m/s). */
  speed: number;
  /** Body facing (radians). */
  yaw: number;
  /** Aim pitch (radians). */
  pitch: number;
  sliding: boolean;
  grounded: boolean;
  dashing: boolean;
  /** Vertical velocity (m/s) — falling hint for the airborne pose. */
  velocityY: number;
  /** Horizontal velocity components (direction-aware legs). */
  vx: number;
  vz: number;
}

/** Vertical extent of the HEAD hit zone (m): base 1.80 m calibration
 *  (0.35) × the CENTRAL hitbox scale (shared with the server hit sphere). */
const HEAD_ZONE_HEIGHT = 0.35 * CHARACTER_HITBOX_SCALE;
/** Head bone (jaw line) height as a fraction of the model height —
 *  measured on the Potato rest pose (scripts/inspect-glb-proportions.mjs:
 *  Head restY 0.5624 / native height 0.83545). */
const HEAD_JAW_FRACTION = 0.6731;
/** Cranium top as a fraction of the model height, PLANT LEAF EXCLUDED
 *  (body mesh max y 0.779 / 0.83545 — Plant_Root starts right above at
 *  0.926: leaf shots are never headshots). */
const HEAD_TOP_FRACTION = 0.9324;
/**
 * World-up offset from the Potato Head JOINT to the head volume's visual
 * center (m): midpoint of the jaw→cranium-top span on the SCALED rig
 * (CHARACTER_HEIGHT already carries the central 1.25 factor). The bone's
 * WORLD position is ALREADY at model scale (the template is normalized to
 * CHARACTER_HEIGHT), so the factor is NEVER applied to it a second time —
 * this constant offset alone carries the scaled calibration.
 */
const HEAD_BONE_CENTER_OFFSET =
  ((HEAD_TOP_FRACTION - HEAD_JAW_FRACTION) / 2) * CHARACTER_HEIGHT; // ≈ 0.29
/** Enemy UI heights above the capsule center (model is MODEL_TOP tall). */
const HEALTHBAR_HEIGHT = MODEL_TOP + 0.24;

// ---- Shared enemy-readability resources (created once for all bots) ----

/** "BOT" nameplate texture + material, shared by every bot. */
let labelMat: THREE.MeshBasicMaterial | null = null;
function getLabelMaterial(): THREE.MeshBasicMaterial {
  if (!labelMat) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 96);
    ctx.font = "bold 60px Consolas, 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(8, 10, 14, 0.9)";
    ctx.strokeText("BOT", 128, 50);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("BOT", 128, 50);
    const tex = new THREE.CanvasTexture(canvas);
    labelMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    labelMat.userData.shared = true;
  }
  return labelMat;
}

/**
 * Bot avatar: the SAME Potato skinned character as the human
 * players (multiplayer remote avatars), driven by the SAME animation
 * controller (idle / run / jump / slide clips), holding a real Plasma
 * Rifle GLB and wearing the same red rim glow.
 *
 *   - The shared character asset loads asynchronously (cached — one fetch
 *     for the whole game). Until it resolves, the bot is fully playable:
 *     invisible capsule-shaped hitboxes carry the raycast gameplay.
 *   - Hit detection: the visible skinned meshes are NEVER raycast
 *     targets (expensive + imprecise). Invisible primitive hitboxes do
 *     the job — a body box matching the physics capsule plus a HEAD box
 *     that follows the actual Head bone (headshots track the animation).
 *   - Enemy readability (red rim + BOT label + HP bar) is toggled by
 *     `setSeen` with the REAL line-of-sight result — never through walls.
 */
export class BotModel {
  readonly group = new THREE.Group();

  /** Skinned character clone (null until the shared asset resolves). */
  private model: THREE.Object3D | null = null;
  private anim: RemotePlayerAnimationController | null = null;
  /** Red contour hull meshes of THIS clone (visibility follows setSeen). */
  private readonly outlineMeshes: THREE.Object3D[] = [];
  /** Every material the damage flash drives (bot clones + outfit pieces). */
  private readonly flashMats: THREE.Material[] = [];
  /** Authored emissive of every flash material (restored between flashes). */
  private readonly flashBase = new Map<THREE.Material, THREE.Color>();
  /** Material clones OWNED by this bot (disposed with it) — never outfit ones. */
  private readonly ownedMats: THREE.Material[] = [];
  /** In-hand Plasma Rifle grip (muzzle anchor) — null until loaded. */
  private grip: THREE.Group | null = null;
  /**
   * OPTIONAL character outfit of this bot (nothing by default — bots never
   * inherit the local player's cosmetics; see setOutfit). Its pieces join
   * the LOS-toggled outline hulls and the damage-flash material list, and
   * leave them again when the outfit changes — the handle owns and
   * disposes its own material clones, the bot never double-disposes them.
   */
  private readonly outfit = new CharacterOutfitSlot({
    context: "tp",
    outline: true,
    outlineVisible: () => this.seen,
    onHullAdded: (hull) => {
      this.outlineMeshes.push(hull);
      return () => {
        const i = this.outlineMeshes.indexOf(hull);
        if (i >= 0) this.outlineMeshes.splice(i, 1);
      };
    },
    onMaterialsAdded: (materials) => {
      for (const mat of materials) this.registerFlashMaterial(mat);
      return () => {
        for (const mat of materials) this.unregisterFlashMaterial(mat);
      };
    },
  });

  // ---- Invisible hitboxes (raycast gameplay) ----
  private readonly bodyHitbox: THREE.Mesh;
  private readonly headHitbox: THREE.Mesh;
  private headBone: THREE.Object3D | null = null;

  // ---- Enemy UI ----
  private readonly healthBar: THREE.Group;
  private readonly healthFill: THREE.Mesh;
  private readonly nameLabel: THREE.Mesh;
  private seen = false;

  private flashAmount = 0;
  private headFlashAmount = 0;
  private disposed = false;
  /** DEBUG: wireframe overlay of the damage volumes currently shown. */
  private hitboxDebugOn = false;

  // scratch
  private readonly tmpA = new THREE.Vector3();

  constructor(_index: number) {
    // ---- Hitboxes (synchronous — gameplay never waits for the GLB) ----
    // DAMAGE volumes calibrated on the SCALED (2.25 m) silhouette via the
    // central CHARACTER_HITBOX_SCALE — the MOVEMENT capsule is untouched.
    // Head zone rest center: jaw→cranium-top midpoint of the scaled model
    // (≈ 1.81 m above the feet — the plant leaf above 2.08 m is excluded).
    const headCenterY = ((HEAD_JAW_FRACTION + HEAD_TOP_FRACTION) / 2) * CHARACTER_HEIGHT;
    // Body: FEET-ANCHORED box spanning feet → bottom of the head zone (no
    // dead gap between the two volumes), width scaled with the body.
    const bodyTop = headCenterY - HEAD_ZONE_HEIGHT / 2; // above the FEET
    const bodyWidth = mc.capsuleRadius * 2 * CHARACTER_HITBOX_SCALE;
    this.bodyHitbox = new THREE.Mesh(
      new THREE.BoxGeometry(bodyWidth, bodyTop, bodyWidth),
      HITBOX_MATERIAL,
    );
    // Group origin = capsule center (feet at -FEET_OFFSET, unscaled anchor).
    this.bodyHitbox.position.y = -FEET_OFFSET + bodyTop / 2;
    this.bodyHitbox.castShadow = false;

    // Head: fallback static box at the SCALED head height; re-anchored onto
    // the REAL Head bone as soon as the skinned model is attached (headshots
    // then track every animation, including the slide crouch).
    this.headHitbox = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_ZONE_HEIGHT, HEAD_ZONE_HEIGHT, HEAD_ZONE_HEIGHT),
      HITBOX_MATERIAL,
    );
    this.headHitbox.position.y = -FEET_OFFSET + headCenterY;
    this.headHitbox.castShadow = false;
    this.headHitbox.userData.hitZone = HitZone.HEAD;

    this.group.add(this.bodyHitbox, this.headHitbox);

    // ---- Enemy UI (billboarded, above the head): BOT + big red HP bar ----
    this.healthBar = new THREE.Group();
    this.healthBar.position.y = HEALTHBAR_HEIGHT;
    const barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.16),
      new THREE.MeshBasicMaterial({
        color: 0x14161c,
        transparent: true,
        opacity: 0.72,
        toneMapped: false,
      }),
    );
    this.healthFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.09, 0.115),
      new THREE.MeshBasicMaterial({ color: 0xef4444, toneMapped: false }),
    );
    this.healthFill.position.z = 0.002;
    this.nameLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.195), getLabelMaterial());
    this.nameLabel.position.y = 0.19;
    this.nameLabel.visible = cc.enemyNameVisible;
    this.healthBar.add(barBg, this.healthFill, this.nameLabel);
    this.healthBar.visible = false; // hidden until the player actually sees the bot
    // UI planes must NEVER count as body hits for beam raycasts.
    barBg.raycast = NO_RAYCAST;
    this.healthFill.raycast = NO_RAYCAST;
    this.nameLabel.raycast = NO_RAYCAST;
    this.group.add(this.healthBar);

    // ---- Async: shared Potato character (cached — one load, N clones) ----
    void loadCharacterAsset().then((asset) => {
      if (this.disposed) return;

      // SkeletonUtils clone: shares geometry/materials/textures with the
      // cached template — cheap per bot.
      const model = skeletonClone(asset.template);
      // Group origin = CAPSULE CENTER; the model root is the feet.
      model.position.y = -FEET_OFFSET;
      this.model = model;
      this.group.add(model);

      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        // The skinned meshes are purely visual: the invisible hitboxes are
        // the ONLY raycast targets (cheap + zone-accurate).
        mesh.raycast = NO_RAYCAST;
        if (mesh.userData.enemyOutline) {
          // Red contour hull: same shared material as the remote players,
          // but toggled by line-of-sight visibility (never through walls).
          this.outlineMeshes.push(mesh);
          mesh.visible = this.seen && cc.enemyOutlineEnabled;
        } else {
          // Per-bot material clone(s) → the damage flash never tints the
          // template (and therefore never the remote players / menu).
          // Material[] exports are supported (one clone per entry).
          if (Array.isArray(mesh.material)) {
            const cloned = mesh.material.map((m) => m.clone());
            mesh.material = cloned;
            for (const m of cloned) {
              this.ownedMats.push(m);
              this.registerFlashMaterial(m);
            }
          } else {
            const cloned = (mesh.material as THREE.Material).clone();
            mesh.material = cloned;
            this.ownedMats.push(cloned);
            this.registerFlashMaterial(cloned);
          }
        }
      });
      // Outfit target = this clone (meshes + bones). Applies a selection
      // already requested through setOutfit (or nothing at all).
      this.outfit.setTarget(model);

      // Head hitbox follows the REAL Head bone from now on. The Potato
      // rig has no head-tip helper (and the plant leaf must NEVER count
      // as head — leaf shots are not headshots): the local offset is an
      // explicit constant above the Head bone (recalibrated on the rig).
      this.headBone = model.getObjectByName(POTATO_BONES.head) ?? null;

      // Same animations as the human players. slideRaise: 0 — the bot
      // capsule never shrinks, the crouch comes from the clip alone.
      this.anim = new RemotePlayerAnimationController(model, -FEET_OFFSET, asset.clips, {
        slideRaise: 0,
      });

      this.attachRifle(model);
    });
  }

  /**
   * Real Plasma Rifle GLB in the left hand. Bots KEEP their Plasma Rifle
   * gameplay — the Potato swap never equips them with the sniper. The
   * grip rides the Potato Weapon_L socket (child of Hand_L) with the
   * ancestor-scale compensation this legacy path requires; the pack ships
   * no Plasma poses, so the HexSniper TP matrices are never applied here.
   */
  private attachRifle(model: THREE.Object3D): void {
    void loadRemoteWeaponTemplate(NetworkWeaponId.PLASMA_RIFLE).then((template) => {
      if (this.disposed || this.model !== model) return;
      const att = REMOTE_WEAPON_CONFIG[NetworkWeaponId.PLASMA_RIFLE];
      if (!att) return;
      const bone = model.getObjectByName(att.bone);
      if (!bone) return;

      const weapon = template.clone(true);
      weapon.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) mesh.raycast = NO_RAYCAST; // visual only
      });

      const grip = new THREE.Group();
      grip.add(weapon);
      grip.position.copy(att.position);
      grip.rotation.copy(att.rotation);

      // Compensate every ancestor scale (character normalization +
      // armature) so the configured size stays a true world size.
      let accumulated = 1;
      let node: THREE.Object3D | null = bone;
      while (node) {
        accumulated *= node.scale.x;
        if (node === model) break;
        node = node.parent;
      }
      const inv = 1 / Math.max(Math.abs(accumulated), 1e-6);
      grip.scale.setScalar(inv);
      grip.position.multiplyScalar(inv);

      bone.add(grip);
      this.grip = grip;
    });
  }

  /**
   * DEBUG overlay (KeyH): render the DAMAGE volumes as wireframes — green
   * body box + red head box. Pure material swap (the raycast geometry is
   * untouched), state-guarded so calling it every frame is free. The head
   * box follows the animated Head bone (see update), so its placement can
   * be checked standing, running, jumping and sliding.
   */
  setHitboxDebug(on: boolean): void {
    if (on === this.hitboxDebugOn) return;
    this.hitboxDebugOn = on;
    this.bodyHitbox.material = on ? DEBUG_BODY_MATERIAL : HITBOX_MATERIAL;
    this.headHitbox.material = on ? DEBUG_HEAD_MATERIAL : HITBOX_MATERIAL;
  }

  /**
   * Toggle the enemy readability visuals (red contour + name + HP bar).
   * Called every frame by BotManager.updateVisibility with the REAL
   * line-of-sight result — nothing here ever shows through walls.
   */
  setSeen(seen: boolean): void {
    if (seen === this.seen) return;
    this.seen = seen;
    const outlineOn = seen && cc.enemyOutlineEnabled;
    for (const outline of this.outlineMeshes) outline.visible = outlineOn;
    this.healthBar.visible = seen && cc.enemyHealthBarVisible;
  }

  /** World position of the in-hand rifle (beam start anchor). */
  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.grip) return this.grip.getWorldPosition(out);
    // Fallback before the rifle GLB resolves: shoulder-ish offset.
    this.group.getWorldPosition(out);
    out.y += 0.2;
    return out;
  }

  /** Trigger the damage flash (throttle-friendly: just refreshes intensity). */
  flash(): void {
    this.flashAmount = 1;
  }

  /**
   * Zone-aware hit reaction from the local player's confirmed hits:
   * a headshot flashes brighter than a body hit.
   */
  hitFlash(zone: HitZone): void {
    if (zone === HitZone.HEAD) this.headFlashAmount = 1;
    else this.flashAmount = 1;
  }

  /**
   * Per-frame visual update (after physics, before render).
   *
   * @param pose         bot movement pose (drives the animation state)
   * @param hpRatio      0..1 health bar fill
   * @param camQuat      camera quaternion for billboarding
   * @param protectedNow spawn protection indicator (white pulse)
   */
  update(
    dt: number,
    pose: BotPose,
    hpRatio: number,
    camQuat: THREE.Quaternion,
    protectedNow: boolean,
    time: number,
  ): void {
    this.group.rotation.y = pose.yaw;

    // ---- Animation state (same mapping as the network movement states).
    // DASHING is tested BEFORE the airborne check: an air-dash must show
    // the real Dash clip — a plain !grounded test would mask it.
    let state = NetworkMovementState.IDLE;
    if (pose.sliding) state = NetworkMovementState.SLIDING;
    else if (pose.dashing) state = NetworkMovementState.DASHING;
    else if (!pose.grounded) state = NetworkMovementState.AIRBORNE;
    else if (pose.speed > 0.75) state = NetworkMovementState.RUNNING;

    // Direction-aware legs: signed angle between the aim yaw and the
    // actual movement direction (yaw convention: 0 → forward = -Z).
    let moveLocalYaw = 0;
    if (pose.speed > 0.1) {
      const moveYaw = Math.atan2(-pose.vx, -pose.vz);
      moveLocalYaw = shortestAngleDelta(pose.yaw, moveYaw);
    }
    this.anim?.update(dt, state, pose.speed, pose.velocityY, pose.pitch, moveLocalYaw);

    // ---- HEAD hitbox follows the real Head bone (animated headshots).
    // Explicit LOCAL offset above the bone (the Potato head volume sits
    // above its Head joint; no helper bone exists and the plant leaf is
    // deliberately NOT part of the head zone — leaf shots are body misses).
    if (this.headBone) {
      this.headBone.getWorldPosition(this.tmpA);
      this.tmpA.y += HEAD_BONE_CENTER_OFFSET;
      this.headHitbox.position.copy(this.group.worldToLocal(this.tmpA));
    }

    this.updateUI(dt, hpRatio, camQuat, protectedNow, time);
  }

  /**
   * Damage flash + enemy UI billboard. Split from update() so a KNOCKED
   * DOWN (ragdolled but ALIVE) bot keeps its health bar, its BOT label and
   * its damage feedback — otherwise it reads as dead while it isn't.
   * The red rim glow needs nothing here: the rim meshes are skinned to the
   * same bones the ragdoll drives, so they follow the tumbling body free.
   */
  updateUI(
    dt: number,
    hpRatio: number,
    camQuat: THREE.Quaternion,
    protectedNow: boolean,
    time: number,
  ): void {
    // ---- Damage flash (emissive on the per-bot cloned materials) ----
    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * hfc.bodyHitFlashDecay);
    }
    if (this.headFlashAmount > 0) {
      this.headFlashAmount = Math.max(0, this.headFlashAmount - dt * hfc.headHitFlashDecay);
    }
    let glow = Math.max(this.flashAmount * 0.55, this.headFlashAmount * 0.85);
    // Spawn protection: soft white pulse over the whole body.
    if (protectedNow) glow = Math.max(glow, 0.16 + 0.16 * Math.sin(time * 20));
    // Flash = authored emissive + white glow (the suit's original emission
    // is preserved, never overwritten by the flash scalar).
    for (const mat of this.flashMats) {
      const m = mat as THREE.MeshStandardMaterial;
      if (!m.emissive) continue;
      const base = this.flashBase.get(mat);
      if (base) m.emissive.copy(base).addScalar(glow);
      else m.emissive.setScalar(glow);
    }

    // Enemy UI: pure billboard (never rotates with the body) + fill.
    // The group itself rotates with the body yaw, so cancel it by applying
    // the camera quaternion in world terms (premultiply the inverse yaw).
    this.healthBar.quaternion
      .setFromAxisAngle(Y_AXIS, -this.group.rotation.y)
      .multiply(camQuat);
    this.healthFill.scale.x = Math.max(hpRatio, 0.001);
    this.healthFill.position.x = -0.545 * (1 - hpRatio);
  }

  /**
   * CORPSE SNAPSHOT (death ragdoll): SkeletonUtils clone of the posed
   * character (bones keep their CURRENT local transforms) placed at the
   * model's world transform. The clone shares geometries/textures with
   * the live model and keeps the full living look (skin + rifle in hand);
   * buildSkeletonRagdollParts() then builds the physical skeleton on it.
   * The enemy UI (health bar / nameplate) and the invisible hitboxes are
   * intentionally NOT part of the corpse.
   *
   * The corpse is fully independent: the bot can respawn elsewhere while
   * the body keeps simulating — it is never teleported to the new spawn.
   */
  createCorpseVisual(): THREE.Group {
    const corpse = new THREE.Group();
    corpse.position.copy(this.group.position);
    corpse.quaternion.copy(this.group.quaternion);
    corpse.scale.copy(this.group.scale);
    if (this.model) {
      const clone = skeletonClone(this.model);
      // A dead body is no longer a threat: the red enemy contour dies
      // with it (also keeps the shared outline material out of the
      // CorpseManager's fade clones).
      stripEnemyOutline(clone);
      corpse.add(clone);
      corpse.updateMatrixWorld(true);
    }
    return corpse;
  }

  /**
   * EXPLICIT cosmetic outfit for this bot (product rule: bots do NOT
   * automatically wear the local player's selection — nothing is applied
   * unless a caller asks). Empty selection = base look. Kept across the
   * asset load: a selection set before the clone exists applies on attach.
   */
  setOutfit(selection: CharacterCosmeticsSelection): void {
    this.outfit.setSelection(selection);
  }

  /** Join the damage-flash list (authored emissive remembered). */
  private registerFlashMaterial(mat: THREE.Material): void {
    if (this.flashMats.includes(mat)) return;
    this.flashMats.push(mat);
    const emissive = (mat as THREE.MeshStandardMaterial).emissive;
    if (emissive) this.flashBase.set(mat, emissive.clone());
  }

  /** Leave the damage-flash list (emissive restored; NOT disposed here). */
  private unregisterFlashMaterial(mat: THREE.Material): void {
    const i = this.flashMats.indexOf(mat);
    if (i >= 0) this.flashMats.splice(i, 1);
    const base = this.flashBase.get(mat);
    const emissive = (mat as THREE.MeshStandardMaterial).emissive;
    if (base && emissive) emissive.copy(base);
    this.flashBase.delete(mat);
  }

  dispose(): void {
    this.disposed = true;
    // Outfit first: its hooks unregister its hulls / materials, then the
    // handle disposes ITS OWN material clones (never touched below).
    this.outfit.dispose();
    this.anim?.dispose();
    this.anim = null;
    this.grip?.removeFromParent();
    this.grip = null;
    // Per-bot cloned materials only — the template/shared ones stay alive.
    for (const mat of this.ownedMats) mat.dispose();
    this.ownedMats.length = 0;
    this.flashMats.length = 0;
    this.flashBase.clear();
    this.bodyHitbox.geometry.dispose();
    this.headHitbox.geometry.dispose();
    this.healthBar.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material;
        if (!mat.userData.shared) mat.dispose();
      }
    });
  }
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const NO_RAYCAST = () => {};
/** Shared material for the invisible hitbox meshes (never rendered). */
const HITBOX_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });
HITBOX_MATERIAL.userData.shared = true;
/** Shared DEBUG wireframes (KeyH overlay): green = body, red = head.
 *  depthTest off so the volumes read through the character model. */
const DEBUG_BODY_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x22ff88,
  wireframe: true,
  toneMapped: false,
  depthTest: false,
  transparent: true,
  opacity: 0.9,
});
DEBUG_BODY_MATERIAL.userData.shared = true;
const DEBUG_HEAD_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xff3344,
  wireframe: true,
  toneMapped: false,
  depthTest: false,
  transparent: true,
  opacity: 0.9,
});
DEBUG_HEAD_MATERIAL.userData.shared = true;