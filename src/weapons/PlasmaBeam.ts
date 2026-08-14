import * as THREE from "three";
import { WeaponConfig as cfg } from "./WeaponConfig";

/**
 * Continuous plasma beam visual: a bright core cylinder plus a wider,
 * transparent halo. Both are stretched between the weapon muzzle and the
 * camera-raycast hit point every frame — the geometry is never recreated.
 */
export class PlasmaBeam {
  readonly group = new THREE.Group();

  private readonly core: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly haloMat: THREE.MeshBasicMaterial;

  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private readonly dir = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    // Unit cylinder (radius 1, height 1, Y axis) — scaled each frame.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

    const coreMat = new THREE.MeshBasicMaterial({
      color: cfg.beamCoreColor,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(geo, coreMat);
    this.core.frustumCulled = false;
    this.core.renderOrder = 5;

    this.haloMat = new THREE.MeshBasicMaterial({
      color: cfg.beamHaloColor,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.halo = new THREE.Mesh(geo, this.haloMat);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 4;

    this.group.add(this.halo, this.core);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(active: boolean): void {
    this.group.visible = active;
  }

  /** Stretch the beam from `start` (muzzle) to `end` (raycast hit point). */
  update(start: THREE.Vector3, end: THREE.Vector3, time: number): void {
    this.dir.subVectors(end, start);
    const len = Math.max(this.dir.length(), 0.05);
    this.dir.normalize();

    this.mid.addVectors(start, end).multiplyScalar(0.5);
    this.quat.setFromUnitVectors(PlasmaBeam.UP, this.dir);

    // Unstable-energy flicker: two overlapping sine waves on the radius.
    const flick =
      1 +
      0.22 * Math.sin(time * cfg.beamFlickerSpeed) +
      0.12 * Math.sin(time * cfg.beamFlickerSpeed * 2.7 + 1.3);

    const coreR = cfg.beamCoreRadius * flick;
    this.core.position.copy(this.mid);
    this.core.quaternion.copy(this.quat);
    this.core.scale.set(coreR, len, coreR);

    const haloR = cfg.beamHaloRadius * (1 + 0.15 * Math.sin(time * 23 + 0.7));
    this.halo.position.copy(this.mid);
    this.halo.quaternion.copy(this.quat);
    this.halo.scale.set(haloR, len, haloR);
    this.haloMat.opacity = 0.3 + 0.1 * Math.sin(time * 31);
  }
}