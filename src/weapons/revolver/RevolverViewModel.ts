import * as THREE from "three";
import { RevolverConfig as cfg } from "./RevolverConfig";
import { loadRevolverTemplate, cloneRevolver } from "./RevolverModel";
import { RevolverMaterializeVFX } from "./RevolverMaterializeVFX";
import { ParticleSystem } from "../../effects/ParticleSystem";

/**
 * First-person revolver viewmodel. PURELY visual: recoil kick, wrist
 * rotation, muzzle flash and the holographic materialization NEVER touch
 * the real camera-center raycast.
 *
 * The model comes from the shared cached template (loaded once); this
 * instance clones its materials so the hologram animation can fade them
 * without ever affecting the template or the thrown-revolver clones.
 */
export class RevolverViewmodel {
  readonly group = new THREE.Group();

  private readonly basePosition = new THREE.Vector3(
    cfg.revolverViewmodelOffset.x,
    cfg.revolverViewmodelOffset.y,
    cfg.revolverViewmodelOffset.z,
  );
  private readonly muzzle = new THREE.Object3D();
  private readonly muzzleLight: THREE.PointLight;
  private readonly particles: ParticleSystem;

  private materializeVfx: RevolverMaterializeVFX | null = null;
  /** Materialize request that arrived before the async GLB finished. */
  private pendingMaterialize = -1;

  // Visual recoil state (kick back + wrist pitch), damped every frame.
  private kick = 0;
  private wrist = 0;
  private flashTimer = 0;
  private readonly flashColor = new THREE.Color(0xffe3b8); // hot white-warm
  private readonly sparkViolet = new THREE.Color(0xc084fc);
  private readonly muzzleWorld = new THREE.Vector3();

  constructor(camera: THREE.Camera, particles: ParticleSystem) {
    this.particles = particles;
    this.group.position.copy(this.basePosition);
    camera.add(this.group);

    // Muzzle anchor: front tip of the (normalized, length = 1 → scaled) model.
    this.muzzle.position.set(0, 0.03, -(cfg.revolverViewmodelLength * 0.5 + 0.03));
    this.group.add(this.muzzle);

    // Warm ballistic muzzle flash light (violet hinted by sparks, not light).
    this.muzzleLight = new THREE.PointLight(0xffd9a0, 0, 3.5, 2);
    this.muzzle.add(this.muzzleLight);

    // Shared template → per-viewmodel clone with per-instance materials.
    void loadRevolverTemplate().then((template) => {
      const model = cloneRevolver(template);
      model.scale.setScalar(cfg.revolverViewmodelLength);
      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.renderOrder = 100; // viewmodel layer
        obj.frustumCulled = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        obj.material = mats.length === 1 ? mats[0].clone() : mats.map((m) => m.clone());
        const cloned = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of cloned) m.depthTest = false; // never clip into walls
      });
      this.group.add(model);
      this.materializeVfx = new RevolverMaterializeVFX(model, this.particles);
      if (this.pendingMaterialize >= 0) {
        this.materializeVfx.start(this.pendingMaterialize);
        this.pendingMaterialize = -1;
      }
    });
  }

  setHidden(hidden: boolean): void {
    this.group.visible = !hidden;
  }

  /** Visual-only recoil: viewmodel kick + wrist snap (+ muzzle flash). */
  triggerShot(fanFire: boolean): void {
    this.kick += fanFire ? cfg.revolverFanFireVisualRecoil : cfg.revolverVisualRecoil;
    this.wrist += fanFire ? 0.14 : 0.22;
    this.flashTimer = 0.05;
    this.muzzleLight.intensity = 7;
    // Short hot flash + a couple of violet sparks (sci-fi accent).
    this.muzzle.getWorldPosition(this.muzzleWorld);
    this.particles.burst(this.muzzleWorld, 6, 2.5, 0.1, this.flashColor, 0);
    this.particles.burst(this.muzzleWorld, 3, 1.5, 0.12, this.sparkViolet, 0);
  }

  /** The old revolver just left the hand → hologram a fresh one in. */
  startMaterialize(duration: number): void {
    if (this.materializeVfx) this.materializeVfx.start(duration);
    else this.pendingMaterialize = duration;
  }

  /** Instant, silent completion (death / loadout swap). */
  forceReady(): void {
    this.pendingMaterialize = -1;
    this.materializeVfx?.finish();
  }

  getMuzzleWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  update(dt: number, time: number): void {
    // Recoil recovery (fast damp → "BANG, snap back").
    this.kick = THREE.MathUtils.damp(this.kick, 0, 16, dt);
    this.wrist = THREE.MathUtils.damp(this.wrist, 0, 14, dt);

    this.group.position.copy(this.basePosition);
    this.group.position.z += this.kick;
    // Idle life: tiny bob + sway so the weapon never feels frozen.
    this.group.position.y += Math.sin(time * 1.7) * 0.004;
    this.group.rotation.x = this.wrist; // wrist snaps up on fire
    this.group.rotation.z = Math.sin(time * 1.3) * 0.006;

    // Muzzle flash decay.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleLight.intensity = 0;
    } else if (this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
    }

    this.materializeVfx?.update(dt);
  }
}