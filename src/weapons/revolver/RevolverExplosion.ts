import * as THREE from "three";
import { RevolverConfig as cfg } from "./RevolverConfig";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { ParticleSystem } from "../../effects/ParticleSystem";
import { Shockwave } from "../../effects/Shockwave";

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

  private readonly scene: THREE.Scene;
  private readonly combatants: Combatant[];
  private readonly particles: ParticleSystem;
  private readonly shockwave: Shockwave;

  // Small pool of flash lights (an explosion is very short-lived).
  private readonly flashes: { light: THREE.PointLight; t: number }[] = [];

  private readonly violet = new THREE.Color(0xa855f7);
  private readonly darkViolet = new THREE.Color(0x4c1d95);
  private readonly flashWhite = new THREE.Color(0xe9d5ff);
  private readonly upNormal = new THREE.Vector3(0, 1, 0);
  private readonly targetPos = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    combatants: Combatant[],
    particles: ParticleSystem,
    shockwave: Shockwave,
  ) {
    this.scene = scene;
    this.combatants = combatants;
    this.particles = particles;
    this.shockwave = shockwave;
  }

  explode(center: THREE.Vector3): void {
    // ---- VFX: energetic, short, violet/black (game identity) ----
    this.shockwave.spawn(center, cfg.revolverExplosionRadius, 0.45, this.violet);
    this.particles.burst(center, 42, 10, 0.55, this.violet, 4);
    this.particles.burst(center, 24, 5.5, 0.45, this.darkViolet, 3);
    this.particles.burst(center, 14, 14, 0.22, this.flashWhite, 0); // flash sparks
    this.particles.ring(center, this.upNormal, 26, 0.6, 8, 0.4, this.violet);

    const light = new THREE.PointLight(0xa855f7, 14, cfg.revolverExplosionRadius * 2.2, 2);
    light.position.copy(center);
    this.scene.add(light);
    this.flashes.push({ light, t: 0.22 });

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
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t -= dt;
      f.light.intensity = Math.max(0, f.light.intensity - dt * 70);
      if (f.t <= 0) {
        this.scene.remove(f.light);
        this.flashes.splice(i, 1);
      }
    }
  }
}