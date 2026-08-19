import * as THREE from "three";
import { WeaponConfig as cfg } from "../weapons/WeaponConfig";
import { ParticleSystem } from "./ParticleSystem";

/**
 * Impact effect at the beam's hit point: a flickering flash sphere,
 * a violet point light and a stream of sparks. All objects are created
 * once and repositioned every frame while the trigger is held.
 */
export class PlasmaImpact {
  readonly group = new THREE.Group();

  private readonly flash: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private emitAccum = 0;

  private readonly sparkColor = new THREE.Color(0xc084fc);
  private readonly tmpVel = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xd8b4fe,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.flash.renderOrder = 5;

    // The light lives DIRECTLY in the scene, permanently visible
    // (intensity 0 while inactive): hiding/revealing a light changes the
    // scene light count and forces three.js to recompile every lit
    // material — a visible freeze on the FIRST beam impact.
    this.light = new THREE.PointLight(0xa855f7, 0, 9, 2);
    scene.add(this.light);

    this.group.add(this.flash);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(active: boolean): void {
    this.group.visible = active;
    if (!active) this.light.intensity = 0;
  }

  update(
    dt: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    particles: ParticleSystem,
    time: number,
  ): void {
    this.group.position.copy(point).addScaledVector(normal, 0.03);

    // Pulsating flash.
    const s = 0.1 * (1 + 0.35 * Math.sin(time * 55) + 0.15 * Math.sin(time * 91));
    this.flash.scale.setScalar(Math.max(s, 0.02));

    // Light sits slightly off the surface so it illuminates it
    // (world-space — the light is scene-level, not part of the group).
    this.light.position.copy(point).addScaledVector(normal, 0.38);
    this.light.intensity = 6 + Math.sin(time * 40) * 2;

    // Sparks flying off the surface.
    this.emitAccum += cfg.impactParticleRate * dt;
    while (this.emitAccum >= 1) {
      this.emitAccum -= 1;
      this.tmpVel
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(2.4)
        .addScaledVector(normal, 1 + Math.random() * 2.5);
      particles.spawn(point, this.tmpVel, 0.3 + Math.random() * 0.2, this.sparkColor, 5, 2);
    }
  }
}