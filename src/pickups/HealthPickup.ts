import * as THREE from "three";
import { Pickup } from "./Pickup";
import { PickupConfig as pc } from "./PickupConfig";

const SPARKLE_COLOR = new THREE.Color(0x4ade80);

/**
 * Medkit drop: hovers above the ground with an arcade bob + slow spin +
 * subtle vibration, plus a small settle bounce right after spawning.
 * Walking over it heals the player (never above maxHealth); if the
 * player is already full, the medkit is NOT consumed and stays.
 */
export class HealthPickup extends Pickup {
  readonly pickupRadius = pc.medkitPickupRadius;
  readonly sparkleColor = SPARKLE_COLOR;

  spawnAt(x: number, groundY: number, z: number): void {
    this.arm(pc.medkitLifetime);
    this.restY = groundY + pc.medkitHoverHeight;
    this.root.position.set(x, this.restY + 0.3, z);
    this.root.rotation.set(0, Math.random() * Math.PI * 2, 0);
  }

  protected animate(dt: number, time: number): void {
    // Settle-in bounce: decaying oscillation during the first second.
    const settle = Math.exp(-3.2 * this.age) * Math.cos(this.age * 9) * 0.3;
    // Idle: vertical bob + tiny high-frequency vibration.
    const bob =
      Math.sin((time + this.phase) * pc.medkitBobSpeed) * pc.medkitBobHeight;
    const vib = Math.sin((time + this.phase) * 21) * 0.008;
    this.root.position.y = this.restY + settle + bob + vib;
    this.root.rotation.y += pc.medkitSpinSpeed * dt;
  }
}