import * as THREE from "three";
import { WeaponConfig as cfg } from "./WeaponConfig";
import { HeatSystem } from "./HeatSystem";
import { PlasmaBeam } from "./PlasmaBeam";
import { ParticleSystem } from "../effects/ParticleSystem";
import { PlasmaImpact } from "../effects/PlasmaImpact";
import { Combatant } from "../combat/Combatant";
import { castBeam, BeamCastResult } from "./BeamCombat";

/**
 * First-person Plasma Rifle.
 *
 * Accuracy model (never affected by movement or view-model feedback):
 *   camera center → raycast → hit point
 * The visual beam starts at the muzzle but always converges to the
 * camera-raycast hit point, so what you see is exactly what you hit.
 */
export class PlasmaRifle {
  readonly heat = new HeatSystem();

  /** True while the beam is currently burning a target or a combatant. */
  hittingTarget = false;

  /** The combatant wielding this rifle (never damaged by its own beam). */
  owner: Combatant | null = null;

  private readonly camera: THREE.Camera;
  private readonly particles: ParticleSystem;
  private readonly beam: PlasmaBeam;
  private readonly impact: PlasmaImpact;

  // ---- View model ----
  private readonly viewmodel = new THREE.Group();
  private readonly basePosition = new THREE.Vector3(
    cfg.viewmodelOffset.x,
    cfg.viewmodelOffset.y,
    cfg.viewmodelOffset.z,
  );
  private muzzle!: THREE.Object3D;
  private muzzleLight!: THREE.PointLight;
  private muzzleRing!: THREE.Mesh;
  private coreMat!: THREE.MeshBasicMaterial;
  private coilMat!: THREE.MeshStandardMaterial;
  private accentMat!: THREE.MeshStandardMaterial;
  private kick = 0; // visual-only recoil slide

  // Heat-driven color shift (violet → hot)
  private readonly coolViolet = new THREE.Color(0xa855f7);
  private readonly hotOrange = new THREE.Color(0xff6b4a);
  private readonly tmpColor = new THREE.Color();

  // ---- Firing / raycast ----
  private readonly raycaster = new THREE.Raycaster();
  private readonly beamResult = new BeamCastResult();
  private static readonly SCREEN_CENTER = new THREE.Vector2(0, 0);
  private muzzleEmitAccum = 0;
  private beamEmitAccum = 0;
  private vaporAccum = 0;

