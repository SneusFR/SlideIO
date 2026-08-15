import * as THREE from "three";
import { RAPIER } from "../../physics/PhysicsWorld";
import { PlayerController } from "../../player/PlayerController";
import { PlayerMovement } from "../../player/PlayerMovement";
import { PlayerCombatant } from "../../combat/PlayerCombatant";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { FPSCamera } from "../../camera/FPSCamera";
import { GameAudio } from "../../audio/GameAudio";
import { MovementConfig as mc } from "../../player/MovementConfig";
import { MoleStrikeConfig as cfg } from "./MoleStrikeConfig";
import { MoleStrikeVFX } from "./MoleStrikeVFX";

enum MolePhase {
  INACTIVE = "INACTIVE",
  /** Dive-in transition: camera sinks, dirt bursts. */
  ENTERING = "ENTERING",
  /** Burrowed: invulnerable, untargetable, free movement, dirt trail. */
  UNDERGROUND = "UNDERGROUND",
  /** Pop-out transition: AoE already resolved, camera rises back. */
  EMERGING = "EMERGING",
}

const easeInOut = (t: number) => t * t * (3 - 2 * t);

/**
 * MOLE STRIKE killstreak ability. Lifecycle:
 *   activate() → ENTERING → UNDERGROUND (≤ moleStrikeDuration, E emerges)
 *   → EMERGING (AoE resolved EXACTLY ONCE at emergence start) → INACTIVE.
 * abort() (death mid-ability) cleans everything up WITHOUT the AoE.
 * The manager transition (ACTIVE → SPENT) happens via the onComplete
 * callback passed to activate() — this class never touches slot state.
 */
export class MoleStrike {
  private phase = MolePhase.INACTIVE;
  private phaseTimer = 0;
  private undergroundTimer = 0;
  private trailAccumulator = 0;
  private onComplete: (() => void) | null = null;

  // Scratch (no per-frame allocations)
  private readonly pos = new THREE.Vector3();
  private readonly feet = new THREE.Vector3();
  private readonly surface = new THREE.Vector3();
  private readonly targetPos = new THREE.Vector3();
  private readonly kb = new THREE.Vector3();
  private readonly rayDir = { x: 0, y: -1, z: 0 };

  constructor(
    private readonly player: PlayerController,
    private readonly movement: PlayerMovement,
    private readonly playerCombatant: PlayerCombatant,
    private readonly fpsCamera: FPSCamera,
    private readonly combatants: Combatant[],
    private readonly vfx: MoleStrikeVFX,
    private readonly gameAudio: GameAudio,
  ) {}

  /** True from activation until the ability fully resolves. */
  get active(): boolean {
    return this.phase !== MolePhase.INACTIVE;
  }

  /** Weapons/melee are blocked for the whole ability. */
  get blocksWeapons(): boolean {
    return this.active;
  }

  /** Extra downward camera offset (m) — fed to CameraFeel.undergroundDrop. */
  get cameraDrop(): number {
    switch (this.phase) {
      case MolePhase.ENTERING:
        return easeInOut(Math.min(1, this.phaseTimer / cfg.moleStrikeEnterDuration)) *
          cfg.moleStrikeCameraDrop;
      case MolePhase.UNDERGROUND:
        return cfg.moleStrikeCameraDrop;
      case MolePhase.EMERGING:
        return (
          (1 - easeInOut(Math.min(1, this.phaseTimer / cfg.moleStrikeExitDuration))) *
          cfg.moleStrikeCameraDrop
        );
      default:
        return 0;
    }
  }

  /**
   * Activation precondition: alive AND solid ground close below the feet.
   * A refused activation costs NOTHING — the caller keeps the slot READY.
   */
  canActivate(): boolean {
    if (this.active || !this.playerCombatant.health.alive) return false;
    return this.groundDistanceBelowFeet() <= cfg.moleStrikeGroundProximity;
  }

  /** Dive underground. Call only after canActivate() returned true. */
  activate(onComplete: () => void): void {
    if (this.active) return;
    this.onComplete = onComplete;
    this.phase = MolePhase.ENTERING;
    this.phaseTimer = 0;
    this.trailAccumulator = 0;

    // Untouchable: damage blocked, bots drop the target instantly.
    this.playerCombatant.health.invulnerable = true;
    this.playerCombatant.setUnderground(true);
    this.movement.startUnderground();

    this.getFeetPosition(this.feet);
    this.vfx.enterBurst(this.feet);
    this.gameAudio.moleEnter();
  }

  /** Player pressed E while burrowed → erupt right here. */
  requestEmerge(): void {
    if (this.phase !== MolePhase.UNDERGROUND) return;
    this.beginEmerge();
  }

  /**
   * Death mid-ability: immediate cleanup, NO AoE, the slot still gets
   * consumed (completeActivation) — death then resets it to LOCKED anyway.
   */
  abort(): void {
    if (!this.active) return;
    this.phase = MolePhase.INACTIVE;
    this.cleanup();
    const done = this.onComplete;
    this.onComplete = null;
    done?.();
  }

