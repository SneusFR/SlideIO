import * as THREE from "three";
import { RevolverConfig as cfg } from "./RevolverConfig";
import { cloneRevolver } from "./RevolverModel";
import { Combatant } from "../../combat/Combatant";
import { castBeam, BeamCastResult } from "../BeamCombat";
import { RevolverExplosion } from "./RevolverExplosion";

interface ThrownRevolver {
  group: THREE.Group;
  velocity: THREE.Vector3;
  spinAxis: THREE.Vector3;
  life: number;
  prev: THREE.Vector3;
}

/**
 * Thrown revolvers flying through the world. Each one:
 *   - reuses the SAME optimized cached model (cheap clone, shared GPU data);
 *   - flies camera-forward with light gravity while spinning;
 *   - uses a swept segment raycast every frame (prev → next position),
 *     so even a fast throw can never tunnel through a bot or a wall (CCD);
 *   - explodes on the FIRST valid obstacle (no bounce, no pierce), then
 *     is removed — nothing persistent is ever left in the world.
 */
export class RevolverProjectileSystem {
  /** Thrower — the sweep never collides with their own capsule. */
  owner: Combatant | null = null;

  private readonly scene: THREE.Scene;
  private readonly explosion: RevolverExplosion;
  private readonly active: ThrownRevolver[] = [];

  private readonly raycaster = new THREE.Raycaster();
  private readonly sweepResult = new BeamCastResult();
  private readonly segDir = new THREE.Vector3();

  constructor(scene: THREE.Scene, explosion: RevolverExplosion) {
    this.scene = scene;
    this.explosion = explosion;
  }

  get count(): number {
    return this.active.length;
  }

  /** Launch a thrown revolver (template = the shared cached model). */
  spawn(origin: THREE.Vector3, dir: THREE.Vector3, template: THREE.Group | null): void {
    const group = template ? cloneRevolver(template) : new THREE.Group();
    group.scale.setScalar(cfg.revolverThrownModelLength);
    group.position.copy(origin);
    // Start roughly aligned with the throw, then tumble.
    group.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
    this.scene.add(group);

    const spinAxis = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize();
    if (spinAxis.lengthSq() < 1e-6) spinAxis.set(1, 0, 0);

    this.active.push({
      group,
      velocity: dir.clone().multiplyScalar(cfg.revolverThrowSpeed),
      spinAxis,
      life: cfg.revolverProjectileMaxLifetime,
      prev: origin.clone(),
    });
  }

  update(dt: number, hittables: THREE.Object3D[]): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];

      // Integrate: forward velocity + light gravity + tumbling spin.
      p.velocity.y -= cfg.revolverThrowGravity * dt;
      p.prev.copy(p.group.position);
      p.group.position.addScaledVector(p.velocity, dt);
      p.group.rotateOnAxis(p.spinAxis, cfg.revolverThrowSpinSpeed * dt);

      // Continuous collision: sweep the full segment traveled this frame.
      this.segDir.subVectors(p.group.position, p.prev);
      const dist = this.segDir.length();
      if (dist > 1e-6) {
        this.segDir.multiplyScalar(1 / dist);
        castBeam(
          this.raycaster,
          p.prev,
          this.segDir,
          dist,
          hittables,
          this.owner,
          this.sweepResult,
        );
        if (this.sweepResult.hit) {
          // First valid obstacle (wall / floor / bot / player) → BOOM.
          this.explosion.explode(this.sweepResult.point);
          this.remove(i);
          continue;
        }
      }

      p.life -= dt;
      if (p.life <= 0) {
        // Safety net: never let a projectile live forever.
        this.explosion.explode(p.group.position);
        this.remove(i);
      }
    }
  }

  /** Drop every in-flight revolver WITHOUT exploding (death cleanup). */
  clear(): void {
    for (const p of this.active) this.scene.remove(p.group);
    this.active.length = 0;
  }

  private remove(index: number): void {
    // Geometry/materials are shared with the cached template — never disposed.
    this.scene.remove(this.active[index].group);
    this.active.splice(index, 1);
  }
}