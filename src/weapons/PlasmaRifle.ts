import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WeaponConfig as cfg } from "./WeaponConfig";
import rifleModelUrl from "../assets/voidrifle_opt.glb?url";
import { HeatSystem } from "./HeatSystem";
import { PlasmaBeam } from "./PlasmaBeam";
import { ParticleSystem } from "../effects/ParticleSystem";
import { PlasmaImpact } from "../effects/PlasmaImpact";
import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { HitZone } from "../combat/HitZone";
import { HitFeedbackManager } from "../combat/HitFeedbackManager";
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

  /** Resolves once the GLB is parsed and attached (or failed) — used by
   *  the Game's GPU warm-up so entering the map never compiles shaders. */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;

  /** True while the beam is currently burning a target or a combatant. */
  hittingTarget = false;

  /** True while the beam is actually emitting (trigger held + not overheated). */
  isFiring = false;

  /** True while the beam is burning ANY surface (wall, floor, target…). */
  beamHit = false;

  /** Fired once on the frame the rifle overheats (audio hook). */
  onOverheat: (() => void) | null = null;

  /** The combatant wielding this rifle (never damaged by its own beam). */
  owner: Combatant | null = null;

  /** Hit-confirmation feedback sink (only the local player's rifle has one). */
  feedback: HitFeedbackManager | null = null;

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
  private accentMat!: THREE.MeshStandardMaterial;
  /** Emissive materials from the GLB — tinted/boosted with heat. */
  private readonly glowMats: { mat: THREE.MeshStandardMaterial; base: number }[] = [];
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
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.beam = new PlasmaBeam(scene);
    this.impact = new PlasmaImpact(scene);

    this.buildViewmodel();
    this.viewmodel.position.copy(this.basePosition);
    camera.add(this.viewmodel);
  }

  /**
   * Hide/show the rifle view model while the hammer is out.
   * Purely visual — heat, overheat cooldown and firing logic keep
   * evolving normally in the background (nothing is reset).
   */
  setViewmodelHidden(hidden: boolean): void {
    this.viewmodel.visible = !hidden;
  }

  // ------------------------------------------------------------------
  // GLB view model (all local coords; weapon faces -Z)
  // ------------------------------------------------------------------

  // Dimensions of the previous procedural rifle — the GLB is normalized to
  // occupy the same space so all offsets/FX anchors stay valid.
  /** Total length (stock rear z=+0.29 → muzzle tip z=-0.56). */
  private static readonly TARGET_LENGTH = 0.85;
  /** Front tip (muzzle end) of the old rifle in local space. */
  private static readonly FRONT_Z = -0.56;
  /** Vertical center of the old rifle body. */
  private static readonly CENTER_Y = -0.04;

  private buildViewmodel(): void {
    this.accentMat = new THREE.MeshStandardMaterial({
      color: 0x120a24,
      emissive: 0x9333ea,
      emissiveIntensity: 1.1,
      metalness: 0.4,
      roughness: 0.4,
    });
    this.accentMat.depthTest = false;
    // Transparent pass: the viewmodel doesn't write depth (depthTest off),
    // so transparent world effects (force-field dome…) drawn later would
    // composite OVER the gun. In the transparent pass its high renderOrder
    // guarantees it draws after them instead.
    this.accentMat.transparent = true;

    // Muzzle ring (spins while firing — animated part)
    this.muzzleRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.036, 0.009, 8, 16),
      this.accentMat,
    );
    this.muzzleRing.renderOrder = 112; // above the GLB body
    this.muzzleRing.frustumCulled = false;
    this.muzzleRing.position.set(0, 0.012, -0.55);
    this.viewmodel.add(this.muzzleRing);

    // Muzzle anchor (beam start / particle emitter) + firing light
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.012, -0.58);
    this.viewmodel.add(this.muzzle);

    // The light attaches to the CAMERA (never the hidden/shown viewmodel):
    // toggling a light's effective visibility changes the scene light
    // count and forces three.js to recompile every lit material — that
    // was the freeze on the first melee swing (rifle viewmodel hidden).
    this.muzzleLight = new THREE.PointLight(0xa855f7, 0, 4, 2);
    this.muzzleLight.position
      .copy(this.basePosition)
      .add(this.muzzle.position);
    this.camera.add(this.muzzleLight);

    this.loadModel();
  }

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      rifleModelUrl,
      (gltf) => {
      const model = gltf.scene;

      // Source model lies along the X axis. Find the muzzle end (thinner
      // cross-section) and rotate so the barrel faces -Z like the old rifle.
      const box = new THREE.Box3().setFromObject(model);
      const muzzleSign = PlasmaRifle.findMuzzleSign(model, box);
      model.rotation.y = muzzleSign > 0 ? Math.PI / 2 : -Math.PI / 2;

      // Uniform scale so its length matches the old procedural rifle.
      box.setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = PlasmaRifle.TARGET_LENGTH / Math.max(size.z, 1e-6);
      model.scale.setScalar(scale);

      // Recenter: muzzle tip at FRONT_Z, centered on x, body around CENTER_Y.
      box.setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.y += PlasmaRifle.CENTER_Y - center.y;
      model.position.z += PlasmaRifle.FRONT_Z - box.min.z;

      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.renderOrder = 100; // view-model layer (hammer is 150+)
        obj.frustumCulled = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          mat.depthTest = false; // never clip into walls
          mat.transparent = true; // draw AFTER world transparents (dome…)
          if (mat instanceof THREE.MeshStandardMaterial && mat.emissive.getHex() !== 0) {
            this.glowMats.push({ mat, base: mat.emissiveIntensity });
          }
        }
      });

      this.viewmodel.add(model);
      this.readyResolve();
      },
      undefined,
      () => this.readyResolve(), // failed load must never hang the warm-up
    );
  }

  /**
   * Heuristic: the muzzle end of a rifle has a thinner cross-section than
   * the stock/grip end. Returns +1 if the muzzle is on the +X side, else -1.
   */
  private static findMuzzleSign(model: THREE.Object3D, box: THREE.Box3): number {
    const centerX = (box.min.x + box.max.x) / 2;
    const half = Math.max((box.max.x - box.min.x) / 2, 1e-6);
    const pos = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const neg = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const v = new THREE.Vector3();

    model.updateMatrixWorld(true);
    model.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const attr = (obj.geometry as THREE.BufferGeometry).getAttribute("position");
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr as THREE.BufferAttribute, i).applyMatrix4(obj.matrixWorld);
        const t = (v.x - centerX) / half; // -1 .. 1 along the length
        const side = t > 0.55 ? pos : t < -0.55 ? neg : null;
        if (!side) continue;
        side.minY = Math.min(side.minY, v.y);
        side.maxY = Math.max(side.maxY, v.y);
        side.minZ = Math.min(side.minZ, v.z);
        side.maxZ = Math.max(side.maxZ, v.z);
      }
    });

    const posArea = (pos.maxY - pos.minY) * (pos.maxZ - pos.minZ);
    const negArea = (neg.maxY - neg.minY) * (neg.maxZ - neg.minZ);
    return posArea <= negArea ? 1 : -1;
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
    this.isFiring = firing;
    if (!firing) this.beamHit = false;

    if (firing) {
      this.fireBeam(dt, hittables, time);
    } else {
      this.beam.setActive(false);
      this.impact.setActive(false);
      this.muzzleLight.intensity = 0;
    }

    if (this.heat.consumeOverheatEvent()) {
      this.overheatBurst();
      this.onOverheat?.();
    }

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
    this.beamHit = hit;
    this.beamEnd.copy(this.beamResult.point);
    this.hitNormal.copy(this.beamResult.normal);

    if (this.beamResult.combatant) {
      const combatant = this.beamResult.combatant;
      const zone = this.beamResult.hitZone;
      // Headshot multiplier is re-evaluated EVERY frame from the actual
      // struck mesh — sliding the beam off the head instantly drops it.
      const mult =
        zone === HitZone.HEAD && cfg.supportsHeadshots ? cfg.headshotMultiplier : 1;
      const damage = cfg.plasmaDamagePerSecond * mult * dt;
      const applied = combatant.health.applyDamage(damage, this.owner, KillMethod.PLASMA, zone);
      if (applied) {
        // Only APPLIED damage produces feedback (dead/protected → nothing).
        this.feedback?.registerHit({
          attacker: this.owner,
          target: combatant,
          hitZone: zone,
          damage,
          position: this.beamResult.point,
          weapon: KillMethod.PLASMA,
          isKill: !combatant.health.alive,
        });
      }
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
    this.accentMat.emissive.copy(this.tmpColor);
    this.accentMat.emissiveIntensity = 1.1 + heatRatio * 1.6;
    for (const g of this.glowMats) {
      g.mat.emissive.copy(this.tmpColor);
      g.mat.emissiveIntensity = g.base + heatRatio * 2.6;
    }

    if (this.heat.overheated) {
      // Angry pulsing while locked out.
      const pulse = 0.5 + 0.5 * Math.sin(time * 18);
      this.accentMat.emissiveIntensity = 2 + pulse * 2.5;
      for (const g of this.glowMats) g.mat.emissiveIntensity = 2 + pulse * 2.5;
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