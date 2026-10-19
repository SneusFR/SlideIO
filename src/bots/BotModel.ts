import * as THREE from "three";
import { EnemyHealthBars, type EnemyHealthBarSlot } from "./EnemyHealthBars";
import { skipFreshMatrixUpdate } from "../effects/matrixFresh";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CorpseCloneSpare, cloneCorpseModel } from "../ragdoll/CorpseCloneSpare";
import { MovementConfig as mc } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { HitZone } from "../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";
import { NetworkMovementState } from "../network/NetworkMovementState";
import { shortestAngleDelta } from "../network/interpolation/SnapshotBuffer";
import { RemotePlayerAnimationController } from "../network/remote/RemotePlayerAnimationController";
import { RemoteWeaponController } from "../network/remote/RemoteWeaponController";
import type { FrisbeeCageDrop } from "../weapons/frisbee/FrisbeeLauncherController";
import {
  loadCharacterAsset,
  shareOutlineSkeletons,
  FEET_OFFSET,
  MODEL_TOP,
  CHARACTER_HEIGHT,
  POTATO_BONES,
} from "../characters/PotatoCharacter";
import { CHARACTER_HITBOX_SCALE } from "../../shared/combat/NetworkWeapons";
import { CharacterOutfitSlot } from "../cosmetics/astronaut/AstronautRuntime";
import type { CharacterCosmeticsSelection } from "../../shared/combat/CharacterCosmetics";

/**
 * World hooks of the bot's third-person weapon (same wiring as a remote
 * avatar): the world scene (Hex tether, dropped hoppers), the floor height
 * for dropped hoppers and the thrown frisbee cages.
 */
export interface BotModelEnv {
  scene: THREE.Object3D;
  groundY?: ((x: number, z: number) => number) | null;
  onFrisbeeCageDrop?: ((drop: FrisbeeCageDrop) => void) | null;
}

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

/** "BOT" nameplate texture, shared by every bot. */
let labelTexture: THREE.CanvasTexture | null = null;
function getLabelTexture(): THREE.CanvasTexture {
  if (!labelTexture) {
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
    labelTexture = new THREE.CanvasTexture(canvas);
  }
  return labelTexture;
}

/**
 * Enemy UI of every bot (dark bar 1.15 × 0.16 at 72 % + red fill + "BOT"
 * nameplate) — ONE instanced draw call for the whole scene (EnemyHealthBars).
 */
function healthBarsOf(scene: THREE.Object3D): EnemyHealthBars {
  return EnemyHealthBars.for(scene, {
    label: getLabelTexture(),
    bgColor: 0x14161c,
    bgOpacity: 0.72,
    fillColor: 0xef4444,
    showName: () => cc.enemyNameVisible,
  });
}

/**
 * GPU warm-up (Game.warmUpRendering): one enemy health bar shown at `at`
 * for the warm renders, so the shared batch's program compiles and the
 * "BOT" label uploads during the loading screen — never on the first bot
 * that comes into view. Call the returned function once the warm renders
 * are done.
 */
export function warmUpEnemyHealthBars(scene: THREE.Object3D, at: THREE.Vector3): () => void {
  const slot = healthBarsOf(scene).acquire();
  slot.set(at, new THREE.Quaternion(), 1);
  slot.setVisible(true);
  return () => slot.release();
}

