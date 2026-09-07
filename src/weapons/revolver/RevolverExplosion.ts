import * as THREE from "three";
import { RevolverConfig as cfg } from "./RevolverConfig";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { ParticleSystem } from "../../effects/ParticleSystem";
import { Shockwave } from "../../effects/Shockwave";
import { fxLights } from "../../effects/FXLightPool";

/**
 * Thrown-revolver AoE explosion: short violet/black energy burst.
 * Every valid combatant inside the radius takes a flat 25% of MAX HP —
 * no falloff, no headshot multiplier ever, and the OWNER IS IMMUNE.
 */
export class RevolverExplosion {
  /** Thrower — never damaged by their own explosion. */
  owner: Combatant | null = null;
  /** Local-player hit feedback sink (hitmarkers / sounds / kill medals). */
  feedback: HitFeedbackManager | null = null;
  /** Audio hook (wired by the Game). */
  onExplode: ((pos: THREE.Vector3) => void) | null = null;

  private readonly combatants: Combatant[];
  private readonly particles: ParticleSystem;
  private readonly shockwave: Shockwave;

  // Flash-light STATE only — the physical lights come from the shared
  // FXLightPool (immediate-mode request re-issued every decaying frame).
  private readonly flashes: {
    position: THREE.Vector3;
    intensity: number;
    t: number;
  }[] = [];

  private readonly violet = new THREE.Color(0xa855f7);
  private readonly darkViolet = new THREE.Color(0x4c1d95);
  private readonly flashWhite = new THREE.Color(0xe9d5ff);
  private readonly upNormal = new THREE.Vector3(0, 1, 0);
  private readonly targetPos = new THREE.Vector3();

  constructor(
    _scene: THREE.Scene,
    combatants: Combatant[],
    particles: ParticleSystem,
    shockwave: Shockwave,
  ) {
    this.combatants = combatants;
    this.particles = particles;
    this.shockwave = shockwave;

    // Pre-allocate the flash STATE slots (lights come from FXLightPool).
    for (let i = 0; i < 2; i++) {
      this.flashes.push({ position: new THREE.Vector3(), intensity: 0, t: 0 });
    }
  }

  explode(center: THREE.Vector3): void {
    // ---- VFX: energetic, short, violet/black (game identity) ----
    this.shockwave.spawn(center, cfg.revolverExplosionRadius, 0.45, this.violet);
    this.particles.burst(center, 42, 10, 0.55, this.violet, 4);
    this.particles.burst(center, 24, 5.5, 0.45, this.darkViolet, 3);
    this.particles.burst(center, 14, 14, 0.22, this.flashWhite, 0); // flash sparks
    this.particles.ring(center, this.upNormal, 26, 0.6, 8, 0.4, this.violet);

    // Reuse the most-finished flash slot (pooled physical lights).
    let flash = this.flashes[0];
    for (const f of this.flashes) {
      if (f.t < flash.t) flash = f;
    }
    flash.position.copy(center);
    flash.intensity = 14;
    flash.t = 0.22;

    this.onExplode?.(center);

    // ---- AoE damage: flat 25% of max HP, inside radius only ----
    const r2 = cfg.revolverExplosionRadius * cfg.revolverExplosionRadius;
    for (const target of this.combatants) {
      if (target === this.owner) continue; // owner immune (no self damage)
      if (!target.health.alive) continue;
      target.getPosition(this.targetPos);
      if (this.targetPos.distanceToSquared(center) > r2) continue;

      const damage = target.health.max * cfg.revolverExplosionDamageFraction;
      const applied = target.health.applyDamage(
        damage,
        this.owner,
        KillMethod.REVOLVER_EXPLOSION,
        HitZone.BODY, // an explosion is NEVER a headshot
      );
      if (applied) {
        this.feedback?.registerHit({
          attacker: this.owner,
          target,
          hitZone: HitZone.BODY,
          damage,
          position: this.targetPos,
          weapon: KillMethod.REVOLVER_EXPLOSION,
          isKill: !target.health.alive,
        });
        // Per-victim violet hit burst.
        this.particles.burst(this.targetPos, 14, 5, 0.35, this.violet, 3);
      }
    }
  }

  update(dt: number): void {
    for (const f of this.flashes) {
      if (f.t <= 0) continue;
      f.t -= dt;
      f.intensity = Math.max(0, f.intensity - dt * 70);
      if (f.t <= 0) f.intensity = 0;
      if (f.intensity > 0) {
        fxLights.request(
          this.violet,
          f.intensity,
          cfg.revolverExplosionRadius * 2.2,
          2,
          f.position,
        );
      }
    }
  }
}