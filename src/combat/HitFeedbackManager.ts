import * as THREE from "three";
import { Combatant } from "./Combatant";
import { HitZone } from "./HitZone";
import { KillMethod } from "./KillMethod";
import { HitFeedbackConfig as hfc } from "./HitFeedbackConfig";
import { HitmarkerHUD } from "../ui/HitmarkerHUD";
import { ParticleSystem } from "../effects/ParticleSystem";

/** One confirmed damage application, reported by a weapon. */
export interface HitEvent {
  attacker: Combatant | null;
  target: Combatant;
  hitZone: HitZone;
  damage: number;
  /** World-space impact point (null = unknown, e.g. pure AoE). */
  position: THREE.Vector3 | null;
  weapon: KillMethod;
  /** True when this exact hit killed the target (bypasses throttles). */
  isKill: boolean;
}

/**
 * Central hit-confirmation feedback for the LOCAL PLAYER only.
 *
 * Weapons report every APPLIED damage tick via `registerHit`. This manager
 * turns the raw stream into readable feedback:
 *  - a GLOBAL throttled "pulse" (hitmarker + confirmation sound) so
 *    continuous beams never spam — with two overrides: a body→head
 *    transition fires immediately (the headshot must never feel late),
 *    and a killing hit always pulses;
 *  - a PER-TARGET throttled victim reaction (flash + impact particles),
 *    so a multi-target Obliterreur still lights up every victim while the
 *    crosshair pulse stays aggregated.
 *
 * Bots never produce feedback: events whose attacker is not the local
 * player are dropped at the door.
 */
export class HitFeedbackManager {
  /** Body-hit confirmation sound (wired to GameAudio). */
  onBodyHitSound: (() => void) | null = null;
  /** Headshot confirmation sound — clearly distinct, never just louder. */
  onHeadshotSound: (() => void) | null = null;

  /** Internal pause-safe clock (advanced by Game only while running). */
  private clock = 0;
  private lastPulseAt = -Infinity;
  private lastPulseZone: HitZone = HitZone.BODY;
  /** Last victim-reaction time per target (Map cleaned lazily). */
  private readonly lastVisualAt = new Map<Combatant, number>();

  private readonly bodyColor = new THREE.Color(0xc084fc);
  private readonly headColorA = new THREE.Color(0xffffff);
  private readonly headColorB = new THREE.Color(0xa855f7);

  constructor(
    private readonly hud: HitmarkerHUD,
    private readonly particles: ParticleSystem,
    private readonly localPlayer: Combatant,
  ) {}

  update(dt: number): void {
    this.clock += dt;
  }

  registerHit(hit: HitEvent): void {
    // Local-player feedback ONLY — bot hits never touch the HUD/audio.
    if (hit.attacker !== this.localPlayer) return;

    this.pulse(hit);
    this.victimReaction(hit);
  }

  // ------------------------------------------------------------------
  // Global crosshair pulse (hitmarker + sound), throttled
  // ------------------------------------------------------------------

  private pulse(hit: HitEvent): void {
    const interval =
      hit.weapon === KillMethod.OBLITERREUR
        ? hfc.obliterreurFeedbackInterval
        : hit.hitZone === HitZone.HEAD
          ? hfc.headshotHitFeedbackInterval
          : hfc.bodyHitFeedbackInterval;

    const elapsed = this.clock - this.lastPulseAt;
    const headTransition = hit.hitZone === HitZone.HEAD && this.lastPulseZone !== HitZone.HEAD;
    if (elapsed < interval && !headTransition && !hit.isKill) return;

    this.lastPulseAt = this.clock;
    this.lastPulseZone = hit.hitZone;

    this.hud.show(hit.hitZone);
    if (hit.hitZone === HitZone.HEAD) this.onHeadshotSound?.();
    else this.onBodyHitSound?.();
  }

  // ------------------------------------------------------------------
  // Per-target victim reaction (flash + impact particles), throttled
  // ------------------------------------------------------------------

  private victimReaction(hit: HitEvent): void {
    const last = this.lastVisualAt.get(hit.target);
    if (last !== undefined && this.clock - last < hfc.targetVisualInterval && !hit.isKill) {
      return;
    }
    this.lastVisualAt.set(hit.target, this.clock);

    hit.target.onHitVisual?.(hit.hitZone, hit.position);

    if (hit.position) {
      if (hit.hitZone === HitZone.HEAD) {
        // Brighter, more energetic burst — the headshot must READ.
        this.particles.burst(
          hit.position,
          hfc.headBurstCount,
          hfc.headBurstSpeed,
          hfc.headBurstLife,
          this.headColorA,
        );
        this.particles.burst(
          hit.position,
          Math.ceil(hfc.headBurstCount / 2),
          hfc.headBurstSpeed * 0.6,
          hfc.headBurstLife,
          this.headColorB,
        );
      } else {
        this.particles.burst(
          hit.position,
          hfc.bodyBurstCount,
          hfc.bodyBurstSpeed,
          hfc.bodyBurstLife,
          this.bodyColor,
        );
      }
    }
  }
}