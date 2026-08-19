import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HammerConfig as hc } from "./HammerConfig";
import hammerModelUrl from "../assets/voidhammer_opt.glb?url";

type VmMode = "HIDDEN" | "SWING" | "SLAM_RAISE" | "SLAM_DIVE" | "SLAM_IMPACT";

const lerp = THREE.MathUtils.lerp;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * Sci-fi combat hammer view model (GLB asset).
 * Purely visual: attached to the camera, animates the wind-up / sweep /
 * dive / impact poses. Damage is handled by HammerWeapon — the poses here
 * are tuned so the hitbox timing matches what the player sees.
 *
 * Local hammer space: handle along +Y (grip at the origin, head on top).
 * Camera space: x right, y up, -z forward.
 */
export class HammerViewmodel {
  /** Resolves once the GLB is parsed and attached (or failed) — used by
   *  the Game's GPU warm-up so the first swing never compiles shaders. */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;

  private readonly root = new THREE.Group();
  private readonly hammer = new THREE.Group();
  /** Emissive materials from the GLB, pulsed for a bit of life. */
  private readonly pulseMats: { mat: THREE.MeshStandardMaterial; base: number }[] = [];

  private mode: VmMode = "HIDDEN";
  private clock = 0;
  /** +1: the head starts RIGHT and sweeps to the LEFT. -1: mirrored. */
  private swingDir = 1;
  private readonly diveFrom = new THREE.Vector3();
  private readonly diveFromRot = new THREE.Euler();

  // Rest pose (hammer held low, slightly right — used as anim anchor)
  private static readonly REST_POS = new THREE.Vector3(0.3, -0.45, -0.62);
  private static readonly REST_ROT = new THREE.Euler(-0.2, 0.15, 0);

  // Dimensions of the previous procedural hammer — the GLB is normalized to
  // occupy exactly the same space so all pose tuning stays valid.
  /** Total height (bottom of the pommel → top of the head). */
  private static readonly TARGET_HEIGHT = 1.2;
  /** Bottom of the old hammer in local space (pommel tip). */
  private static readonly BOTTOM_Y = -0.13;

