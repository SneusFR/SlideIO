import * as THREE from "three";
import { HammerConfig as hc } from "./HammerConfig";
import { Combatant } from "../combat/Combatant";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Shockwave } from "../effects/Shockwave";
import { HammerViewmodel } from "./HammerViewmodel";

/**
 * Melee attack state. Once an attack starts its type is LOCKED until the
 * whole sequence (including recovery) finishes — no cancel, no spam.
 */
export enum HammerState {
  IDLE = "IDLE",
  SWING = "SWING", // grounded horizontal sweep
  SLAM_DIVE = "SLAM_DIVE", // airborne charge toward the ground
  SLAM_RECOVERY = "SLAM_RECOVERY", // short lockout after the AoE impact
}

export type SwingSide = "LEFT" | "RIGHT";

/**
 * Combat hammer melee controller (reusable logic, not tied to the camera).
 * - A while grounded → alternating horizontal sweep (melee zone, hit window,
 *   one hit per target per swing, 50% max-HP damage, violent knockback).
 * - A while airborne → Ground Slam (the descent itself is driven by the
 *   owner's movement; on landing this controller resolves the AoE).
 * Damage goes through the SAME generic Health system as the Plasma Rifle.
 */
export class HammerWeapon {
  state = HammerState.IDLE;

  /** The combatant wielding the hammer (never damaged by its own hits). */
  owner: Combatant | null = null;

  /** Direction of the NEXT swing — flips after each attack actually launched. */
  nextSwingDirection: SwingSide = "LEFT"; // first swing: right → left

  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;

  private swingTimer = 0; // elapsed time inside the current swing
  private recoveryTimer = 0;
  /** Each combatant can only take ONE hit per swing / per slam impact. */
  private readonly hitTargetsThisSwing = new Set<Combatant>();

