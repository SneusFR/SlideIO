import * as THREE from "three";
import { HexSniperConfig as cfg } from "./HexSniperConfig";
import { loadHexSniperGltf } from "./HexSniperModel";
import { HexSniperController } from "./HexSniperController";
import { HexSniperAttacks } from "./HexSniperAttacks";
import type { HexSniperEvent } from "./HexSniperAttacks";
import { HexSniperWorldAdapter } from "./HexSniperWorldAdapter";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { TrainingTarget } from "../../targets/TrainingTarget";

/** Per-frame input snapshot handed by the Game (weapon owns no input code). */
export interface HexSniperFrameInput {
  /** LMB edge → fire the tongue (refused while a tongue/arrival-bite runs). */
  firePressed: boolean;
  /** RMB held → classic sniper ADS (×4 zoom — the Game drives the camera). */
  zoomHeld: boolean;
  /** False while dead / melee busy / mole strike → inputs ignored. */
  canAct: boolean;
}

/** The local player's Combatant id (PlayerCombatant.id) — the tongue owner. */
const OWNER_ID = -1;

/**
 * HEX SNIPER — the monster-head sniper (kit HexSniper).
 *
 * LMB: the creature projects its TONGUE along the aim direction captured at
 * the click — near-instant, like a real sniper shot. No max range, no
 * expiry — each physics step sweeps the traveled segment with the tongue
 * radius (kit state machine): the FIRST collision (wall / object / player)
 * or the real map bounds stop the flight. A GRABBED player takes flat hit
 * damage and is physically REELED IN through his own character controller —
 * never a teleport through walls; any other contact = empty return.
 *
 * BITE: only when a player was actually REELED IN — the instant the victim
 * arrives the creature snaps its jaws (clip `Bite`): flat damage, at most
 * ONCE per target per bite (the kit's two contact windows are dedup'd
 * here) — never per-frame damage. A MISSED tongue (wall / prop / map
 * bounds / blocked pull) never bites: the shot re-arms the moment the
 * tongue is back (near-zero recoverDuration).
 *
 * RMB (held): classic sniper aim-down-sights — ×4 optical zoom with the
 * existing crosshair (the Game drives FPSCamera.zoom). No bite on RMB.
 *
 * Simulation advances in fixedUpdate() (game physics step, BEFORE
 * physics.step so the pull's kinematic translation integrates); visuals
 * advance once per render frame in update(). One attack at a time
 * (tryTongue/tryBite return false while busy). onFire() is never used.
 */
export class HexSniperWeapon {
  /** The combatant wielding this weapon (never grabbed / bitten by itself). */
  owner: Combatant | null = null;
  /** Hit-confirmation feedback sink (local player's weapon only). */
  feedback: HitFeedbackManager | null = null;
  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;
  // ---- Audio hooks (pure observers, wired by the Game) ----
  onTongueStart: (() => void) | null = null;
  onTongueGrab: (() => void) | null = null;
  onPlayerArrived: (() => void) | null = null;
  onBiteStart: (() => void) | null = null;

  /** Resolves once the GLB is parsed and attached (Game GPU warm-up). */
  readonly ready: Promise<void>;
  /** The five physics callbacks on the REAL Rapier world. */
  readonly adapter: HexSniperWorldAdapter;

  /** Camera-attached weapon container (kit model faces -X → yaw to -Z). */
  private readonly group = new THREE.Group();
  private visuals: HexSniperController | null = null;
  private attacks: HexSniperAttacks | null = null;
  /** Armed on `player-arrived` (a player was reeled in): the next `ready`
   *  triggers the INSTANT arrival bite. Never set on a missed tongue. */
  private bitePending = false;
  /** Targets already damaged by the CURRENT bite (dedup across windows). */
  private readonly biteDamaged = new Set<number | string>();

