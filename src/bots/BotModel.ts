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
  POTATO_BONES,
} from "../characters/PotatoCharacter";

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

/** Vertical extent reserved for the HEAD hit zone at the capsule top (m). */
const HEAD_ZONE_HEIGHT = 0.35;
/**
 * World-up offset from the Potato Head JOINT to the head volume's visual
 * center (m). Measured on the normalized rig: the Head bone sits at the
 * jaw line (~67% of the body height) and the cranium extends above it —
 * excluding the plant sprout, which is never part of the headshot zone.
 */
const HEAD_BONE_CENTER_OFFSET = 0.14;
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
  /** Per-bot cloned materials (damage flash via emissive — never shared). */
  private readonly flashMats: THREE.Material[] = [];
  /** In-hand Plasma Rifle grip (muzzle anchor) — null until loaded. */
  private grip: THREE.Group | null = null;

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

  // scratch
  private readonly tmpA = new THREE.Vector3();

  constructor(_index: number) {
    // ---- Hitboxes (synchronous — gameplay never waits for the GLB) ----
    // Body: matches the physics capsule (minus the head zone at the top).
    const bodyHeight = FEET_OFFSET * 2 - HEAD_ZONE_HEIGHT;
    this.bodyHitbox = new THREE.Mesh(
      new THREE.BoxGeometry(mc.capsuleRadius * 2, bodyHeight, mc.capsuleRadius * 2),
      HITBOX_MATERIAL,
    );
    this.bodyHitbox.position.y = -HEAD_ZONE_HEIGHT / 2;
    this.bodyHitbox.visible = false;
    this.bodyHitbox.castShadow = false;

    // Head: fallback static box at the capsule top; re-anchored onto the
    // REAL Head bone as soon as the skinned model is attached (headshots
    // then track every animation, including the slide crouch).
    this.headHitbox = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_ZONE_HEIGHT, HEAD_ZONE_HEIGHT, HEAD_ZONE_HEIGHT),
      HITBOX_MATERIAL,
    );
    this.headHitbox.position.y = FEET_OFFSET - HEAD_ZONE_HEIGHT / 2;
    this.headHitbox.visible = false;
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
          // Per-bot material clone → the damage flash never tints the
          // template (and therefore never the remote players / menu).
          const mat = mesh.material as THREE.Material;
          const cloned = mat.clone();
          mesh.material = cloned;
          this.flashMats.push(cloned);
        }
      });

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
    for (const mat of this.flashMats) {
      const m = mat as THREE.MeshStandardMaterial;
      if (m.emissive) m.emissive.setScalar(glow);
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

  dispose(): void {
    this.disposed = true;
    this.anim?.dispose();
    this.anim = null;
    this.grip?.removeFromParent();
    this.grip = null;
    // Per-bot cloned materials only — the template/shared ones stay alive.
    for (const mat of this.flashMats) mat.dispose();
    this.flashMats.length = 0;
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