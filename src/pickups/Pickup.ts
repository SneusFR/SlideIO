import * as THREE from "three";
import { PickupConfig as pc } from "./PickupConfig";

/**
 * Base class for a world loot pickup (medkit, coin…).
 *
 * Instances are pooled by the PickupManager: `spawnAt` re-arms a
 * recycled object, `deactivate` returns it to the pool. The GLB model
 * is attached lazily (clone of the shared template) the first time the
 * template is available, then reused for the lifetime of the instance.
 */
export abstract class Pickup {
  readonly root = new THREE.Group();
  active = false;
  hasModel = false;

  protected age = 0;
  protected lifetime = 0;
  /** Rest height of the model center (ground + hover). */
  protected restY = 0;
  /** Random phase so pickups never bob in sync. */
  protected readonly phase = Math.random() * 10;

  /** Radius of the walk-over pickup zone. */
  abstract readonly pickupRadius: number;
  /** Sparkle tint (shared THREE.Color, never mutated). */
  abstract readonly sparkleColor: THREE.Color;

  /** Sparkle emission accumulator (managed by PickupManager). */
  sparkleAccum = Math.random();

  /** Attach a clone of the shared GLB template (once per instance). */
  attachModel(template: THREE.Group): void {
    this.root.add(template.clone());
    this.hasModel = true;
  }

  /** Advance the animation. Returns false when the lifetime expired. */
  update(dt: number, time: number): boolean {
    this.age += dt;
    if (this.age >= this.lifetime) return false;
    this.animate(dt, time);
    this.applyFade();
    return true;
  }

  protected abstract animate(dt: number, time: number): void;

  /** Small scale-down fade during the last moments of the lifetime. */
  private applyFade(): void {
    const remain = this.lifetime - this.age;
    const k =
      remain < pc.fadeOutDuration
        ? Math.max(remain, 0.001) / pc.fadeOutDuration
        : 1;
    if (this.root.scale.x !== k) this.root.scale.setScalar(k);
  }

  /** Remove from the scene and reset for pooling. */
  deactivate(): void {
    this.active = false;
    this.root.removeFromParent();
    this.root.scale.setScalar(1);
  }

  protected arm(lifetime: number): void {
    this.active = true;
    this.age = 0;
    this.lifetime = lifetime;
    this.root.scale.setScalar(1);
  }
}