import * as THREE from "three";
import { PoisonConfig as cfg } from "./PoisonConfig";
import { PoisonViewmodel } from "./PoisonViewmodel";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { castBeam, BeamCastResult } from "../BeamCombat";
import { ParticleSystem } from "../../effects/ParticleSystem";

/** Per-frame input snapshot handed by the Game (weapon owns no input code). */
export interface PoisonFrameInput {
  /** LMB held → continuous poison spray. */
  fireHeld: boolean;
  /** R pressed this frame (edge) → manual refill. */
  reloadPressed: boolean;
  /** False while dead / melee busy / mole strike → inputs ignored. */
  canAct: boolean;
  /** Raycast candidates: statics + player proxy + bot models. */
  hittables: THREE.Object3D[];
  /** Player WORLD velocity (physics controller) — liquid inertia source. */
  velocity: THREE.Vector3;
  time: number;
}

/**
 * LANCE-POISON — short-range continuous toxic sprayer (flamethrower-style).
 *
 * Gameplay: hold LMB → a green poison stream drains the tank charge and
 * deals high DPS inside a SHORT range. R (or empty tank) → refill; the
 * charge rises PROGRESSIVELY during the reload, so the visible liquid
 * level in the voxel tank follows the refill in real time.
 *
 * The CHARGE is the single source of truth: gameplay drain, the HUD bar
 * and the liquid `Drain` morph target all read `charge / capacity`.
 *
 * Accuracy model (same as the plasma rifle): camera-center raycast —
 * what the crosshair touches (within range) is what melts.
 */
export class PoisonWeapon {
  /** Hit-confirmation sink (hitmarkers / sounds / medals — local player). */
  feedback: HitFeedbackManager | null = null;
  /** The combatant wielding this sprayer (never damaged by its own spray). */
  owner: Combatant | null = null;
  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Audio hooks (pure observers, wired by the Game). */
  onSprayStart: (() => void) | null = null;
  onSprayStop: (() => void) | null = null;
  onReloadStart: (() => void) | null = null;
  onReloadEnd: (() => void) | null = null;

  /** True while poison is actually being emitted (net edge detection). */
  isSpraying = false;
  /** True while the spray is damaging a combatant (crosshair feedback). */
  hittingTarget = false;

  /** Resolves once the viewmodel GLB is loaded (Game GPU warm-up). */
  readonly ready: Promise<void>;

  private charge: number = cfg.capacity;
  private reloadTimer = 0; // > 0 while refilling (weapon locked)

  private readonly camera: THREE.Camera;
  private readonly viewmodel: PoisonViewmodel;
  private readonly particles: ParticleSystem;

  private readonly raycaster = new THREE.Raycaster();
  private readonly castResult = new BeamCastResult();
  private static readonly SCREEN_CENTER = new THREE.Vector2(0, 0);

  // Scratch (no per-frame allocations)
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly sprayDir = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly poisonColor = new THREE.Color(cfg.poisonColor);
  private readonly poisonBright = new THREE.Color(0xa8ff70);
  private sprayEmitAccum = 0;
  private impactEmitAccum = 0;

  constructor(camera: THREE.Camera, particles: ParticleSystem) {
    this.camera = camera;
    this.particles = particles;
    this.viewmodel = new PoisonViewmodel(camera);
    this.ready = this.viewmodel.ready;
  }

  // ---- HUD state ----
  get currentCharge(): number {
    return this.charge;
  }
  get maxCharge(): number {
    return cfg.capacity;
  }
  get isReloading(): boolean {
    return this.reloadTimer > 0;
  }

  /** 0..1 fill fraction — the ONE value HUD + liquid + gameplay share. */
  get fillFraction(): number {
    return cfg.capacity > 0 && Number.isFinite(this.charge)
      ? THREE.MathUtils.clamp(this.charge / cfg.capacity, 0, 1)
      : 0;
  }

  setViewmodelHidden(hidden: boolean): void {
    const wasHidden = !this.viewmodel.group.visible;
    this.viewmodel.setHidden(hidden);
    // Re-equip after being away: forget stale motion state so the liquid
    // never receives an artificial acceleration impulse.
    if (wasHidden && !hidden) this.viewmodel.resetMotion();
  }

  /**
   * Clean slate (death / loadout swap): full tank, reload cancelled,
   * liquid motion memory cleared.
   */
  reset(): void {
    this.charge = cfg.capacity;
    this.reloadTimer = 0;
    this.isSpraying = false;
    this.hittingTarget = false;
    this.viewmodel.resetMotion();
  }

