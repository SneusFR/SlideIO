import * as THREE from "three";
import { HammerConfig as hc } from "./HammerConfig";
import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Shockwave } from "../effects/Shockwave";
import { HammerViewmodel } from "./HammerViewmodel";

/**
 * Melee attack state. Once an attack starts its type is LOCKED until the
 * whole sequence (including recovery) finishes — no cancel, no spam.
 */
export enum HammerState {
  IDLE = "IDLE",
  SWING = "SWING", // grounded WHIRLWIND (360°, three turns)
  SLAM_DIVE = "SLAM_DIVE", // airborne charge toward the ground
  SLAM_RECOVERY = "SLAM_RECOVERY", // Slam_Land lockout after the AoE impact
}

/**
 * Brick Maul melee controller (reusable logic, not tied to the camera).
 * - A while grounded → WHIRLWIND: 1.35 s, 360° zone active during
 *   0.20–1.04 s, ONE set of victims for the whole attack (three visual
 *   turns never re-hit), FLAT 50 damage per victim, violent knockback.
 * - A while airborne → Ground Slam (the descent itself is driven by the
 *   owner's movement; on the REAL landing this controller resolves ONE
 *   AoE of FLAT 50 damage per victim, then 0.72 s of recovery).
 * Damage goes through the SAME generic Health system as the Plasma Rifle.
 */
export class HammerWeapon {
  state = HammerState.IDLE;

  /** The combatant wielding the hammer (never damaged by its own hits). */
  owner: Combatant | null = null;

  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;

  // ---- Audio hooks (observation only — never change gameplay) ----
  /** A swing was launched (hit or miss — the big whoosh). */
  onSwingStart: (() => void) | null = null;
  /** The hammer connected with a combatant. */
  onHitConnect: ((pos: THREE.Vector3) => void) | null = null;
  /** The Ground Slam dive started. */
  onSlamStart: (() => void) | null = null;
  /** The Ground Slam impacted; `hitCount` combatants were caught. */
  onSlamImpact: ((pos: THREE.Vector3, hitCount: number) => void) | null = null;

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

  /**
   * Elapsed time (s) of the RUNNING whirlwind, -1 otherwise. Read-only view
   * of the existing attack clock — the FP camera spin and a late FP clip
   * entry sample it; nothing else may drive it.
   */
  get whirlwindElapsedSeconds(): number {
    return this.state === HammerState.SWING ? this.swingTimer : -1;
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
    this.hitTargetsThisSwing.clear(); // ONE victim set for the whole whirlwind

    this.viewmodel?.startSwing();

    this.onCameraShake?.(hc.hammerSwingCameraShake);
    this.onSwingStart?.();
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
    this.onSlamStart?.();
    return true;
  }

  /**
   * Real ground contact during the dive → AoE damage + radial knockback
   * + shockwave. Detection runs ONCE, exactly at the impact.
   */
  onSlamLanded(impactPoint: THREE.Vector3): void {
    if (this.state !== HammerState.SLAM_DIVE) return;

    const hitCount = this.resolveSlamAoE(impactPoint);
    this.spawnSlamVfx(impactPoint);
    this.onCameraShake?.(hc.groundSlamCameraShake);
    this.onSlamImpact?.(impactPoint, hitCount);

    this.viewmodel?.startSlamImpact();
    this.state = HammerState.SLAM_RECOVERY;
    this.recoveryTimer = hc.groundSlamRecovery;
  }

  /**
   * Hard reset (death / respawn / knockdown): drop any attack in progress.
   * The FP actions are cancelled; the presentation itself (attached or
   * not) stays the Game's decision — never a hidden hide() from here.
   */
  reset(): void {
    this.state = HammerState.IDLE;
    this.swingTimer = 0;
    this.recoveryTimer = 0;
    this.hitTargetsThisSwing.clear();
    this.viewmodel?.cancelActions();
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
        const prev = this.swingTimer;
        this.swingTimer += dt;

        // Active phase: test the OVERLAP of [prev, now] with the authored
        // window so a long frame that jumps across it never loses the
        // sweep. Targets entering during the window are hit once; the
        // victim set persists for the three turns (no re-hit).
        if (this.swingTimer >= hc.hammerHitStart && prev <= hc.hammerHitEnd) {
          this.performSwingHits(eye, forwardFlat);
        }

        // The whirlwind ALWAYS finishes its full sequence (nothing cancels it).
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
    // The FP presentation (shared arms mixer) is advanced by the Game —
    // exactly once per frame, by whichever weapon owns the arms.
  }

  // ------------------------------------------------------------------
  // Ground swing: melee zone (short range, wide horizontal arc)
  // ------------------------------------------------------------------

