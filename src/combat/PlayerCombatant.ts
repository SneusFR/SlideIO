import * as THREE from "three";
import { Combatant, Health } from "./Combatant";
import { CombatConfig as cc } from "./CombatConfig";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement } from "../player/PlayerMovement";
import { MovementConfig as mc } from "../player/MovementConfig";

/**
 * The human player as an FFA combatant: shares the exact same Health
 * component as the bots, plus an invisible hit proxy mesh so bot beams
 * (THREE raycasts) can actually hit the player capsule.
 */
export class PlayerCombatant implements Combatant {
  readonly id = -1;
  readonly name = "Player";
  readonly health = new Health(cc.playerMaxHealth);

  /** Invisible cylinder matching the capsule — raycastable, never rendered. */
  readonly hitProxy: THREE.Mesh;

  private readonly pos = new THREE.Vector3();

  constructor(
    private readonly player: PlayerController,
    private readonly movement: PlayerMovement,
    scene: THREE.Scene,
  ) {
    const h = (mc.standHalfHeight + mc.capsuleRadius) * 2;
    const geo = new THREE.CylinderGeometry(mc.capsuleRadius, mc.capsuleRadius, h, 8);
    const mat = new THREE.MeshBasicMaterial();
    mat.visible = false; // skipped by the renderer, still hit by raycasts
    this.hitProxy = new THREE.Mesh(geo, mat);
    this.hitProxy.userData.combatant = this;
    scene.add(this.hitProxy);
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
  }

  /** Keep the hit proxy glued to the capsule (call once per frame). */
  syncProxy(): void {
    this.player.getPosition(this.pos);
    this.hitProxy.position.copy(this.pos);
  }
}