  // Scratch (no per-frame allocations)
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpKb = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly energyColor = new THREE.Color(0xa855f7);
  private readonly flashColor = new THREE.Color(0xe9d5ff);
  private readonly dustColor = new THREE.Color(0x8a7fb8);
  private readonly upNormal = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly combatants: Combatant[],
    private readonly particles: ParticleSystem,
    private readonly shockwave: Shockwave,
    private readonly viewmodel: HammerViewmodel | null = null,
  ) {}

  /** True while any melee sequence is running (input must be ignored). */
  get isBusy(): boolean {
    return this.state !== HammerState.IDLE;
  }

  /** The Plasma Rifle cannot fire while the hammer is out. */
  get blocksFiring(): boolean {
    return this.isBusy;
  }

  // ------------------------------------------------------------------
  // Attack triggers
  // ------------------------------------------------------------------

  /**
   * Start the grounded horizontal sweep. Returns false if an attack is
   * already in progress (spam is ignored — never canceled or stacked).
   */
  startSwing(): boolean {
    if (this.isBusy) return false;

    this.state = HammerState.SWING;
    this.swingTimer = 0;
    this.hitTargetsThisSwing.clear();

    // Visual alternation: +1 sweeps right → left ("SWING LEFT").
    const dirSign = this.nextSwingDirection === "LEFT" ? 1 : -1;
    this.viewmodel?.startSwing(dirSign);

    // Flip AFTER the attack actually launched.
    this.nextSwingDirection = this.nextSwingDirection === "LEFT" ? "RIGHT" : "LEFT";

    this.onCameraShake?.(hc.hammerSwingCameraShake);
    return true;
  }

  /**
   * Start the airborne Ground Slam sequence (visuals + hit bookkeeping).
   * The vertical charge itself is driven by the owner's movement system;
   * the AoE resolves when onSlamLanded() reports the real ground contact.
   */
  startSlam(): boolean {
    if (this.isBusy) return false;
    this.state = HammerState.SLAM_DIVE;
    this.hitTargetsThisSwing.clear();
    this.viewmodel?.startSlam();
    return true;
  }

  /**
   * Real ground contact during the dive → AoE damage + radial knockback
   * + shockwave. Detection runs ONCE, exactly at the impact.
   */
  onSlamLanded(impactPoint: THREE.Vector3): void {
    if (this.state !== HammerState.SLAM_DIVE) return;

    this.resolveSlamAoE(impactPoint);
    this.spawnSlamVfx(impactPoint);
    this.onCameraShake?.(hc.groundSlamCameraShake);

    this.viewmodel?.startSlamImpact();
    this.state = HammerState.SLAM_RECOVERY;
    this.recoveryTimer = hc.groundSlamRecovery;
  }

  /** Hard reset (death / respawn): drop any attack in progress. */
  reset(): void {
    this.state = HammerState.IDLE;
    this.swingTimer = 0;
    this.recoveryTimer = 0;
    this.hitTargetsThisSwing.clear();
    this.viewmodel?.hide();
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /**
   * @param eye         attacker eye position (world)
   * @param forwardFlat attacker flat view direction (XZ, normalized)
   */
  update(dt: number, eye: THREE.Vector3, forwardFlat: THREE.Vector3): void {
    switch (this.state) {
      case HammerState.SWING: {
        this.swingTimer += dt;

        // Hit window only — no damage during wind-up or follow-through.
        if (this.swingTimer >= hc.hammerHitStart && this.swingTimer <= hc.hammerHitEnd) {
          this.performSwingHits(eye, forwardFlat);
        }

        // The swing ALWAYS finishes its full sequence (nothing cancels it).
        if (this.swingTimer >= hc.hammerSwingDuration) {
          this.state = HammerState.IDLE;
        }
        break;
      }

      case HammerState.SLAM_DIVE:
        // Waiting for the real ground contact (movement calls onSlamLanded).
        break;

      case HammerState.SLAM_RECOVERY:
        this.recoveryTimer -= dt;
        if (this.recoveryTimer <= 0) this.state = HammerState.IDLE;
        break;

      case HammerState.IDLE:
        break;
    }

    this.viewmodel?.update(dt);
  }

  // ------------------------------------------------------------------
  // Ground swing: melee zone (short range, wide horizontal arc)
  // ------------------------------------------------------------------

  private performSwingHits(eye: THREE.Vector3, forwardFlat: THREE.Vector3): void {
    const cosHalfArc = Math.cos(((hc.hammerSwingArcDegrees / 2) * Math.PI) / 180);

    for (const target of this.combatants) {
      if (target === this.owner || !target.health.alive) continue;
      if (this.hitTargetsThisSwing.has(target)) continue;

      target.getPosition(this.tmpPos);

      // Vertical band around eye height (tall enough for a standing enemy).
      if (Math.abs(this.tmpPos.y - eye.y) > hc.hammerSwingHeight) continue;

      const dx = this.tmpPos.x - eye.x;
      const dz = this.tmpPos.z - eye.z;
      const distXZ = Math.hypot(dx, dz);
      if (distXZ > hc.hammerSwingRange) continue;

      // Horizontal arc in front of the attacker (matches the visual sweep).
      if (distXZ > 0.001) {
        const dot = (forwardFlat.x * dx + forwardFlat.z * dz) / distXZ;
        if (dot < cosHalfArc) continue;
      }

      this.hitTargetsThisSwing.add(target); // one hit max per swing
      this.applySwingHit(target, dx, dz, distXZ);
    }
  }

  private applySwingHit(target: Combatant, dx: number, dz: number, distXZ: number): void {
    // Generic damage system — exactly like the Plasma Rifle.
    const damage = target.health.max * hc.hammerGroundDamageFraction;
    const applied = target.health.applyDamage(damage, this.owner);
    if (!applied) return; // spawn protection etc. → no knockback either

    // Violent knockback: mostly attacker→victim direction, slightly
    // influenced by the attacker's current velocity. Added as an impulse
    // on top of the victim's momentum — never a teleport, never a reset.
    const inv = distXZ > 0.001 ? 1 / distXZ : 0;
    this.tmpKb.set(dx * inv, 0, dz * inv).multiplyScalar(hc.hammerGroundKnockback);
    if (this.owner) {
      this.tmpKb.x += this.owner.velocity.x * hc.hammerVelocityInheritance;
      this.tmpKb.z += this.owner.velocity.z * hc.hammerVelocityInheritance;
    }
    this.tmpKb.y = hc.hammerGroundVerticalKnockback;
    target.applyImpulse(this.tmpKb);

    // Impact feedback: energy burst + flash + small directional ring.
    target.getPosition(this.tmpPos);
    this.particles.burst(this.tmpPos, 26, 7, 0.5, this.energyColor, 3);
    this.particles.burst(this.tmpPos, 10, 3, 0.35, this.flashColor, 0);
    this.tmpDir.set(dx * inv, 0.2, dz * inv).normalize();
    this.particles.ring(this.tmpPos, this.tmpDir, 14, 0.35, 5, 0.3, this.energyColor);

    this.onCameraShake?.(hc.hammerCameraShake);
  }

  // ------------------------------------------------------------------
  // Ground Slam: circular AoE resolved ONCE at the real impact
  // ------------------------------------------------------------------

  private resolveSlamAoE(center: THREE.Vector3): void {
    for (const target of this.combatants) {
      if (target === this.owner || !target.health.alive) continue;
      if (this.hitTargetsThisSwing.has(target)) continue;

      target.getPosition(this.tmpPos);

      const dx = this.tmpPos.x - center.x;
      const dz = this.tmpPos.z - center.z;
      const distXZ = Math.hypot(dx, dz);

      // Inside the radius → full damage. Outside → nothing (no falloff v1).
      if (distXZ > hc.groundSlamRadius) continue;
      const dy = this.tmpPos.y - center.y;
      if (dy < -hc.groundSlamHeightTolerance || dy > hc.groundSlamHeightTolerance) continue;

      this.hitTargetsThisSwing.add(target); // one hit per impact

      const damage = target.health.max * hc.groundSlamDamageFraction;
      const applied = target.health.applyDamage(damage, this.owner);
      if (!applied) continue;

      // Radial knockback away from the impact + shockwave pop-up.
      if (distXZ > 0.001) {
        this.tmpKb.set(dx / distXZ, 0, dz / distXZ);
      } else {
        const a = Math.random() * Math.PI * 2;
        this.tmpKb.set(Math.cos(a), 0, Math.sin(a));
      }
      this.tmpKb.multiplyScalar(hc.groundSlamKnockback);
      this.tmpKb.y = hc.groundSlamVerticalKnockback;
      target.applyImpulse(this.tmpKb);

      // Per-victim hit feedback.
      this.particles.burst(this.tmpPos, 16, 5, 0.4, this.energyColor, 3);
    }
  }

  private spawnSlamVfx(center: THREE.Vector3): void {
    // Expanding ground ring — its final radius matches the damage radius.
    this.shockwave.spawn(center, hc.groundSlamRadius, 0.45, this.energyColor);

    // Horizontal particle shockwave hugging the ground.
    this.tmpPos.copy(center);
    this.tmpPos.y += 0.15;
    this.particles.ring(this.tmpPos, this.upNormal, 46, 0.9, 15, 0.55, this.energyColor);

    // Central flash + stylized dust / debris falling back down.
    this.particles.burst(this.tmpPos, 14, 4, 0.35, this.flashColor, 0);
    this.particles.burst(this.tmpPos, 30, 8, 0.8, this.dustColor, 7);
  }
}