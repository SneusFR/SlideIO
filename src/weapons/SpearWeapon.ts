import * as THREE from "three";
import { SpearConfig as sc } from "./SpearConfig";
import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Shockwave } from "../effects/Shockwave";
import { SpearViewmodel } from "./SpearViewmodel";
import { SpearRushEndReason } from "../player/PlayerMovement";

/**
 * Melee attack state. Once an attack starts its type is LOCKED until the
 * whole sequence finishes — no cancel, no spam.
 * SWEEP  = quick press → big horizontal sweep to the LEFT.
 * RUSH   = held press  → CHARGED SPEAR RUSH (movement drives the charge;
 *          this controller owns the TIP hit detection + damage).
 */
export enum SpearState {
  IDLE = "IDLE",
  SWEEP = "SWEEP",
  RUSH = "RUSH",
}

/**
 * Astral Lance melee controller (reusable logic, not tied to the camera).
 * - Quick press → horizontal sweep: arc zone, hit window synced with the
 *   viewmodel, one hit per target per sweep, configurable damage fraction.
 * - Held press → charged rush: the movement system drives the 2× run-speed
 *   charge; every frame this controller sweeps a segment between the
 *   PREVIOUS and CURRENT tip positions (no tunneling at high speed) and
 *   resolves the FIRST combatant touched: 50% max-HP damage, heavy
 *   knockback along the charge, then the rush stops (one target per charge).
 * Damage goes through the SAME generic Health system as every other weapon.
 */
export class SpearWeapon {
  state = SpearState.IDLE;

  /** The combatant wielding the lance (never damaged by its own hits). */
  owner: Combatant | null = null;

  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;

  // ---- Audio/gameplay hooks (observation only) ----
  /** A sweep was launched (hit or miss — the polearm whoosh). */
  onSweepStart: (() => void) | null = null;
  /** The sweep connected with a combatant. */
  onHitConnect: ((pos: THREE.Vector3) => void) | null = null;
  /** The charged rush launched (threshold reached). */
  onRushStart: (() => void) | null = null;
  /** The rush TIP connected with a combatant → Game must stop the charge. */
  onRushImpact: ((pos: THREE.Vector3) => void) | null = null;

  private sweepTimer = 0;
  /** Cooldown left before a NEW charged rush can start (sweep unaffected). */
  private rushCooldownTimer = 0;
  /** Each combatant can only take ONE hit per sweep / per charge. */
  private readonly hitTargets = new Set<Combatant>();
  /** One combatant max per charge — set as soon as the tip connects. */
  private rushHitLanded = false;

  // Tip sweep bookkeeping (previous → current tip segment, CCD-style)
  private readonly prevTip = new THREE.Vector3();
  private readonly curTip = new THREE.Vector3();
  private tipInitialized = false;
  private trailAccumulator = 0;

  // Scratch (no per-frame allocations)
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpKb = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly seg = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly closest = new THREE.Vector3();
  private readonly energyColor = new THREE.Color(0xa855f7);
  private readonly flashColor = new THREE.Color(0xe9d5ff);

  constructor(
    private readonly combatants: Combatant[],
    private readonly particles: ParticleSystem,
    private readonly shockwave: Shockwave,
    private readonly viewmodel: SpearViewmodel | null = null,
  ) {}

  /** True while any lance sequence is running (input must be ignored). */
  get isBusy(): boolean {
    return this.state !== SpearState.IDLE;
  }

  /** The Plasma Rifle cannot fire while the lance is out. */
  get blocksFiring(): boolean {
    return this.isBusy;
  }

  get isRushing(): boolean {
    return this.state === SpearState.RUSH;
  }

  /** Rush availability — the cooldown ONLY gates the charged rush. */
  get rushReady(): boolean {
    return this.rushCooldownTimer <= 0 && this.state !== SpearState.RUSH;
  }

  get rushCooldownRemaining(): number {
    return this.rushCooldownTimer;
  }

  // ------------------------------------------------------------------
  // Attack triggers
  // ------------------------------------------------------------------

  /**
   * Quick press → horizontal sweep. Returns false if an attack is already
   * in progress (spam is ignored — never canceled or stacked).
   */
  startSweep(): boolean {
    if (this.isBusy) return false;

    this.state = SpearState.SWEEP;
    this.sweepTimer = 0;
    this.hitTargets.clear();
    this.viewmodel?.startSweep();
    this.onCameraShake?.(sc.spearSweepCameraShake);
    this.onSweepStart?.();
    return true;
  }