  update(dt: number): void {
    switch (this.phase) {
      case MolePhase.INACTIVE:
        return;

      case MolePhase.ENTERING:
        this.phaseTimer += dt;
        this.updateOverlay();
        this.gameAudio.setUndergroundLayer(true);
        if (this.phaseTimer >= cfg.moleStrikeEnterDuration) {
          this.phase = MolePhase.UNDERGROUND;
          this.undergroundTimer = cfg.moleStrikeDuration;
        }
        break;

      case MolePhase.UNDERGROUND: {
        this.undergroundTimer -= dt;
        this.updateOverlay();
        this.gameAudio.setUndergroundLayer(true);
        // Constant low rumble while burrowing.
        this.fpsCamera.addShake(cfg.moleStrikeRumbleShakePerSecond * dt);
        this.updateTrail(dt);
        if (this.undergroundTimer <= 0) this.beginEmerge();
        break;
      }

      case MolePhase.EMERGING:
        this.phaseTimer += dt;
        this.updateOverlay();
        if (this.phaseTimer >= cfg.moleStrikeExitDuration) {
          this.phase = MolePhase.INACTIVE;
          this.cleanup();
          const done = this.onComplete;
          this.onComplete = null;
          done?.();
        }
        break;
    }
  }

  // ------------------------------------------------------------------
  // Emergence
  // ------------------------------------------------------------------

  /** Pop out of the ground: AoE resolved EXACTLY ONCE, right here. */
  private beginEmerge(): void {
    this.phase = MolePhase.EMERGING;
    this.phaseTimer = 0;

    // Movement + targeting return to normal the instant the eruption starts.
    this.movement.stopUnderground();
    this.playerCombatant.setUnderground(false);
    this.movement.velocity.y = cfg.moleStrikeExitUpwardBoost;
    this.movement.grounded = false;

    this.getFeetPosition(this.feet);
    const hitCount = this.resolveEmergeAoE();
    this.vfx.emergeBlast(this.feet);
    this.fpsCamera.addShake(cfg.moleStrikeEmergeCameraShake);
    this.gameAudio.moleEmerge(hitCount);
    this.gameAudio.setUndergroundLayer(false);
  }

  /** Damage + radial knockback on every combatant caught in the blast. */
  private resolveEmergeAoE(): number {
    const center = this.player.getPosition(this.pos);
    let hitCount = 0;

    for (const target of this.combatants) {
      if (target === this.playerCombatant || !target.health.alive) continue;

      target.getPosition(this.targetPos);
      const dy = Math.abs(this.targetPos.y - center.y);
      if (dy > cfg.moleStrikeHeightTolerance) continue;

      const dx = this.targetPos.x - center.x;
      const dz = this.targetPos.z - center.z;
      const hDist = Math.hypot(dx, dz);
      if (hDist > cfg.moleStrikeRadius) continue;

      const damage = target.health.max * cfg.moleStrikeDamageFraction;
      const applied = target.health.applyDamage(damage, this.playerCombatant, KillMethod.MOLE_STRIKE);
      if (!applied) continue; // spawn protection etc. → no knockback either
      hitCount++;

      // Radial shove away from the eruption + vertical pop-up.
      if (hDist > 0.001) {
        this.kb.set((dx / hDist) * cfg.moleStrikeKnockback, 0, (dz / hDist) * cfg.moleStrikeKnockback);
      } else {
        const a = Math.random() * Math.PI * 2;
        this.kb.set(Math.cos(a) * cfg.moleStrikeKnockback, 0, Math.sin(a) * cfg.moleStrikeKnockback);
      }
      this.kb.y = cfg.moleStrikeVerticalKnockback;
      target.applyImpulse(this.kb);
    }
    return hitCount;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Full teardown shared by the normal finish and abort(). */
  private cleanup(): void {
    this.playerCombatant.health.invulnerable = false;
    this.playerCombatant.setUnderground(false);
    this.movement.stopUnderground();
    this.vfx.setOverlayOpacity(0);
    this.gameAudio.setUndergroundLayer(false);
  }

  /** Brown vignette follows the camera drop (full only when burrowed). */
  private updateOverlay(): void {
    const progress =
      cfg.moleStrikeCameraDrop > 0 ? this.cameraDrop / cfg.moleStrikeCameraDrop : 0;
    this.vfx.setOverlayOpacity(progress * cfg.moleStrikeOverlayOpacity);
  }

  /** Dirt trail at the ground surface right above the burrowing player. */
  private updateTrail(dt: number): void {
    this.trailAccumulator += cfg.moleStrikeTrailParticleRate * dt;
    if (this.trailAccumulator < 1) return;

    // Surface point: raycast down from head height to find the ground.
    const center = this.player.getPosition(this.pos);
    const hit = this.player.physics.world.castRay(
      new RAPIER.Ray(
        { x: center.x, y: center.y + mc.standHalfHeight, z: center.z },
        this.rayDir,
      ),
      mc.standHalfHeight + mc.capsuleRadius + 3,
      true,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
    );
    if (!hit) {
      this.trailAccumulator = 0;
      return;
    }
    const surfaceY = center.y + mc.standHalfHeight - hit.timeOfImpact;
    this.surface.set(center.x, surfaceY, center.z);

    while (this.trailAccumulator >= 1) {
      this.trailAccumulator -= 1;
      this.vfx.trailPuff(this.surface);
    }
  }

  /** Feet position (capsule bottom). */
  private getFeetPosition(out: THREE.Vector3): THREE.Vector3 {
    this.player.getPosition(out);
    out.y -= mc.standHalfHeight + mc.capsuleRadius;
    return out;
  }

  /** Distance from the feet to the first solid surface below (∞ if none). */
  private groundDistanceBelowFeet(): number {
    this.getFeetPosition(this.feet);
    const hit = this.player.physics.world.castRay(
      new RAPIER.Ray(
        { x: this.feet.x, y: this.feet.y + 0.05, z: this.feet.z },
        this.rayDir,
      ),
      cfg.moleStrikeGroundProximity + 0.05,
      true,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
    );
    return hit ? Math.max(0, hit.timeOfImpact - 0.05) : Number.POSITIVE_INFINITY;
  }
}