  // Scratch vectors (no per-frame allocations)
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly beamEnd = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly sparkColor = new THREE.Color(0xc084fc);
  private readonly moteColor = new THREE.Color(0x9d5cff);
  private readonly ventColor = new THREE.Color(0xff8a5c);

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    particles: ParticleSystem,
  ) {
    this.camera = camera;
    this.particles = particles;
    this.beam = new PlasmaBeam(scene);
    this.impact = new PlasmaImpact(scene);

    this.buildViewmodel();
    this.viewmodel.position.copy(this.basePosition);
    camera.add(this.viewmodel);
  }

  // ------------------------------------------------------------------
  // Procedural sci-fi view model (all local coords; weapon faces -Z)
  // ------------------------------------------------------------------

  private buildViewmodel(): void {
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x252b38,
      metalness: 0.65,
      roughness: 0.4,
    });
    const midMat = new THREE.MeshStandardMaterial({
      color: 0x3a4254,
      metalness: 0.5,
      roughness: 0.5,
    });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: 0x120a24,
      emissive: 0x9333ea,
      emissiveIntensity: 1.1,
      metalness: 0.4,
      roughness: 0.4,
    });
    this.coilMat = new THREE.MeshStandardMaterial({
      color: 0x1a1030,
      emissive: 0x7c3aed,
      emissiveIntensity: 0.8,
      metalness: 0.4,
      roughness: 0.5,
    });
    this.coreMat = new THREE.MeshBasicMaterial({ color: this.coolViolet });

    const add = (mesh: THREE.Mesh, order: number): THREE.Mesh => {
      const mat = mesh.material as THREE.Material;
      mat.depthTest = false; // never clip into walls
      mesh.renderOrder = 100 + order;
      mesh.frustumCulled = false;
      this.viewmodel.add(mesh);
      return mesh;
    };

    // Receiver / body
    add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.44), darkMat), 0)
      .position.set(0, 0, -0.04);

    // Stock
    add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.085, 0.14), midMat), 1)
      .position.set(0, -0.005, 0.22);

    // Grip (angled)
    const grip = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.06), midMat), 2);
    grip.position.set(0, -0.11, 0.09);
    grip.rotation.x = 0.35;

    // Top rail
    add(new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.34), midMat), 3)
      .position.set(0, 0.075, -0.06);

    // Glowing side strips (heat feedback)
    const stripGeo = new THREE.BoxGeometry(0.008, 0.045, 0.3);
    add(new THREE.Mesh(stripGeo, this.accentMat), 4).position.set(0.05, 0.01, -0.05);
    add(new THREE.Mesh(stripGeo, this.accentMat), 5).position.set(-0.05, 0.01, -0.05);

    // Energy core (bright sphere on top of the receiver)
    add(new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), this.coreMat), 6)
      .position.set(0, 0.065, 0.06);

    // Barrel shroud
    add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.2), darkMat), 7)
      .position.set(0, 0.012, -0.3);

    // Barrel
    const barrel = add(
      new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.028, 0.36, 10), darkMat),
      8,
    );
    barrel.position.set(0, 0.012, -0.38);
    barrel.rotation.x = Math.PI / 2;

    // Plasma coils around the barrel (heat up while firing)
    const coilGeo = new THREE.TorusGeometry(0.042, 0.011, 8, 16);
    for (let i = 0; i < 3; i++) {
      const coil = add(new THREE.Mesh(coilGeo, this.coilMat), 9 + i);
      coil.position.set(0, 0.012, -0.3 - i * 0.07);
    }

    // Muzzle ring (spins while firing — animated part)
    this.muzzleRing = add(
      new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.009, 8, 16), this.accentMat),
      12,
    );
    this.muzzleRing.position.set(0, 0.012, -0.55);

    // Muzzle anchor (beam start / particle emitter) + firing light
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.012, -0.58);
    this.viewmodel.add(this.muzzle);

    this.muzzleLight = new THREE.PointLight(0xa855f7, 0, 4, 2);
    this.muzzle.add(this.muzzleLight);
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /**
   * @param wantFire   left mouse button held (and pointer locked)
   * @param hittables  static map meshes + target groups for the raycast
   * @param time       elapsed time in seconds (drives flicker/oscillation)
   */
  update(
    dt: number,
    wantFire: boolean,
    hittables: THREE.Object3D[],
    time: number,
  ): void {
    const firing = wantFire && this.heat.canFire;
    this.heat.update(dt, firing);
    this.hittingTarget = false;

    if (firing) {
      this.fireBeam(dt, hittables, time);
    } else {
      this.beam.setActive(false);
      this.impact.setActive(false);
      this.muzzleLight.intensity = 0;
    }

    if (this.heat.consumeOverheatEvent()) this.overheatBurst();

    this.updateViewmodelFeedback(dt, firing, time);
  }

  private fireBeam(dt: number, hittables: THREE.Object3D[], time: number): void {
    // Perfectly accurate: ray from the camera through the crosshair center.
    // Damage + occlusion go through the SAME shared castBeam as the bots.
    this.raycaster.setFromCamera(PlasmaRifle.SCREEN_CENTER, this.camera);
    castBeam(
      this.raycaster,
      this.raycaster.ray.origin,
      this.raycaster.ray.direction,
      cfg.beamRange,
      hittables,
      this.owner,
      this.beamResult,
    );

    const hit = this.beamResult.hit;
    this.beamEnd.copy(this.beamResult.point);
    this.hitNormal.copy(this.beamResult.normal);

    if (this.beamResult.combatant) {
      this.beamResult.combatant.health.applyDamage(
        cfg.plasmaDamagePerSecond * dt,
        this.owner,
      );
      this.hittingTarget = true;
    } else if (this.beamResult.trainingTarget) {
      this.beamResult.trainingTarget.applyDamage(cfg.plasmaDamagePerSecond * dt);
      this.hittingTarget = true;
    }

    // Beam: from the muzzle, converging to the camera-raycast hit point.
    this.muzzle.getWorldPosition(this.muzzleWorld);
    this.beam.setActive(true);
    this.beam.update(this.muzzleWorld, this.beamEnd, time);

    // Impact FX only when something was actually hit.
    if (hit) {
      this.impact.setActive(true);
      this.impact.update(dt, this.beamEnd, this.hitNormal, this.particles, time);
    } else {
      this.impact.setActive(false);
    }

    this.muzzleLight.intensity = 2.2 + Math.sin(time * 47) * 0.8;
    this.emitFiringParticles(dt);
  }

  private emitFiringParticles(dt: number): void {
    const beamDir = this.tmpVec
      .subVectors(this.beamEnd, this.muzzleWorld)
      .normalize();
    const beamLen = this.muzzleWorld.distanceTo(this.beamEnd);

    // Muzzle energy sparks.
    this.muzzleEmitAccum += cfg.particleRate * dt;
    while (this.muzzleEmitAccum >= 1) {
      this.muzzleEmitAccum -= 1;
      this.tmpVel
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(1.6)
        .addScaledVector(beamDir, 1.5 + Math.random());
      this.particles.spawn(
        this.muzzleWorld,
        this.tmpVel,
        0.15 + Math.random() * 0.15,
        this.sparkColor,
        0,
        3,
      );
    }

    // Energy motes traveling along the beam.
    this.beamEmitAccum += cfg.beamParticleRate * dt;
    while (this.beamEmitAccum >= 1) {
      this.beamEmitAccum -= 1;
      const along = Math.random() * beamLen;
      this.tmpPos.copy(this.muzzleWorld).addScaledVector(beamDir, along);
      this.tmpPos.x += (Math.random() - 0.5) * 0.12;
      this.tmpPos.y += (Math.random() - 0.5) * 0.12;
      this.tmpPos.z += (Math.random() - 0.5) * 0.12;
      this.tmpVel.copy(beamDir).multiplyScalar(20 + Math.random() * 8);
      this.particles.spawn(this.tmpPos, this.tmpVel, 0.25, this.moteColor, 0, 0);
    }
  }

  // ------------------------------------------------------------------
  // Visual feedback (never affects the raycast)
  // ------------------------------------------------------------------

  private updateViewmodelFeedback(dt: number, firing: boolean, time: number): void {
    const heatRatio = this.heat.ratio;

    // Small kickback while firing, smoothly recovers.
    const targetKick = firing ? cfg.fireKickback : 0;
    this.kick = THREE.MathUtils.damp(this.kick, targetKick, 14, dt);

    this.viewmodel.position.copy(this.basePosition);
    this.viewmodel.position.z += this.kick;

    if (firing) {
      // Vibration grows slightly with heat — purely cosmetic.
      const j = cfg.fireJitter * (1 + heatRatio);
      this.viewmodel.position.x += (Math.random() - 0.5) * j;
      this.viewmodel.position.y += (Math.random() - 0.5) * j;
      this.muzzleRing.rotation.z += dt * 14; // spinning muzzle ring
    } else {
      this.muzzleRing.rotation.z += dt * 1.5;
    }

    // Heat glow: violet → warm as the rifle heats up.
    this.tmpColor.lerpColors(this.coolViolet, this.hotOrange, heatRatio);
    this.coreMat.color.copy(this.tmpColor);
    this.coilMat.emissive.copy(this.tmpColor);
    this.coilMat.emissiveIntensity = 0.8 + heatRatio * 2.6;
    this.accentMat.emissiveIntensity = 1.1 + heatRatio * 1.6;

    if (this.heat.overheated) {
      // Angry pulsing while locked out.
      const pulse = 0.5 + 0.5 * Math.sin(time * 18);
      this.coilMat.emissiveIntensity = 2 + pulse * 2.5;
      this.coreMat.color.lerpColors(this.hotOrange, this.coolViolet, pulse * 0.4);
    }

    // Energy vapor when running hot.
    if (heatRatio > 0.7) {
      this.vaporAccum += (heatRatio - 0.6) * 22 * dt;
      while (this.vaporAccum >= 1) {
        this.vaporAccum -= 1;
        this.muzzle.getWorldPosition(this.muzzleWorld);
        this.tmpVel.set(
          (Math.random() - 0.5) * 0.4,
          0.7 + Math.random() * 0.5,
          (Math.random() - 0.5) * 0.4,
        );
        this.particles.spawn(
          this.muzzleWorld,
          this.tmpVel,
          0.4,
          this.ventColor,
          -1, // gentle rise
          1.5,
        );
      }
    }
  }

  /** Energy discharge when the rifle overheats. */
  private overheatBurst(): void {
    this.muzzle.getWorldPosition(this.muzzleWorld);
    this.particles.burst(this.muzzleWorld, 22, 4, 0.7, this.ventColor, 2);
    this.particles.burst(this.muzzleWorld, 10, 2, 0.5, this.sparkColor, 0);
  }
}