  /**
   * Held press past the threshold → CHARGED SPEAR RUSH (visuals + hit
   * bookkeeping). The charge itself is driven by the owner's movement
   * system — the Game starts both together.
   */
  startRush(): boolean {
    if (this.isBusy || this.rushCooldownTimer > 0) return false;

    this.state = SpearState.RUSH;
    this.hitTargets.clear();
    this.rushHitLanded = false;
    this.tipInitialized = false;
    this.trailAccumulator = 0;
    this.viewmodel?.startRush();
    this.onCameraShake?.(sc.spearRushStartCameraShake);
    this.onRushStart?.();
    return true;
  }

  /**
   * The movement reported that the rush ended (hit / wall / timeout).
   * The 5 s cooldown starts NOW, whatever the reason. Wall impacts get a
   * small dedicated burst at the tip.
   */
  onRushEnded(reason: SpearRushEndReason): void {
    if (this.state !== SpearState.RUSH) return;
    this.state = SpearState.IDLE;
    this.rushCooldownTimer = sc.spearRushCooldown;
    this.viewmodel?.endRush();

    if (reason === "WALL" && this.tipInitialized) {
      // Wall impact feedback at the last known tip position.
      this.particles.burst(this.curTip, 16, 4, 0.35, this.energyColor, 3);
      this.particles.burst(this.curTip, 8, 2.5, 0.25, this.flashColor, 0);
      this.onCameraShake?.(sc.spearRushStartCameraShake);
    }
  }

