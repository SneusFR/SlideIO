import * as THREE from "three";
import { WeaponConfig as cfg } from "../weapons/WeaponConfig";

interface Particle {
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Single pooled particle system shared by all weapon / target effects.
 * A fixed-size ring buffer of points — nothing is allocated per frame.
 * Dead particles are rendered black (invisible with additive blending)
 * and parked far below the map.
 */
export class ParticleSystem {
  private readonly max = cfg.maxParticles;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly particles: Particle[] = [];
  private cursor = 0;

  private readonly geometry: THREE.BufferGeometry;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpT1 = new THREE.Vector3();
  private readonly tmpT2 = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.positions = new Float32Array(this.max * 3);
    this.colors = new Float32Array(this.max * 3);

    for (let i = 0; i < this.max; i++) {
      this.positions[i * 3 + 1] = -9999; // park below the world
      this.particles.push({
        life: 0,
        maxLife: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        drag: 0,
        r: 0,
        g: 0,
        b: 0,
      });
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.09,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(this.geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 6;
    scene.add(points);
  }

  /** Spawn a single particle (overwrites the oldest slot when full). */
  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    color: THREE.Color,
    gravity = 0,
    drag = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;

    const p = this.particles[i];
    p.life = life;
    p.maxLife = life;
    p.vx = vel.x;
    p.vy = vel.y;
    p.vz = vel.z;
    p.gravity = gravity;
    p.drag = drag;
    p.r = color.r;
    p.g = color.g;
    p.b = color.b;

    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
  }

  /** Radial burst (target explosions, overheat vents…). */
  burst(
    pos: THREE.Vector3,
    count: number,
    speed: number,
    life: number,
    color: THREE.Color,
    gravity = 0,
  ): void {
    for (let n = 0; n < count; n++) {
      this.tmpDir
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(speed * (0.35 + Math.random() * 0.65));
      this.spawn(pos, this.tmpDir, life * (0.5 + Math.random() * 0.5), color, gravity, 1.5);
    }
  }

  /**
   * Energetic ring burst in the plane perpendicular to `normal`
   * (phase dash portal effect on wall entry / exit faces).
   */
  ring(
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    count: number,
    radius: number,
    speed: number,
    life: number,
    color: THREE.Color,
  ): void {
    // Tangent basis of the wall plane.
    const t1 = this.tmpT1;
    const t2 = this.tmpT2;
    if (Math.abs(normal.y) < 0.9) {
      t1.set(0, 1, 0).cross(normal).normalize();
    } else {
      t1.set(1, 0, 0).cross(normal).normalize();
    }
    t2.crossVectors(normal, t1).normalize();

    for (let n = 0; n < count; n++) {
      const a = (n / count) * Math.PI * 2 + Math.random() * 0.3;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.tmpPos
        .copy(pos)
        .addScaledVector(t1, c * radius)
        .addScaledVector(t2, s * radius);
      // Expand outward in the wall plane with a slight push along the normal.
      this.tmpDir
        .set(0, 0, 0)
        .addScaledVector(t1, c)
        .addScaledVector(t2, s)
        .multiplyScalar(speed * (0.6 + Math.random() * 0.4))
        .addScaledVector(normal, speed * 0.25 * Math.random());
      this.spawn(this.tmpPos, this.tmpDir, life * (0.6 + Math.random() * 0.4), color, 0, 2.5);
    }
  }

  update(dt: number): void {
    const pos = this.positions;
    const col = this.colors;

    for (let i = 0; i < this.max; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;

      p.life -= dt;
      const j = i * 3;

      if (p.life <= 0) {
        pos[j + 1] = -9999;
        col[j] = 0;
        col[j + 1] = 0;
        col[j + 2] = 0;
        continue;
      }

      p.vy -= p.gravity * dt;
      if (p.drag > 0) {
        const d = Math.max(0, 1 - p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.vz *= d;
      }

      pos[j] += p.vx * dt;
      pos[j + 1] += p.vy * dt;
      pos[j + 2] += p.vz * dt;

      const fade = p.life / p.maxLife;
      col[j] = p.r * fade;
      col[j + 1] = p.g * fade;
      col[j + 2] = p.b * fade;
    }

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}