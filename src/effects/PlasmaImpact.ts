import * as THREE from "three";
import { WeaponConfig as cfg } from "../weapons/WeaponConfig";
import { ParticleSystem } from "./ParticleSystem";
import { fxLights } from "./FXLightPool";

/**
 * Impact effect at the beam's hit point: a flickering flash sphere,
 * a pooled violet point light and a stream of sparks. All objects are
 * created once and repositioned every frame while the trigger is held.
 */
export class PlasmaImpact {
  readonly group = new THREE.Group();

  private readonly flash: THREE.Mesh;
  private emitAccum = 0;

  private readonly sparkColor = new THREE.Color(0xc084fc);
  private readonly lightColor = new THREE.Color(0xa855f7);
  private readonly tmpVel = new THREE.Vector3();
  private readonly lightPos = new THREE.Vector3();

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

    this.group.add(this.flash);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(active: boolean): void {
    this.group.visible = active;
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

    // Pooled light, slightly off the surface so it illuminates it
    // (immediate-mode request — re-issued every active frame).
    this.lightPos.copy(point).addScaledVector(normal, 0.38);
    fxLights.request(this.lightColor, 6 + Math.sin(time * 40) * 2, 9, 2, this.lightPos);

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