  update(dt: number, input: PoisonFrameInput): void {
    // ---- Refill: the charge rises PROGRESSIVELY (the liquid follows). ----
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      const refillRate = cfg.capacity / cfg.reloadDuration;
      this.charge = Math.min(cfg.capacity, this.charge + refillRate * dt);
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.charge = cfg.capacity; // land exactly on full
        this.onReloadEnd?.();
      }
      this.stopSpray();
      this.viewmodel.update(dt, false, input.velocity, this.fillFraction, input.time);
      return;
    }

    const wantSpray =
      input.canAct && input.fireHeld && this.charge > 0;

    // R — manual refill (only when it actually gains charge).
    if (input.canAct && input.reloadPressed && this.charge < cfg.capacity) {
      this.startReload();
      this.viewmodel.update(dt, false, input.velocity, this.fillFraction, input.time);
      return;
    }

    this.hittingTarget = false;
    if (wantSpray) {
      if (!this.isSpraying) {
        this.isSpraying = true;
        this.onSprayStart?.();
      }
      this.charge = Math.max(0, this.charge - cfg.drainPerSecond * dt);
      this.sprayTick(dt, input.hittables);
      this.onCameraShake?.(cfg.sprayCameraShakePerSecond * dt);
      if (this.charge <= 0) {
        this.stopSpray();
        this.startReload(); // empty → automatic refill
      }
    } else {
      this.stopSpray();
    }

    this.viewmodel.update(dt, this.isSpraying, input.velocity, this.fillFraction, input.time);
  }

  private stopSpray(): void {
    if (!this.isSpraying) return;
    this.isSpraying = false;
    this.hittingTarget = false;
    this.onSprayStop?.();
  }

  private startReload(): void {
    this.reloadTimer = cfg.reloadDuration;
    this.onReloadStart?.();
  }

  // ------------------------------------------------------------------
  // One spray tick: short-range camera-center raycast + continuous damage
  // ------------------------------------------------------------------

  private sprayTick(dt: number, hittables: THREE.Object3D[]): void {
    // Perfectly accurate SHORT ray from the crosshair center — the same
    // shared castBeam as the plasma rifle, but capped at the poison range.
    this.raycaster.setFromCamera(PoisonWeapon.SCREEN_CENTER, this.camera);
    castBeam(
      this.raycaster,
      this.raycaster.ray.origin,
      this.raycaster.ray.direction,
      cfg.range,
      hittables,
      this.owner,
      this.castResult,
    );

    if (this.castResult.combatant) {
      const combatant = this.castResult.combatant;
      // Poison is a gas/liquid cone: no headshot bonus, flat DPS.
      const damage = cfg.damagePerSecond * dt;
      const applied = combatant.health.applyDamage(
        damage,
        this.owner,
        KillMethod.POISON,
        HitZone.BODY,
      );
      if (applied) {
        this.feedback?.registerHit({
          attacker: this.owner,
          target: combatant,
          hitZone: HitZone.BODY,
          damage,
          position: this.castResult.point,
          weapon: KillMethod.POISON,
          isKill: !combatant.health.alive,
        });
      }
      this.hittingTarget = true;
    } else if (this.castResult.trainingTarget) {
      this.castResult.trainingTarget.applyDamage(cfg.damagePerSecond * dt);
      this.hittingTarget = true;
    }

    this.emitSprayParticles(dt);
  }

  /** Green droplet cone from the muzzle + splash at the hit point. */
  private emitSprayParticles(dt: number): void {
    this.viewmodel.getMuzzleWorldPosition(this.muzzleWorld);
    this.sprayDir.subVectors(this.castResult.point, this.muzzleWorld);
    if (this.sprayDir.lengthSq() < 1e-6) this.camera.getWorldDirection(this.sprayDir);
    this.sprayDir.normalize();

    // Cone droplets: speed + slight gravity → a heavy toxic stream.
    this.sprayEmitAccum += cfg.sprayParticleRate * dt;
    while (this.sprayEmitAccum >= 1) {
      this.sprayEmitAccum -= 1;
      this.tmpVel
        .set(
          (Math.random() - 0.5) * 2 * cfg.sprayConeAngle,
          (Math.random() - 0.5) * 2 * cfg.sprayConeAngle,
          (Math.random() - 0.5) * 2 * cfg.sprayConeAngle,
        )
        .add(this.sprayDir)
        .normalize()
        .multiplyScalar(cfg.sprayParticleSpeed * (0.75 + Math.random() * 0.5));
      const bright = Math.random() < 0.3;
      this.particles.spawn(
        this.muzzleWorld,
        this.tmpVel,
        cfg.sprayParticleLife * (0.7 + Math.random() * 0.6),
        bright ? this.poisonBright : this.poisonColor,
        4, // droplets sag — reads as liquid, not laser
        1.5,
      );
    }

    // Splash on the struck surface (only when something is in range).
    if (this.castResult.hit) {
      this.impactEmitAccum += cfg.impactParticleRate * dt;
      while (this.impactEmitAccum >= 1) {
        this.impactEmitAccum -= 1;
        this.tmpPos.copy(this.castResult.point);
        this.tmpVel
          .copy(this.castResult.normal)
          .multiplyScalar(1.5 + Math.random() * 1.5)
          .addScaledVector(this.sprayDir, -0.5);
        this.tmpVel.x += (Math.random() - 0.5) * 1.2;
        this.tmpVel.z += (Math.random() - 0.5) * 1.2;
        this.particles.spawn(this.tmpPos, this.tmpVel, 0.35, this.poisonBright, 3, 1);
      }
    }
  }
}
