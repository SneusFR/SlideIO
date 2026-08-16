import * as THREE from "three";
import { RevolverConfig as cfg } from "./RevolverConfig";
import { RevolverViewmodel } from "./RevolverViewModel";
import { RevolverProjectileSystem } from "./RevolverProjectile";
import { RevolverExplosion } from "./RevolverExplosion";
import { loadRevolverTemplate } from "./RevolverModel";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { castBeam, BeamCastResult } from "../BeamCombat";
import { ParticleSystem } from "../../effects/ParticleSystem";
import { Shockwave } from "../../effects/Shockwave";

/** Per-frame input snapshot handed by the Game (weapon owns no input code). */
export interface RevolverFrameInput {
  /** LMB pressed this frame (edge) → one bullet. */
  firePressed: boolean;
  /** RMB pressed this frame (edge) → committed fan fire. */
  fanFirePressed: boolean;
  /** R pressed this frame (edge) → voluntary throw. */
  throwPressed: boolean;
  /** False while dead / melee busy / mole strike → inputs ignored. */
  canAct: boolean;
  /** Raycast candidates: statics + player proxy + bot models. */
  hittables: THREE.Object3D[];
  time: number;
}

/**
 * REVOLVER — arcade ballistic hand cannon.
 *
 * Accuracy model: 100% PERFECT. Every bullet raycasts from the camera
 * center through the crosshair (identical to the shared castBeam pipeline).
 * Movement, jumps, slides, dashes and the fan fire add ZERO dispersion —
 * visual recoil lives only on the viewmodel and camera shake.
 *
 * Loop: shoot → empty (or R) → THROW (physical projectile, AoE explosion)
 * → fresh revolver materializes holographically → 6/6.
 */
export class RevolverWeapon {
  /** Hit-confirmation sink (hitmarkers / sounds / medals — local player). */
  feedback: HitFeedbackManager | null = null;

  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Audio hooks (pure observers, wired by the Game). */
  onShot: ((fanFire: boolean) => void) | null = null;
  onThrow: (() => void) | null = null;
  onMaterializeStart: (() => void) | null = null;

  private ownerRef: Combatant | null = null;

  private ammo = cfg.revolverCapacity;
  private fireCooldown = 0;
  /** Committed RMB sequence: fires every remaining bullet automatically. */
  private fanFireActive = false;
  /** > 0 while the new revolver is materializing (weapon LOCKED). */
  private materializeTimer = 0;

  private readonly camera: THREE.Camera;
  private readonly particles: ParticleSystem;
  private readonly viewmodel: RevolverViewmodel;
  private readonly explosion: RevolverExplosion;
  private readonly projectiles: RevolverProjectileSystem;
  /** Shared cached model template (for thrown clones). */
  private template: THREE.Group | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly beamResult = new BeamCastResult();
  private static readonly SCREEN_CENTER = new THREE.Vector2(0, 0);