/**
 * Bot avatar: the SAME Potato skinned character as the human
 * players (multiplayer remote avatars), driven by the SAME animation
 * controller (idle / run / jump / slide clips + the armed TP pose sets),
 * holding its REAL primary through the SAME RemoteWeaponController as the
 * remote players (weapon GLB, TP fire / reload clips), with the same red
 * rim glow.
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
  /** Corpse clone built ahead of the kill frame (see prepareCorpseVisual). */
  private readonly corpseSpare = new CorpseCloneSpare();
  private anim: RemotePlayerAnimationController | null = null;
  /** Red contour hull meshes of THIS clone (visibility follows setSeen). */
  private readonly outlineMeshes: THREE.Object3D[] = [];
  /** Every material the damage flash drives (bot clones + outfit pieces). */
  private readonly flashMats: THREE.Material[] = [];
  /** Authored emissive of every flash material (restored between flashes). */
  private readonly flashBase = new Map<THREE.Material, THREE.Color>();
  /** Material clones OWNED by this bot (disposed with it) — never outfit ones. */
  private readonly ownedMats: THREE.Material[] = [];
  /** Third-person weapon presentation — null until the character loads. */
  weapons: RemoteWeaponController | null = null;
  /** Primary requested before the character resolved (applied on attach). */
  private wantedWeapon: string | null = null;
  private grounded = true;
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
  private hitboxList: THREE.Object3D[] = [];

  // ---- Enemy UI (slot of the scene's shared instanced batch) ----
  private healthBar: EnemyHealthBarSlot | null = null;
  /** Line of sight says "show the bar" (setSeen). */
  private healthBarWanted = false;
  private seen = false;

  private flashAmount = 0;
  private headFlashAmount = 0;
  private disposed = false;
  /** DEBUG: wireframe overlay of the damage volumes currently shown. */
  private hitboxDebugOn = false;

  // scratch
  private readonly tmpA = new THREE.Vector3();

  constructor(
    _index: number,
    private readonly env: BotModelEnv | null = null,
  ) {
    // PERF: final after Game.frame's matrix pass — the renderer skips it (see matrixFresh).
    skipFreshMatrixUpdate(this.group);
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
    this.hitboxList = [this.bodyHitbox, this.headHitbox];

    // ---- Enemy UI (billboarded, above the head): BOT + big red HP bar ----
    // One slot of the scene's shared instanced batch (acquired lazily in
    // updateUI once the group is in the scene) — hidden until seen.

    // ---- Async: shared Potato character (cached — one load, N clones) ----
    void loadCharacterAsset().then((asset) => {
      if (this.disposed) return;

      // SkeletonUtils clone: shares geometry/materials/textures with the
      // cached template — cheap per bot.
      const model = skeletonClone(asset.template);
      // Group origin = CAPSULE CENTER; the model root is the feet.
      model.position.y = -FEET_OFFSET;
      shareOutlineSkeletons(model); // ONE skeleton update + bone upload per bot
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

      this.attachWeapons(model);
    });
  }

  /** Same wiring as RemotePlayer: armed pose set, TP action clips, basket clock. */
  private attachWeapons(model: THREE.Object3D): void {
    const weapons = new RemoteWeaponController(model, this.env?.scene ?? null);
    weapons.onArmedChanged = (profileId) => this.anim?.setArmedProfile(profileId);
    weapons.onProfileAction = (kind, options) => {
      if (kind === null) this.anim?.clearOverride();
      else this.anim?.playOverride(kind, options);
    };
    weapons.presentationClock = () => this.anim?.presentationClock() ?? { clip: null, time: 0 };
    weapons.isGrounded = () => this.grounded;
    weapons.viewerPosition = () => null;
    weapons.paintballDropParent = this.env?.scene ?? null;
    weapons.paintballGroundY = this.env?.groundY ?? null;
    weapons.onFrisbeeCageDrop = (drop) => this.env?.onFrisbeeCageDrop?.(drop);
    this.weapons = weapons;
    if (this.wantedWeapon) weapons.setWeapon(this.wantedWeapon);
  }

  /** Equip `id` in the hand (applied as soon as the character exists). */
  setWeapon(id: string): void {
    this.wantedWeapon = id;
    this.weapons?.setWeapon(id);
  }

  /** Death / respawn: drop every replayed weapon action, full ammo display. */
  resetWeaponState(): void {
    const w = this.weapons;
    if (!w) return;
    w.basketReset();
    w.popcornReset();
    w.paintballReset();
    w.famasReset();
    w.frisbeeReset();
    w.hexReset();
  }

  /** Raycast targets of this bot: ONLY the two damage volumes (cheap). */
  get hitboxes(): readonly THREE.Object3D[] {
    return this.hitboxList;
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
    this.healthBarWanted = seen && cc.enemyHealthBarVisible;
    this.healthBar?.setVisible(this.healthBarWanted && this.group.visible);
  }

  /** World position of the in-hand weapon muzzle. */
  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.weapons?.getMuzzleWorldPosition(out)) return out;
    // Fallback before the weapon GLB resolves: shoulder-ish offset.
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
    this.grounded = pose.grounded;
    // Weapon clips first (same order as RemotePlayer), then the character
    // mixer, then the cosmetic pass that reads the animated arm clock.
    this.weapons?.update(dt);
    this.anim?.update(dt, state, pose.speed, pose.velocityY, pose.pitch, moveLocalYaw);
    this.weapons?.updateCosmetics(dt);

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

    // Enemy UI: pure billboard (camera rotation in WORLD terms — never
    // rotates with the body), HEALTHBAR_HEIGHT above the capsule centre
    // (the group is a scene child rotating about Y only) + fill ratio.
    if (!this.healthBar) {
      const scene = this.env?.scene ?? this.group.parent;
      if (scene) this.healthBar = healthBarsOf(scene).acquire();
    }
    if (this.healthBar) {
      this.tmpA.copy(this.group.position);
      this.tmpA.y += HEALTHBAR_HEIGHT;
      this.healthBar.set(this.tmpA, camQuat, hpRatio);
      this.healthBar.setVisible(this.healthBarWanted && this.group.visible);
    }
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
      // PERF: the clone prepared on a calm frame, brought to the current
      // pose/materials — the same object cloneCorpseModel would build now.
      // The full clone only when the body changed shape since (or none yet).
      const clone = this.corpseSpare.take(this.model) ?? cloneCorpseModel(this.model);
      corpse.add(clone);
      corpse.updateMatrixWorld(true);
    }
    return corpse;
  }

  /**
   * PERF — build the corpse clone NOW, outside the kill frame (Bot calls
   * this on calm frames of each life). A spare that no longer matches the
   * body (weapon or outfit changed since) is rebuilt; a matching one is
   * kept (cheap check). See CorpseCloneSpare.
   */
  prepareCorpseVisual(): void {
    if (!this.model || this.corpseSpare.matches(this.model)) return;
    this.corpseSpare.prepare(this.model);
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

  /** Skinned character clone (null until the shared asset resolves) — paint target. */
  get characterModel(): THREE.Object3D | null {
    return this.model;
  }

  /**
   * A body mesh got new private materials (Paintball Rifle paint patch —
   * clones of the bot's own clones): the damage flash follows the new ones,
   * and they are disposed with the bot like every owned material.
   */
  replaceBodyMaterials(previous: THREE.Material[], next: THREE.Material[]): void {
    for (const mat of previous) {
      this.unregisterFlashMaterial(mat);
      // Paint clones leaving the body are disposed by their owner (paint
      // detach) — never a second time here. The bot's own clones stay owned.
      if (mat.userData.corpsePoolEphemeral) {
        const i = this.ownedMats.indexOf(mat);
        if (i >= 0) this.ownedMats.splice(i, 1);
      }
    }
    for (const mat of next) {
      this.registerFlashMaterial(mat);
      if (!this.ownedMats.includes(mat)) this.ownedMats.push(mat);
    }
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
    this.weapons?.dispose();
    this.weapons = null;
    // Per-bot cloned materials only — the template/shared ones stay alive.
    for (const mat of this.ownedMats) mat.dispose();
    this.ownedMats.length = 0;
    this.flashMats.length = 0;
    this.flashBase.clear();
    this.bodyHitbox.geometry.dispose();
    this.headHitbox.geometry.dispose();
    this.healthBar?.release();
    this.healthBar = null;
  }
}

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