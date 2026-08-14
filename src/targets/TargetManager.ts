import * as THREE from "three";
import { TrainingTarget } from "./TrainingTarget";
import { ParticleSystem } from "../effects/ParticleSystem";

/**
 * Creates and updates the shooting-range targets.
 * Exposes `hittables` (target root groups) for the weapon raycast.
 *
 * Layout (training annex behind the blue yard, z 47 .. 93, x -22 .. 22,
 * firing line ≈ z 52 — entered through the doorway in the south wall):
 *   Close  (~z 58..62) — horizontal + vertical
 *   Medium (~z 71..74) — fast strafe + circular
 *   Long   (~z 84..88) — erratic + slow horizontal
 */
export class TargetManager {
  readonly group = new THREE.Group();
  readonly hittables: THREE.Object3D[] = [];

  private readonly targets: TrainingTarget[] = [];
  private readonly particles: ParticleSystem;

  private readonly explosionViolet = new THREE.Color(0xc084fc);
  private readonly explosionWhite = new THREE.Color(0xffffff);

  constructor(particles: ParticleSystem) {
    this.particles = particles;

    // ---- Close range ----
    this.add(
      new TrainingTarget("horizontal", new THREE.Vector3(0, 1.8, 58), {
        amplitude: 6,
        speed: 1.1,
      }),
    );
    this.add(
      new TrainingTarget("vertical", new THREE.Vector3(-10, 3.2, 62), {
        amplitude: 1.9,
        speed: 1.6,
      }),
    );

    // ---- Medium range ----
    this.add(
      new TrainingTarget("strafe", new THREE.Vector3(6, 2.4, 71), {
        amplitude: 8,
        speed: 9,
      }),
    );
    this.add(
      new TrainingTarget("circular", new THREE.Vector3(-11, 4.2, 74), {
        radius: 3,
        speed: 1.4,
      }),
    );

    // ---- Long range ----
    this.add(
      new TrainingTarget("erratic", new THREE.Vector3(8, 3.5, 84), {
        speed: 6,
        zone: { x: 8, y: 2.2, z: 4 },
      }),
    );
    this.add(
      new TrainingTarget("horizontal", new THREE.Vector3(-9, 2.5, 88), {
        amplitude: 7,
        speed: 0.7,
      }),
    );
  }

  private add(target: TrainingTarget): void {
    target.onDestroyed = (pos) => this.explode(pos);
    this.targets.push(target);
    this.group.add(target.group);
    this.hittables.push(target.group);
  }

  private explode(pos: THREE.Vector3): void {
    this.particles.burst(pos, 28, 8, 0.9, this.explosionViolet, 5);
    this.particles.burst(pos, 12, 3.5, 0.5, this.explosionWhite, 2);
  }

  update(dt: number): void {
    for (const target of this.targets) target.update(dt);
  }
}