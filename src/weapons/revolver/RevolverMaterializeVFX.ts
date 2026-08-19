import * as THREE from "three";
import { ParticleSystem } from "../../effects/ParticleSystem";

/**
 * Holographic materialization of a fresh revolver in the hand:
 *   wireframe silhouette → vertical purple scanline → mesh fills in →
 *   small flash → fully solid.
 * Operates on the viewmodel instance only (its materials are per-instance
 * clones, so the shared template / thrown clones are never affected).
 */
export class RevolverMaterializeVFX {
  /** True while the animation is running (weapon LOCKED meanwhile). */
  active = false;

  private duration = 0.4;
  private t = 0;

  /** Per-instance body materials of the viewmodel clone. */
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  /** Wireframe hologram overlays (share the SAME geometry — zero copies). */
  private readonly wireMat: THREE.MeshBasicMaterial;
  private readonly wires: THREE.Mesh[] = [];
  private readonly scanPlane: THREE.Mesh;
  private readonly scanMat: THREE.MeshBasicMaterial;
  private readonly glow: THREE.PointLight;
  private readonly bounds = new THREE.Box3();
  private minY = -0.1;
  private maxY = 0.1;

  private readonly particles: ParticleSystem;
  private readonly root: THREE.Object3D;
  private readonly sparkColor = new THREE.Color(0xc084fc);
  private readonly worldPos = new THREE.Vector3();
  private sparkAccum = 0;

  constructor(root: THREE.Object3D, particles: ParticleSystem, lightParent?: THREE.Object3D) {
    this.root = root;
    this.particles = particles;

    this.wireMat = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      wireframe: true,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.revolverWire) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m instanceof THREE.MeshStandardMaterial) this.mats.push(m);
      }
      // Hologram overlay: same geometry, wireframe material.
      const wire = new THREE.Mesh(obj.geometry, this.wireMat);
      wire.userData.revolverWire = true;
      wire.renderOrder = 106;
      wire.frustumCulled = false;
      wire.visible = false;
      obj.add(wire);
      this.wires.push(wire);
    });

    this.bounds.setFromObject(root);
    this.minY = this.bounds.min.y - root.getWorldPosition(this.worldPos).y;
    this.maxY = this.bounds.max.y - this.worldPos.y;

    // Vertical scanline sweeping through the weapon.
    this.scanMat = new THREE.MeshBasicMaterial({
      color: 0xd8b4fe,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.012), this.scanMat);
    this.scanPlane.renderOrder = 107;
    this.scanPlane.frustumCulled = false;
    this.scanPlane.visible = false;
    root.add(this.scanPlane);

    // The glow light attaches to a PERMANENTLY visible parent (the camera)
    // when provided: a light inside the hidden/shown viewmodel group would
    // change the scene light count on weapon swaps, forcing three.js to
    // recompile every lit material (a visible one-time freeze).
    this.glow = new THREE.PointLight(0xa855f7, 0, 1.6, 2);
    if (lightParent) {
      root.getWorldPosition(this.worldPos);
      lightParent.add(this.glow);
      this.glow.position.copy(lightParent.worldToLocal(this.worldPos.clone()));
    } else {
      root.add(this.glow);
    }
  }

  /** Begin the hologram: the mesh starts fully immaterial. */
  start(duration: number): void {
    this.active = true;
    this.duration = Math.max(duration, 0.05);
    this.t = 0;
    for (const m of this.mats) {
      m.transparent = true;
      m.opacity = 0;
    }
    for (const w of this.wires) w.visible = true;
    this.scanPlane.visible = true;
  }

  /** Force-complete (death / loadout swap): weapon instantly solid. */
  finish(): void {
    this.active = false;
    for (const m of this.mats) {
      m.opacity = 1;
      m.transparent = false;
    }
    for (const w of this.wires) w.visible = false;
    this.wireMat.opacity = 0;
    this.scanPlane.visible = false;
    this.scanMat.opacity = 0;
    this.glow.intensity = 0;
  }

  update(dt: number): void {
    if (!this.active) {
      // Post-flash glow decay only.
      if (this.glow.intensity > 0) {
        this.glow.intensity = Math.max(0, this.glow.intensity - dt * 14);
      }
      return;
    }

    this.t += dt;
    const p = Math.min(this.t / this.duration, 1);

    // Wireframe silhouette: strong early, fades as the metal fills in.
    this.wireMat.opacity = p < 0.55 ? 0.9 : 0.9 * (1 - (p - 0.55) / 0.45);

    // Body fills in from ~25% onward (scanline "prints" the metal).
    const fill = THREE.MathUtils.clamp((p - 0.25) / 0.7, 0, 1);
    for (const m of this.mats) m.opacity = fill;

    // Vertical scan sweep (bottom → top), brightest mid-animation.
    this.scanPlane.position.y = THREE.MathUtils.lerp(this.minY, this.maxY, p);
    this.scanMat.opacity = 0.85 * Math.sin(Math.PI * p);

    // Purple energy glow + assembling sparks.
    this.glow.intensity = 1.2 * Math.sin(Math.PI * p);
    this.sparkAccum += 42 * dt;
    while (this.sparkAccum >= 1) {
      this.sparkAccum -= 1;
      this.root.getWorldPosition(this.worldPos);
      this.particles.burst(this.worldPos, 1, 0.7, 0.18, this.sparkColor, 0);
    }

    if (p >= 1) {
      // Final flash: the metal snaps solid.
      this.finish();
      this.glow.intensity = 2.4;
    }
  }
}