  /** Hard reset (death / respawn): drop any attack in progress. */
  reset(): void {
    this.state = SpearState.IDLE;
    this.sweepTimer = 0;
    this.rushHitLanded = false;
    this.tipInitialized = false;
    this.hitTargets.clear();
    this.viewmodel?.hide();
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /**
   * @param eye         attacker eye position (world)
   * @param forwardFlat attacker flat view direction (XZ, normalized) — sweep
   * @param rushDir     current charge direction (movement) — rush tip
   */
  update(
    dt: number,
    eye: THREE.Vector3,
    forwardFlat: THREE.Vector3,
    rushDir: THREE.Vector3,
  ): void {
    this.rushCooldownTimer = Math.max(0, this.rushCooldownTimer - dt);

    switch (this.state) {
      case SpearState.SWEEP: {
        this.sweepTimer += dt;

        // Hit window only — no damage during wind-up or follow-through.
        if (this.sweepTimer >= sc.spearSweepHitStart && this.sweepTimer <= sc.spearSweepHitEnd) {
          this.performSweepHits(eye, forwardFlat);
        }

        // The sweep ALWAYS finishes its full sequence (nothing cancels it).
        if (this.sweepTimer >= sc.spearSweepDuration) {
          this.state = SpearState.IDLE;
        }
        break;
      }

      case SpearState.RUSH:
        this.updateRushTip(dt, eye, rushDir);
        break;

      case SpearState.IDLE:
        break;
    }

    this.viewmodel?.update(dt);
  }

  // ------------------------------------------------------------------
  // Sweep: melee arc zone (long reach, wide horizontal arc)
  // ------------------------------------------------------------------

  private performSweepHits(eye: THREE.Vector3, forwardFlat: THREE.Vector3): void {
    const cosHalfArc = Math.cos(((sc.spearSweepArcDegrees / 2) * Math.PI) / 180);

    for (const target of this.combatants) {
      if (target === this.owner || !target.health.alive) continue;
      if (this.hitTargets.has(target)) continue;

      target.getPosition(this.tmpPos);

      // Vertical band around eye height (tall enough for a standing enemy).
      if (Math.abs(this.tmpPos.y - eye.y) > sc.spearSweepHeight) continue;

      const dx = this.tmpPos.x - eye.x;
      const dz = this.tmpPos.z - eye.z;
      const distXZ = Math.hypot(dx, dz);
      if (distXZ > sc.spearSweepRange) continue;

      // Horizontal arc in front of the attacker (matches the visual sweep).
      if (distXZ > 0.001) {
        const dot = (forwardFlat.x * dx + forwardFlat.z * dz) / distXZ;
        if (dot < cosHalfArc) continue;
      }

      this.hitTargets.add(target); // one hit max per sweep
      this.applySweepHit(target, dx, dz, distXZ);
    }
  }

  private applySweepHit(target: Combatant, dx: number, dz: number, distXZ: number): void {
    // Generic damage system — exactly like the other weapons.
    const damage = target.health.max * sc.spearSweepDamageFraction;
    const applied = target.health.applyDamage(damage, this.owner, KillMethod.SPEAR_SWEEP);
    if (!applied) return; // spawn protection etc. → no knockback either

    // Knockback: attacker→victim direction + a share of attacker velocity.
    const inv = distXZ > 0.001 ? 1 / distXZ : 0;
    this.tmpKb.set(dx * inv, 0, dz * inv).multiplyScalar(sc.spearSweepKnockback);
    if (this.owner) {
      this.tmpKb.x += this.owner.velocity.x * sc.spearSweepVelocityInheritance;
      this.tmpKb.z += this.owner.velocity.z * sc.spearSweepVelocityInheritance;
    }
    this.tmpKb.y = sc.spearSweepVerticalKnockback;
    target.applyImpulse(this.tmpKb);

    // Impact feedback: energy burst + flash + small directional ring.
    target.getPosition(this.tmpPos);
    this.particles.burst(this.tmpPos, 22, 6, 0.45, this.energyColor, 3);
    this.particles.burst(this.tmpPos, 8, 3, 0.3, this.flashColor, 0);
    this.tmpDir.set(dx * inv, 0.2, dz * inv).normalize();
    this.particles.ring(this.tmpPos, this.tmpDir, 12, 0.3, 4.5, 0.3, this.energyColor);

    this.onCameraShake?.(sc.spearHitCameraShake);
    this.onHitConnect?.(this.tmpPos);
  }

  // ------------------------------------------------------------------
  // Charged rush: TIP hit detection (previous→current tip segment sweep)
  // ------------------------------------------------------------------

  /**
   * The dangerous part is the TIP, not the player capsule: the hit zone is
   * a small radius around the segment traveled by the tip this frame
   * (a swept sphere — an enemy slightly behind the player is never "hit",
   * and no bot can pass between two frames at 2× run speed).
   */
  private updateRushTip(dt: number, eye: THREE.Vector3, rushDir: THREE.Vector3): void {
    this.curTip.copy(eye).addScaledVector(rushDir, sc.spearTipReach);
    if (!this.tipInitialized) {
      this.prevTip.copy(this.curTip);
      this.tipInitialized = true;
    }

    // Discreet speed feedback: small energy motes trailing from the tip.
    this.trailAccumulator += dt;
    if (this.trailAccumulator >= 0.06) {
      this.trailAccumulator = 0;
      this.particles.burst(this.curTip, 2, 1.2, 0.25, this.energyColor, 0);
    }

    if (!this.rushHitLanded) {
      this.seg.subVectors(this.curTip, this.prevTip);
      const segLenSq = Math.max(this.seg.lengthSq(), 1e-9);

      for (const target of this.combatants) {
        if (target === this.owner || !target.health.alive) continue;
        if (this.hitTargets.has(target)) continue;

        target.getPosition(this.tmpPos);

        // Closest point on the tip's swept segment to the target center.
        this.toTarget.subVectors(this.tmpPos, this.prevTip);
        const t = THREE.MathUtils.clamp(this.toTarget.dot(this.seg) / segLenSq, 0, 1);
        this.closest.copy(this.prevTip).addScaledVector(this.seg, t);

        if (this.closest.distanceTo(this.tmpPos) > sc.spearRushHitRadius) continue;

        this.hitTargets.add(target);
        this.applyRushHit(target, rushDir);
        break; // ONE combatant max per charge
      }
    }

    this.prevTip.copy(this.curTip);
  }

  private applyRushHit(target: Combatant, rushDir: THREE.Vector3): void {
    // Exactly 50% of the TARGET's max HP — generic damage system, own method.
    const damage = target.health.max * sc.spearRushDamageFraction;
    const applied = target.health.applyDamage(damage, this.owner, KillMethod.SPEAR_RUSH);

    this.rushHitLanded = true;
    target.getPosition(this.tmpPos);

    if (applied) {
      // Heavy knockback: mostly along the charge direction + small pop-up,
      // ADDED to the victim's existing velocity (never a teleport/reset).
      this.tmpKb
        .set(rushDir.x, 0, rushDir.z)
        .normalize()
        .multiplyScalar(sc.spearRushKnockback);
      this.tmpKb.y = sc.spearRushVerticalKnockback;
      target.applyImpulse(this.tmpKb);
    }

    // Big, satisfying impact: flash at the tip + violet energy burst +
    // directional ring + local shockwave.
    this.particles.burst(this.tmpPos, 34, 9, 0.55, this.energyColor, 3);
    this.particles.burst(this.tmpPos, 14, 4, 0.35, this.flashColor, 0);
    this.tmpDir.set(rushDir.x, 0.25, rushDir.z).normalize();
    this.particles.ring(this.tmpPos, this.tmpDir, 18, 0.4, 7, 0.35, this.energyColor);
    this.shockwave.spawn(this.tmpPos, 2.6, 0.3, this.energyColor);

    this.onCameraShake?.(sc.spearRushHitCameraShake);
    // The Game stops the movement charge immediately (first hit ends it).
    this.onRushImpact?.(this.tmpPos);
  }
}