  // Scratch (no per-frame allocations)
  private readonly impulse = new THREE.Vector3();
  private readonly hitPos = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.Camera,
    /** WORLD scene — the stretched tongue tether lives here, not on the camera. */
    effectsParent: THREE.Scene,
    adapter: HexSniperWorldAdapter,
  ) {
    this.adapter = adapter;
    this.group.position.set(
      cfg.viewmodelOffset.x,
      cfg.viewmodelOffset.y,
      cfg.viewmodelOffset.z,
    );
    // Kit model looks toward -X with +Y up; the FPS camera looks toward -Z.
    this.group.rotation.y = -Math.PI / 2;
    this.group.scale.setScalar(cfg.viewmodelScale);
    this.group.visible = false;
    camera.add(this.group);

    // DEPTH-CLEAR PROXY (Bass Blaster pattern) — the HexSniper is many
    // interpenetrating meshes (monster head + mouth interior + scope +
    // receiver panels). The classic viewmodel recipe (depthTest OFF) breaks
    // such a model: with no depth testing the draw ORDER decides visibility,
    // so the mouth interior paints OVER the closed head and body panels
    // vanish behind each other. Instead we keep REAL depth testing between
    // the weapon's own parts and clear the depth buffer right before the
    // weapon draws (renderOrder 99 < 100): the weapon then wins against all
    // previously-drawn world depth — same "never clip into walls" guarantee,
    // correct self-occlusion.
    const depthClear = new THREE.Mesh(
      new THREE.PlaneGeometry(0.001, 0.001),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    depthClear.material.transparent = true; // same render pass as the weapon
    depthClear.renderOrder = 99;
    depthClear.frustumCulled = false;
    depthClear.onBeforeRender = (renderer) => renderer.clearDepth();
    this.group.add(depthClear); // follows group.visible (weapon swaps)

    this.ready = this.load(effectsParent);
  }

  private async load(effectsParent: THREE.Scene): Promise<void> {
    try {
      // GLB loaded ONCE and cached (HexSniperModel); the controller clones
      // the skeleton and SHARES geometries/materials with the cache.
      const gltf = await loadHexSniperGltf();
      this.visuals = new HexSniperController(gltf, {
        effectsParent,
        tongueWidthScale: cfg.tongueWidthScale,
      });
      this.prepareViewmodelMaterials(this.visuals.object);
      this.group.add(this.visuals.object);
      this.group.updateWorldMatrix(true, true);
      this.attacks = new HexSniperAttacks({
        world: this.adapter,
        pose: {
          // WORLD-space: the FPS camera sits at the player's eye in the real
          // simulation, so socket world positions ARE simulation positions.
          origin: (out) => {
            this.getMouthWorld(out);
          },
          direction: (out) => {
            this.camera.getWorldDirection(out);
          },
          // The reel-in destination FOLLOWS the shooter (capsule center).
          pullDestination: (out) => {
            if (this.owner) this.owner.getPosition(out);
            else this.getMouthWorld(out);
          },
        },
        visuals: this.visuals,
        ownerId: OWNER_ID,
        onEvent: (event) => this.handleEvent(event),
        projectileSpeed: cfg.projectileSpeed,
        returnSpeed: cfg.returnSpeed,
        pullSpeed: cfg.pullSpeed,
        tongueRadius: cfg.tongueRadius,
        pullStopDistance: cfg.pullStopDistance,
        biteRange: cfg.biteRange,
        biteRadius: cfg.biteRadius,
        // Near-zero: a missed tongue re-arms instantly and the arrival
        // bite fires without the kit's default 10/30 s recovery lag.
        recoverDuration: cfg.recoverDuration,
      });
    } catch (err) {
      console.error("HexSniper: failed to load the weapon GLB", err);
    }
  }

  /**
   * Viewmodel materials: REAL depth testing between the weapon's own parts
   * (the depth-clear proxy in the constructor already guarantees "never clip
   * into walls" — see Bass Blaster), drawn in the transparent pass AFTER
   * world transparents. The TETHER is excluded: it lives in the WORLD scene
   * and must depth-test against the world — and since the controller SHARES
   * the GLB's 5 materials between meshes (tether included), the viewmodel
   * meshes get CLONES before mutation (each unique material cloned once,
   * then reused between meshes).
   */
  private prepareViewmodelMaterials(root: THREE.Object3D): void {
    const cloned = new Map<THREE.Material, THREE.Material>();
    const viewmodelClone = (mat: THREE.Material): THREE.Material => {
      let copy = cloned.get(mat);
      if (!copy) {
        copy = mat.clone();
        copy.depthTest = true; // real self-occlusion between weapon parts
        copy.depthWrite = true;
        copy.transparent = true; // draw AFTER world transparents
        cloned.set(mat, copy);
      }
      return copy;
    };
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.renderOrder = 100;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(viewmodelClone)
        : viewmodelClone(mesh.material);
    });
  }

  /** Gameplay events from the kit state machine → existing damage rules. */
  private handleEvent(event: HexSniperEvent): void {
    switch (event.type) {
      case "tongue-start":
        this.onTongueStart?.();
        break;
      case "tongue-player":
        // Sniper hit: flat damage the instant the tongue tags the player,
        // then the reel-in starts (kit state machine).
        if (event.playerId != null) this.applyTongueDamage(event.playerId, event.point ?? null);
        this.onTongueGrab?.();
        this.onCameraShake?.(cfg.grabShake);
        break;
      case "tongue-world":
        // Sniper hit on a training target: flat damage, no pull.
        this.applyTongueWorldDamage();
        break;
      case "player-arrived":
        // A player was actually reeled in → ARM the instant arrival bite.
        // The kit retracts the last ~1.6 m and recovers in cfg.recoverDuration
        // (near-zero), so the `ready` below fires the bite the same instant.
        this.bitePending = true;
        this.onPlayerArrived?.();
        this.onCameraShake?.(cfg.arriveShake);
        break;
      case "ready":
        // Tongue fully recovered (or bite ended). Arrival bite only: a
        // MISSED tongue never set bitePending, so the weapon is instantly
        // ready to fire again (isBusy false right here).
        if (this.bitePending) {
          this.bitePending = false;
          this.biteDamaged.clear();
          this.attacks?.tryBite();
        }
        break;
      case "bite-start":
        this.onBiteStart?.();
        this.onCameraShake?.(cfg.biteShake);
        break;
      case "bite-hit":
        // Kit guarantee: at most ONE event per target per contact window.
        // Extra weapon-level dedup: ONE damage application per target per
        // BITE (the two windows never double-hit the same victim).
        if (event.hit) this.applyBiteDamage(event.hit);
        break;
      case "cancel":
        // Death / unequip / knockdown: the pending arrival bite dies too.
        this.bitePending = false;
        this.biteDamaged.clear();
        break;
    }
  }

  /** Flat tongue damage on the grabbed player (existing Health rules). */
  private applyTongueDamage(playerId: number | string, point: THREE.Vector3 | null): void {
    const victim = this.adapter.getCombatant(playerId);
    if (!victim || !victim.health.alive) return;
    if (point) this.hitPos.copy(point);
    else victim.getPosition(this.hitPos);
    const applied = victim.health.applyDamage(
      cfg.tongueDamage,
      this.owner,
      KillMethod.HEX_SNIPER_TONGUE,
      HitZone.BODY,
    );
    if (applied) {
      this.feedback?.registerHit({
        attacker: this.owner,
        target: victim,
        hitZone: HitZone.BODY,
        damage: cfg.tongueDamage,
        position: this.hitPos,
        weapon: KillMethod.HEX_SNIPER_TONGUE,
        isKill: !victim.health.alive,
      });
    }
  }

  /** Tongue struck a non-player: training targets still take the hit. */
  private applyTongueWorldDamage(): void {
    const hit = this.adapter.lastSweepHit;
    const target = hit?.trainingTarget as TrainingTarget | undefined;
    if (hit?.kind === "target" && target && !target.dead) {
      target.applyDamage(cfg.tongueDamage);
    }
  }

  private applyBiteDamage(hit: {
    id?: number | string;
    kind?: string;
    combatant?: unknown;
    trainingTarget?: unknown;
  }): void {
    // ONE damage application per target per BITE: the kit's two contact
    // windows can both report the same victim — only the first one lands.
    if (hit.id != null) {
      if (this.biteDamaged.has(hit.id)) return;
      this.biteDamaged.add(hit.id);
    }
    if (hit.kind === "player" && hit.combatant) {
      const victim = hit.combatant as Combatant;
      if (!victim.health.alive) return;
      // Knockback + impact BEFORE the damage (ragdoll contract).
      victim.getPosition(this.hitPos);
      this.camera.getWorldDirection(this.impulse);
      this.impulse.y = 0;
      this.impulse.normalize().multiplyScalar(cfg.biteKnockback);
      this.impulse.y = cfg.biteVerticalKnockback;
      victim.registerImpact?.(this.impulse, this.hitPos);
      victim.applyImpulse(this.impulse);
      const applied = victim.health.applyDamage(
        cfg.biteDamage,
        this.owner,
        KillMethod.HEX_SNIPER_BITE,
        HitZone.BODY,
      );
      if (applied) {
        this.feedback?.registerHit({
          attacker: this.owner,
          target: victim,
          hitZone: HitZone.BODY,
          damage: cfg.biteDamage,
          position: this.hitPos,
          weapon: KillMethod.HEX_SNIPER_BITE,
          isKill: !victim.health.alive,
        });
      }
    } else if (hit.kind === "target" && hit.trainingTarget) {
      (hit.trainingTarget as TrainingTarget).applyDamage(cfg.biteTargetDamage);
    }
  }

  /** Mouth (TongueOrigin socket) world position — the tongue's true origin. */
  private getMouthWorld(out: THREE.Vector3): THREE.Vector3 {
    const socket = this.visuals?.tongueOrigin ?? this.visuals?.muzzle;
    if (socket) return socket.getWorldPosition(out);
    return this.camera.getWorldPosition(out);
  }

  /** True while an attack runs (tongue flight/pull, or the arrival bite). */
  get isBusy(): boolean {
    return this.bitePending || (this.attacks !== null && this.attacks.state !== "Idle");
  }

  setViewmodelHidden(hidden: boolean): void {
    this.group.visible = !hidden;
  }

  /**
   * SIMULATION step — call once per game physics step, BEFORE physics.step
   * (the pull writes setNextKinematicTranslation on the victim's body).
   * Keeps running while off-screen: an active attack is never dropped
   * just because the viewmodel is hidden.
   */
  fixedUpdate(dt: number): void {
    if (!this.attacks) return;
    this.adapter.setStepDt(dt);
    this.attacks.update(dt);
  }

  /** VISUAL step + edge-triggered inputs — call once per render frame. */
  update(dt: number, input: HexSniperFrameInput): void {
    if (this.attacks && input.canAct && input.firePressed) {
      // One attack at a time: tryTongue refuses while the tongue or an
      // arrival bite is still running. bitePending is NOT set here — it
      // only arms on `player-arrived` (bite exclusively after a reel-in).
      if (!this.bitePending) this.attacks.tryTongue();
    }
    this.visuals?.update(dt);
  }

  /** Death / unequip / knockdown: release the grab, clean return to Idle. */
  reset(): void {
    this.bitePending = false;
    this.biteDamaged.clear();
    this.attacks?.cancel("unequipped");
  }

  /** Free per-instance resources (mixer, skeleton clone, tether buffer). */
  dispose(): void {
    this.attacks?.dispose();
    this.visuals?.dispose();
    this.group.removeFromParent();
  }
}