  constructor(camera: THREE.Camera) {
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.loadModel();
    this.root.add(this.hammer);
    camera.add(this.root);
    this.root.visible = false;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  // ------------------------------------------------------------------
  // GLB model loading (normalized to the old procedural hammer's size)
  // ------------------------------------------------------------------

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      hammerModelUrl,
      (gltf) => {
      const model = gltf.scene;

      // Uniform scale so the model's height matches the old hammer exactly.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = HammerViewmodel.TARGET_HEIGHT / Math.max(size.y, 1e-6);
      model.scale.setScalar(scale);

      // Recenter: grip axis on x/z origin, pommel at the old bottom height
      // (handle along +Y, head on top — same local space as before).
      box.setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y += HammerViewmodel.BOTTOM_Y - box.min.y;

      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.renderOrder = 150; // above the rifle (100..112)
        obj.frustumCulled = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          mat.depthTest = false; // view model never clips into walls
          mat.transparent = true; // draw AFTER world transparents (dome…)
          if (mat instanceof THREE.MeshStandardMaterial && mat.emissive.getHex() !== 0) {
            this.pulseMats.push({ mat, base: mat.emissiveIntensity });
          }
        }
      });

      this.hammer.add(model);
      this.readyResolve();
      },
      undefined,
      () => this.readyResolve(), // failed load must never hang the warm-up
    );
  }

  // ------------------------------------------------------------------
  // Animation triggers (called by HammerWeapon)
  // ------------------------------------------------------------------

  startSwing(dir: number): void {
    this.mode = "SWING";
    this.swingDir = dir >= 0 ? 1 : -1;
    this.clock = 0;
    this.root.visible = true;
  }

  /** Slam start: raise the hammer overhead, then dive automatically. */
  startSlam(): void {
    this.mode = "SLAM_RAISE";
    this.clock = 0;
    this.root.visible = true;
  }

  /** Landing: play the impact + short recovery, then hide. */
  startSlamImpact(): void {
    this.diveFrom.copy(this.root.position);
    this.diveFromRot.copy(this.root.rotation);
    this.mode = "SLAM_IMPACT";
    this.clock = 0;
  }

  hide(): void {
    this.mode = "HIDDEN";
    this.root.visible = false;
  }

  update(dt: number): void {
    if (this.mode === "HIDDEN") return;
    this.clock += dt;

    switch (this.mode) {
      case "SWING":
        this.poseSwing();
        break;
      case "SLAM_RAISE":
        this.poseSlamRaise();
        break;
      case "SLAM_DIVE":
        this.poseSlamDive();
        break;
      case "SLAM_IMPACT":
        this.poseSlamImpact();
        break;
    }

    // Energy pulse (subtle life on the glowing parts).
    const pulse = 0.85 + 0.15 * Math.sin(this.clock * 14);
    for (const { mat, base } of this.pulseMats) mat.emissiveIntensity = base * pulse;
  }

  // ------------------------------------------------------------------
  // Poses
  // ------------------------------------------------------------------

  /**
   * Horizontal sweep. dir = +1: wind-up on the RIGHT, head crosses the
   * screen and finishes LEFT. dir = -1 mirrors everything — the alternation
   * is fully visible, not just an internal variable.
   */
  private poseSwing(): void {
    const d = this.swingDir;
    const T = hc.hammerSwingDuration;
    const t = Math.min(this.clock / T, 1);
    const w = hc.hammerHitStart / T; // wind-up ends when the hit window opens
    const e = Math.min(0.85, (hc.hammerHitEnd + 0.06) / T); // sweep end (follow-through)

    const p = this.root.position;
    const r = this.root.rotation;

    if (t < w) {
      // Wind-up: pull the hammer to the starting side, head cocked back.
      const k = easeOutCubic(t / w);
      p.set(
        lerp(HammerViewmodel.REST_POS.x * d, 0.62 * d, k),
        lerp(HammerViewmodel.REST_POS.y, -0.14, k),
        lerp(HammerViewmodel.REST_POS.z, -0.5, k),
      );
      r.set(
        lerp(HammerViewmodel.REST_ROT.x, -0.55, k),
        lerp(0.15 * d, 0.55 * d, k),
        lerp(0, -1.0 * d, k),
      );
    } else if (t < e) {
      // Swing: the head really crosses the screen, pushing forward mid-arc.
      const k = easeOutCubic((t - w) / (e - w));
      const arc = Math.sin(k * Math.PI);
      p.set(lerp(0.62 * d, -0.62 * d, k), -0.14 - arc * 0.22, -0.5 - arc * 0.45);
      r.set(
        lerp(-0.55, -0.15, k),
        lerp(0.55 * d, -0.55 * d, k),
        lerp(-1.0 * d, 1.15 * d, k),
      );
    } else {
      // Follow-through + recovery: settle back toward the rest pose.
      const k = easeInOut((t - e) / (1 - e));
      p.set(
        lerp(-0.62 * d, HammerViewmodel.REST_POS.x * d, k),
        lerp(-0.36, HammerViewmodel.REST_POS.y, k),
        lerp(-0.5, HammerViewmodel.REST_POS.z, k),
      );
      r.set(
        lerp(-0.15, HammerViewmodel.REST_ROT.x, k),
        lerp(-0.55 * d, 0.15 * d, k),
        lerp(1.15 * d, 0, k),
      );
    }

    if (t >= 1) this.hide();
  }

  /** Raise overhead (short): head up high above the view, then dive. */
  private poseSlamRaise(): void {
    const dur = Math.max(0.08, hc.groundSlamWindup);
    const k = easeOutCubic(Math.min(this.clock / dur, 1));

    this.root.position.set(
      lerp(HammerViewmodel.REST_POS.x, 0.22, k),
      lerp(HammerViewmodel.REST_POS.y, 0.28, k),
      lerp(HammerViewmodel.REST_POS.z, -0.48, k),
    );
    this.root.rotation.set(
      lerp(HammerViewmodel.REST_ROT.x, 0.5, k), // handle up, head cocked slightly back
      lerp(HammerViewmodel.REST_ROT.y, 0, k),
      lerp(0, 0.08, k),
    );

    if (this.clock >= dur) {
      this.mode = "SLAM_DIVE";
      this.clock = 0;
    }
  }

  /**
   * Dive: the hammer whips OVER THE TOP — the head flips past vertical and
   * ends pointing straight DOWN at the ground in front of the player
   * (handle up, head low). Clearly a vertical smash, never a sideways pose.
   */
  private poseSlamDive(): void {
    const k = easeOutCubic(Math.min(this.clock / 0.12, 1));
    const vib = Math.min(this.clock * 4, 1) * 0.01;

    this.root.position.set(
      lerp(0.22, 0.2, k) + Math.sin(this.clock * 47) * vib,
      lerp(0.28, 0.42, k) + Math.cos(this.clock * 53) * vib, // root high: the down-pointing head stays in view
      lerp(-0.48, -0.55, k),
    );
    this.root.rotation.set(
      lerp(0.5, -2.65, k), // full overhead flip: head ends aimed at the ground
      0,
      0.08,
    );
  }

  /** Impact: the head drives fully into the ground, then eases back up. */
  private poseSlamImpact(): void {
    const T = Math.max(0.2, hc.groundSlamRecovery);
    const t = Math.min(this.clock / T, 1);

    const p = this.root.position;
    const r = this.root.rotation;

    if (t < 0.25) {
      const k = easeOutCubic(t / 0.25);
      p.set(
        lerp(this.diveFrom.x, 0.16, k),
        lerp(this.diveFrom.y, 0.02, k), // root drops → head plunges below the view
        lerp(this.diveFrom.z, -0.6, k),
      );
      r.set(lerp(this.diveFromRot.x, -2.95, k), 0, lerp(this.diveFromRot.z, 0.06, k));
    } else {
      const k = easeInOut((t - 0.25) / 0.75);
      p.set(
        lerp(0.16, HammerViewmodel.REST_POS.x, k),
        lerp(0.02, HammerViewmodel.REST_POS.y, k),
        lerp(-0.6, HammerViewmodel.REST_POS.z, k),
      );
      r.set(lerp(-2.95, HammerViewmodel.REST_ROT.x, k), lerp(0, 0.15, k), lerp(0.06, 0, k));
    }

    if (t >= 1) this.hide();
  }
}