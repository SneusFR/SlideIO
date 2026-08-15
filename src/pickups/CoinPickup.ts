import * as THREE from "three";
import { Pickup } from "./Pickup";
import { PickupConfig as pc } from "./PickupConfig";

const SPARKLE_COLOR = new THREE.Color(0xfcd34d);

/**
 * Coin drop: pops out of the death point along a small arc toward its
 * scattered landing spot (cheap parametric arc — no physics sim), then
 * idles with a bounce/bob + fast spin so it reads as valuable loot.
 */
export class CoinPickup extends Pickup {
  readonly pickupRadius = pc.coinPickupRadius;
  readonly sparkleColor = SPARKLE_COLOR;

  private startX = 0;
  private startY = 0;
  private startZ = 0;
  private targetX = 0;
  private targetZ = 0;

  spawnAt(
    originX: number,
    originY: number,
    originZ: number,
    targetX: number,
    targetGroundY: number,
    targetZ: number,
  ): void {
    this.arm(pc.coinLifetime);
    this.startX = originX;
    this.startY = originY + 0.4;
    this.startZ = originZ;
    this.targetX = targetX;
    this.targetZ = targetZ;
    this.restY = targetGroundY + pc.coinHoverHeight;
    this.root.position.set(this.startX, this.startY, this.startZ);
    this.root.rotation.set(0, Math.random() * Math.PI * 2, 0);
  }

  protected animate(dt: number, time: number): void {
    const p = this.root.position;
    if (this.age < pc.coinPopDuration) {
      // Pop arc: ease-out toward the landing spot + parabolic height.
      const k = this.age / pc.coinPopDuration;
      const ease = 1 - (1 - k) * (1 - k);
      p.x = THREE.MathUtils.lerp(this.startX, this.targetX, ease);
      p.z = THREE.MathUtils.lerp(this.startZ, this.targetZ, ease);
      p.y =
        THREE.MathUtils.lerp(this.startY, this.restY, k) +
        Math.sin(k * Math.PI) * pc.coinPopHeight;
    } else {
      // Idle: small settle bounce right after landing, then bob + jitter.
      const t = this.age - pc.coinPopDuration;
      const settle = Math.exp(-4 * t) * Math.abs(Math.cos(t * 11)) * 0.16;
      const bob =
        Math.sin((time + this.phase) * pc.coinBobSpeed) * pc.coinBobHeight;
      const vib = Math.sin((time + this.phase) * 25) * 0.006;
      p.x = this.targetX;
      p.z = this.targetZ;
      p.y = this.restY + settle + bob + vib;
    }
    this.root.rotation.y += pc.coinSpinSpeed * dt;
  }
}