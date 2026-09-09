import * as THREE from "three";
import { Combatant, Health } from "./Combatant";
import { CombatConfig as cc } from "./CombatConfig";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement } from "../player/PlayerMovement";
import { MovementConfig as mc } from "../player/MovementConfig";
import { RagdollConfig as rc } from "../ragdoll/RagdollConfig";
import { CHARACTER_HITBOX_SCALE } from "../../shared/combat/NetworkWeapons";

/**
 * The human player as an FFA combatant: shares the exact same Health
 * component as the bots, plus an invisible hit proxy mesh so bot beams
 * (THREE raycasts) can actually hit the player capsule.
 */
export class PlayerCombatant implements Combatant {
  readonly id = -1;
  readonly name = "Player";
  readonly health = new Health(cc.playerMaxHealth);
  /** False while burrowed underground (MOLE STRIKE) — bots drop the target. */
  targetable = true;

  /** Invisible cylinder matching the capsule — raycastable, never rendered. */
  readonly hitProxy: THREE.Mesh;

  /** Fired when a knockdown-grade impulse hits the LOCAL player (camera FX). */
  onKnockdown: ((magnitude: number) => void) | null = null;

  private readonly pos = new THREE.Vector3();

  constructor(
    private readonly player: PlayerController,
    private readonly movement: PlayerMovement,
    scene: THREE.Scene,
  ) {
    // DAMAGE proxy scaled with the rendered 2.25 m silhouette (central
    // CHARACTER_HITBOX_SCALE — same factor as the bots and the server
    // capsule), FEET ANCHORED: the proxy still tracks the MOVEMENT capsule
    // center (unscaled), so the cylinder is offset upward to keep its base
    // at the feet while its top reaches the scaled head. The movement
    // capsule itself is untouched.
    const feet = mc.standHalfHeight + mc.capsuleRadius;
    const h = feet * 2 * CHARACTER_HITBOX_SCALE;
    const r = mc.capsuleRadius * CHARACTER_HITBOX_SCALE;
    const geo = new THREE.CylinderGeometry(r, r, h, 8);
    // Base at the feet (capsule center − feet): shift the geometry up by
    // (scaled half-height − feet offset) so growth goes upward only.
    geo.translate(0, h / 2 - feet, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x33ccff,
      wireframe: true,
      toneMapped: false,
    });
    mat.visible = false; // skipped by the renderer, still hit by raycasts
    this.hitProxy = new THREE.Mesh(geo, mat);
    this.hitProxy.userData.combatant = this;
    scene.add(this.hitProxy);
  }

  /** DEBUG overlay (KeyH): show the damage proxy as a cyan wireframe.
   *  Material visibility flip only — the raycast volume never changes. */
  setHitboxDebug(on: boolean): void {
    (this.hitProxy.material as THREE.MeshBasicMaterial).visible = on;
  }

  get velocity(): THREE.Vector3 {
    return this.movement.velocity;
  }

  getPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.player.getPosition(out);
  }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    this.player.getPosition(out);
    out.y += mc.standHalfHeight * 0.9;
    return out;
  }

  /** Knockback: added on top of the current momentum (never a reset). */
  applyImpulse(impulse: THREE.Vector3): void {
    if (!this.health.alive) return;
    this.movement.velocity.add(impulse);
    if (impulse.y > 0.5) this.movement.grounded = false;

    // KNOCKDOWN (§ ragdoll — full bot parity for the local player): the
    // SAME impulse threshold that ragdolls a bot (Hammer sweep, Ground
    // Slam, Spear Rush, Mole eruption — never plasma) knocks the player
    // to the ground. The body slides away with the impact's momentum and
    // the player gets back up with Space / a movement key once the forced
    // window (scaled with the hit, same min duration as the bots) expires.
    // The camera drops to floor level but stays readable (no head-cam
    // spinning) — the Game adds a shake.
    const magnitude = impulse.length();
    if (magnitude >= rc.knockdownImpulseThreshold) {
      const t = Math.min(magnitude / (rc.knockdownImpulseThreshold * 2), 1);
      this.movement.applyKnockdown(rc.temporaryMinDuration * (0.75 + 0.75 * t));
      this.onKnockdown?.(magnitude);
    }
  }

  /** Keep the hit proxy glued to the capsule (call once per frame). */
  syncProxy(): void {
    if (!this.targetable) return; // parked far away while underground
    this.player.getPosition(this.pos);
    this.hitProxy.position.copy(this.pos);
  }

  /**
   * MOLE STRIKE support: while underground the player cannot be hit or
   * targeted — the raycastable hit proxy is parked far below the map and
   * `targetable` makes every bot drop / ignore the player instantly.
   */
  setUnderground(hidden: boolean): void {
    this.targetable = !hidden;
    if (hidden) {
      this.hitProxy.position.set(0, -9999, 0);
    } else {
      this.syncProxy();
    }
  }
}