  // Scratch (no per-frame allocations)
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly tracerDir = new THREE.Vector3();
  private readonly tracerPos = new THREE.Vector3();
  private readonly tracerVel = new THREE.Vector3();
  private readonly throwOrigin = new THREE.Vector3();
  private readonly throwDir = new THREE.Vector3();
  private readonly tracerColor = new THREE.Color(0xffd9a0); // warm bullet tracer
  private readonly wallSparkColor = new THREE.Color(0xffc98a);
  private readonly wallSparkViolet = new THREE.Color(0xc084fc);

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    combatants: Combatant[],
    particles: ParticleSystem,
    shockwave: Shockwave,
  ) {
    this.camera = camera;
    this.particles = particles;
    this.explosion = new RevolverExplosion(scene, combatants, particles, shockwave);
    this.projectiles = new RevolverProjectileSystem(scene, this.explosion);
    this.viewmodel = new RevolverViewmodel(camera, particles);
    void loadRevolverTemplate().then((t) => (this.template = t));
  }

  /** The combatant wielding this revolver (owner-immune everywhere). */
  set owner(value: Combatant | null) {
    this.ownerRef = value;
    this.explosion.owner = value;
    this.projectiles.owner = value;
  }
  get owner(): Combatant | null {
    return this.ownerRef;
  }

  /** Feedback must also reach the explosion (kills / hitmarkers). */
  setFeedback(feedback: HitFeedbackManager): void {
    this.feedback = feedback;
    this.explosion.feedback = feedback;
  }

  /** Audio hook for the AoE explosion. */
  set onExplosion(cb: ((pos: THREE.Vector3) => void) | null) {
    this.explosion.onExplode = cb;
  }

  // ---- HUD state ----
  get currentAmmo(): number {
    return this.ammo;
  }
  get maxAmmo(): number {
    return cfg.revolverCapacity;
  }
  get isMaterializing(): boolean {
    return this.materializeTimer > 0;
  }
  get isFanFiring(): boolean {
    return this.fanFireActive;
  }

  setViewmodelHidden(hidden: boolean): void {
    this.viewmodel.setHidden(hidden);
  }

  /**
   * Clean slate (death / loadout swap): fan fire dropped, materialization
   * completed instantly, full cylinder. In-flight thrown revolvers are
   * removed silently (no ghost explosions after death).
   */
  reset(): void {
    this.fanFireActive = false;
    this.materializeTimer = 0;
    this.fireCooldown = 0;
    this.ammo = cfg.revolverCapacity;
    this.viewmodel.forceReady();
    this.projectiles.clear();
  }

  update(dt: number, input: RevolverFrameInput): void {
    // World-side systems always tick (projectiles fly even while the
    // player is dead or a melee weapon is out).
    this.projectiles.update(dt, input.hittables);
    this.explosion.update(dt);
    this.viewmodel.update(dt, input.time);
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // Materialization lock: no fire, no fan fire, no throw.
    if (this.materializeTimer > 0) {
      this.fanFireActive = false;
      this.materializeTimer -= dt;
      if (this.materializeTimer <= 0) {
        this.materializeTimer = 0;
        this.ammo = cfg.revolverCapacity; // fresh full cylinder → READY
      }
      return;
    }

    if (!input.canAct) {
      this.fanFireActive = false; // blocked mid-sequence → cleanly dropped
      return;
    }

    // R — voluntary throw, any time, any ammo. Cancels an active fan fire
    // immediately: zero ghost shots after the revolver left the hand.
    if (input.throwPressed) {
      this.fanFireActive = false;
      this.throwCurrent();
      return;
    }

    // RMB — commit the fan fire (fires everything, no need to hold).
    if (input.fanFirePressed && this.ammo > 0) this.fanFireActive = true;

    if (this.fanFireActive) {
      // Each bullet is a REAL individual shot: its own raycast at the
      // crosshair position of THIS instant, own ammo, own feedback.
      if (this.fireCooldown <= 0 && this.ammo > 0) {
        this.fireOne(true, input.hittables);
        this.fireCooldown = cfg.revolverFanFireInterval;
        if (this.ammo <= 0) {
          this.fanFireActive = false;
          this.throwCurrent(); // last bullet → automatic throw
        }
      }
      return;
    }

    // LMB — single shot (edge-triggered, capped by the primary cadence).
    if (input.firePressed && this.fireCooldown <= 0 && this.ammo > 0) {
      this.fireOne(false, input.hittables);
      this.fireCooldown = cfg.revolverPrimaryFireInterval;
      if (this.ammo <= 0) this.throwCurrent(); // empty after LMB → throw
    }
  }

  // ------------------------------------------------------------------
  // One bullet: perfect camera-center hitscan
  // ------------------------------------------------------------------

  private fireOne(fanFire: boolean, hittables: THREE.Object3D[]): void {
    this.ammo--;

    // PERFECT accuracy: ray from the camera through the crosshair center.
    // No bloom, no spread, no movement penalty — ever.
    this.raycaster.setFromCamera(RevolverWeapon.SCREEN_CENTER, this.camera);
    castBeam(
      this.raycaster,
      this.raycaster.ray.origin,
      this.raycaster.ray.direction,
      cfg.revolverRange,
      hittables,
      this.ownerRef,
      this.beamResult,
    );

    // Visual-only feedback (never displaces the aim).
    this.viewmodel.triggerShot(fanFire);
    this.onCameraShake?.(cfg.revolverShotCameraShake);
    this.onShot?.(fanFire);
    this.spawnTracer();

    if (this.beamResult.combatant) {
      const target = this.beamResult.combatant;
      const zone = this.beamResult.hitZone;
      // Explicit per-zone damage — the global x2 headshot multiplier is
      // intentionally NOT applied (BODY one-shots, HEAD needs two).
      const damage =
        zone === HitZone.HEAD ? cfg.revolverHeadDamage : cfg.revolverBodyDamage;
      const applied = target.health.applyDamage(
        damage,
        this.ownerRef,
        KillMethod.REVOLVER,
        zone,
      );
      if (applied) {
        // A head hit is still a HEADSHOT for the whole feedback chain
        // (marker, sound, VFX, medal on the fatal hit) — hit TYPE and
        // damage multiplier are two different things.
        this.feedback?.registerHit({
          attacker: this.ownerRef,
          target,
          hitZone: zone,
          damage,
          position: this.beamResult.point,
          weapon: KillMethod.REVOLVER,
          isKill: !target.health.alive,
        });
      }
    } else if (this.beamResult.trainingTarget) {
      this.beamResult.trainingTarget.applyDamage(cfg.revolverBodyDamage);
    } else if (this.beamResult.hit) {
      // Structure hit: sparks only, zero damage, nothing persistent.
      this.particles.burst(this.beamResult.point, 8, 3, 0.25, this.wallSparkColor, 2);
      this.particles.burst(this.beamResult.point, 4, 2, 0.2, this.wallSparkViolet, 0);
    }
  }

  /** Extremely short bullet tracer (a tracer, NOT a laser beam). */
  private spawnTracer(): void {
    this.viewmodel.getMuzzleWorldPosition(this.muzzleWorld);
    this.tracerDir.subVectors(this.beamResult.point, this.muzzleWorld);
    const len = this.tracerDir.length();
    if (len < 0.5) return;
    this.tracerDir.multiplyScalar(1 / len);
    const steps = Math.min(6, Math.max(2, Math.floor(len / 6)));
    for (let i = 0; i < steps; i++) {
      const along = (len * (i + 0.5)) / steps;
      this.tracerPos.copy(this.muzzleWorld).addScaledVector(this.tracerDir, along);
      this.tracerVel.copy(this.tracerDir).multiplyScalar(60);
      this.particles.spawn(this.tracerPos, this.tracerVel, 0.05, this.tracerColor, 0, 0);
    }
  }

  // ------------------------------------------------------------------
  // Throw + rematerialize
  // ------------------------------------------------------------------

  private throwCurrent(): void {
    // Camera-forward launch, exactly where the player is looking — even
    // mid-air, mid-slide or mid-dash. Bullet count never changes the AoE.
    this.camera.getWorldPosition(this.throwOrigin);
    this.camera.getWorldDirection(this.throwDir);
    this.throwOrigin.addScaledVector(this.throwDir, 0.35); // clear the face
    this.projectiles.spawn(this.throwOrigin, this.throwDir, this.template);

    this.onThrow?.();
    this.onCameraShake?.(cfg.revolverShotCameraShake * 0.6);

    // The hand is empty → a fresh revolver prints itself in immediately.
    // This animation is the ONLY unavailability (no artificial cooldown).
    this.materializeTimer = cfg.revolverMaterializeDuration;
    this.viewmodel.startMaterialize(cfg.revolverMaterializeDuration);
    this.onMaterializeStart?.();
  }
}