  private performSwingHits(eye: THREE.Vector3, forwardFlat: THREE.Vector3): void {
    // 360° → every direction passes (the cosine test below is skipped).
    const fullCircle = hc.hammerSwingArcDegrees >= 360;
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

      // Horizontal arc around the attacker (360° for the whirlwind).
      if (!fullCircle && distXZ > 0.001) {
        const dot = (forwardFlat.x * dx + forwardFlat.z * dz) / distXZ;
        if (dot < cosHalfArc) continue;
      }

      this.hitTargetsThisSwing.add(target); // one hit max per attack
      this.applySwingHit(target, dx, dz, distXZ);
    }
  }

  private applySwingHit(target: Combatant, dx: number, dz: number, distXZ: number): void {
    // Violent knockback: mostly attacker→victim direction, slightly
    // influenced by the attacker's current velocity. Added as an impulse
    // on top of the victim's momentum — never a teleport, never a reset.
    // Computed BEFORE the damage so a LETHAL hit can hand the exact
    // impulse + impact point to the victim's death ragdoll (§ ragdoll).
    const inv = distXZ > 0.001 ? 1 / distXZ : 0;
    this.tmpKb.set(dx * inv, 0, dz * inv).multiplyScalar(hc.hammerGroundKnockback);
    if (this.owner) {
      this.tmpKb.x += this.owner.velocity.x * hc.hammerVelocityInheritance;
      this.tmpKb.z += this.owner.velocity.z * hc.hammerVelocityInheritance;
    }
    this.tmpKb.y = hc.hammerGroundVerticalKnockback;

    // Impact point: torso height, on the side FACING the attacker — the
    // ragdoll receives the impulse exactly where the hammer connected.
    target.getPosition(this.tmpPos);
    this.tmpDir.set(dx * inv, 0, dz * inv);
    this.tmpPos.x -= this.tmpDir.x * 0.3;
    this.tmpPos.z -= this.tmpDir.z * 0.3;
    this.tmpPos.y += 0.15;
    target.registerImpact?.(this.tmpKb, this.tmpPos);

    // Generic damage system — FLAT 50 (same on 100 or 200 max HP).
    const applied = target.health.applyDamage(hc.hammerGroundDamage, this.owner, KillMethod.HAMMER_SWING);
    if (!applied) return; // spawn protection etc. → no knockback either

    target.applyImpulse(this.tmpKb);

    // Impact feedback: energy burst + flash + small directional ring.
    target.getPosition(this.tmpPos);
    this.particles.burst(this.tmpPos, 26, 7, 0.5, this.energyColor, 3);
    this.particles.burst(this.tmpPos, 10, 3, 0.35, this.flashColor, 0);
    this.tmpDir.set(dx * inv, 0.2, dz * inv).normalize();
    this.particles.ring(this.tmpPos, this.tmpDir, 14, 0.35, 5, 0.3, this.energyColor);

    this.onCameraShake?.(hc.hammerCameraShake);
    this.onHitConnect?.(this.tmpPos);
  }

  // ------------------------------------------------------------------
  // Ground Slam: circular AoE resolved ONCE at the real impact
  // ------------------------------------------------------------------

  private resolveSlamAoE(center: THREE.Vector3): number {
    let hitCount = 0;
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

      // Radial knockback away from the impact + shockwave pop-up.
      // Computed BEFORE the damage so a LETHAL slam hands the exact radial
      // + vertical impulse to the victim's death ragdoll (SMASHED reads
      // exactly like it looks: body lifted then ejected radially).
      if (distXZ > 0.001) {
        this.tmpKb.set(dx / distXZ, 0, dz / distXZ);
      } else {
        const a = Math.random() * Math.PI * 2;
        this.tmpKb.set(Math.cos(a), 0, Math.sin(a));
      }
      this.tmpKb.multiplyScalar(hc.groundSlamKnockback);
      this.tmpKb.y = hc.groundSlamVerticalKnockback;

      // Impact point slightly BELOW the victim's center: the shockwave
      // comes from the ground — the ragdoll tips as it is lifted.
      this.tmpDir.copy(this.tmpPos);
      this.tmpDir.y -= 0.4;
      target.registerImpact?.(this.tmpKb, this.tmpDir);

      const applied = target.health.applyDamage(hc.groundSlamDamage, this.owner, KillMethod.GROUND_SLAM);
      if (!applied) continue;
      hitCount++;

      target.applyImpulse(this.tmpKb);

      // Per-victim hit feedback.
      this.particles.burst(this.tmpPos, 16, 5, 0.4, this.energyColor, 3);
    }
    return hitCount;
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