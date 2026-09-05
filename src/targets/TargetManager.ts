import * as THREE from "three";
import { TrainingTarget } from "./TrainingTarget";
import { ParticleSystem } from "../effects/ParticleSystem";

/**
 * Creates and updates the floating training targets.
 * Exposes `hittables` (target root groups) for the weapon raycast.
 *
 * Ancient Jungle City layout — the targets hover over open zones so solo
 * warm-up shots are possible from several ranges:
 *   Close  — Central Crossing plaza (ground 0 m)
 *   Medium — Golden Lane (+1.5 m) and Lower Court (−1.5 m)
 *   Long   — East Ridge (+3 m) and the Sun Gate stairs sightline
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

    // ---- Close range: Central Crossing plaza ----
    this.add(
      new TrainingTarget("horizontal", new THREE.Vector3(0, 2.2, -10), {
        amplitude: 6,
        speed: 1.1,
      }),
    );
    this.add(
      new TrainingTarget("vertical", new THREE.Vector3(-10, 3.2, 6), {
        amplitude: 1.9,
        speed: 1.6,
      }),
    );

    // ---- Medium range: Golden Lane (west, +1.5 m) + Lower Court (−1.5 m) ----
    this.add(
      new TrainingTarget("strafe", new THREE.Vector3(-40, 4.0, -26), {
        amplitude: 6,
        speed: 9,
      }),
    );
    this.add(
      new TrainingTarget("circular", new THREE.Vector3(0, 1.6, 42), {
        radius: 3,
        speed: 1.4,
      }),
    );

    // ---- Long range: East Ridge (+3 m) + Sun Gate approach ----
    this.add(
      new TrainingTarget("erratic", new THREE.Vector3(40, 6.0, -26), {
        speed: 6,
        zone: { x: 6, y: 2.0, z: 6 },
      }),
    );
    this.add(
      new TrainingTarget("horizontal", new THREE.Vector3(0, 5.8, -40), {
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