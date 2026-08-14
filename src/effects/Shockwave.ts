import * as THREE from "three";

interface WaveSlot {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  radius: number;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Pooled expanding ground rings (ground-slam shockwave, big impacts).
 * A small fixed pool of flat ring meshes: nothing is allocated at runtime.
 * The final visual radius matches the gameplay radius passed to spawn().
 */
export class Shockwave {
  private readonly pool: WaveSlot[] = [];

  constructor(scene: THREE.Scene, poolSize = 4) {
    const geo = new THREE.RingGeometry(0.82, 1, 48);
    for (let i = 0; i < poolSize; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xc084fc,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the ground
      mesh.visible = false;
      mesh.renderOrder = 7;
      scene.add(mesh);
      this.pool.push({ mesh, material, life: 0, maxLife: 1, radius: 1 });
    }
  }

  /** Spawn an expanding ring reaching `radius` over `duration` seconds. */
  spawn(center: THREE.Vector3, radius: number, duration: number, color: THREE.Color): void {
    // Reuse the most-finished slot.
    let slot = this.pool[0];
    for (const s of this.pool) {
      if (s.life <= 0) {
        slot = s;
        break;
      }
      if (s.life < slot.life) slot = s;
    }

    slot.life = duration;
    slot.maxLife = duration;
    slot.radius = radius;
    slot.material.color.copy(color);
    slot.mesh.position.set(center.x, center.y + 0.07, center.z);
    slot.mesh.scale.setScalar(0.01);
    slot.mesh.visible = true;
  }

  update(dt: number): void {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        s.material.opacity = 0;
        continue;
      }
      const t = 1 - s.life / s.maxLife;
      const scale = Math.max(0.01, s.radius * easeOutCubic(t));
      s.mesh.scale.setScalar(scale);
      s.material.opacity = Math.pow(1 - t, 1.4) * 0.9;
    }
  }
}