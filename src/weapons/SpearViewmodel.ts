import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SpearConfig as sc } from "./SpearConfig";
import spearModelUrl from "../assets/lance_opt.glb?url";

type VmMode = "HIDDEN" | "SWEEP" | "RUSH_ALIGN" | "RUSH_LOOP" | "RUSH_END";

const lerp = THREE.MathUtils.lerp;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * Astral Lance view model (GLB asset, loaded ONCE and reused — the same
 * optimize→cache→reuse pipeline as the other weapon models).
 * Purely visual: attached to the camera, it animates the sweep / rush poses.
 * Damage is handled by SpearWeapon — the poses are tuned so the hitbox
 * timing matches what the player sees.
 *
 * Local spear space: shaft along +Y (butt at the bottom, TIP at the top).
 * Camera space: x right, y up, -z forward.
 * Pointing the tip forward = rotation.x ≈ -PI/2.
 */
export class SpearViewmodel {
  /** Resolves once the GLB is parsed and attached (or failed) — used by
   *  the Game's GPU warm-up so the first sweep never compiles shaders. */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;

  private readonly root = new THREE.Group();
  private readonly spear = new THREE.Group();
  /** Emissive materials from the GLB, pulsed for a bit of life. */
  private readonly pulseMats: { mat: THREE.MeshStandardMaterial; base: number }[] = [];

  private mode: VmMode = "HIDDEN";
  private clock = 0;
  /** Extra emissive boost while rushing (energy along the shaft). */
  private rushGlow = 0;

  // Rest anchor (spear held low on the right, tip up-forward).
  private static readonly REST_POS = new THREE.Vector3(0.34, -0.5, -0.7);
  private static readonly REST_ROT = new THREE.Euler(-0.35, -0.12, 0.1);

  /** Normalized total length of the spear in local space. */
  private static readonly TARGET_LENGTH = 2.2;
  /** Bottom of the shaft in local space (grip below the origin). */
  private static readonly BOTTOM_Y = -0.75;

  constructor(camera: THREE.Camera) {
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.loadModel();
    this.root.add(this.spear);
    camera.add(this.root);
    this.root.visible = false;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  // ------------------------------------------------------------------
  // GLB model loading (normalized: shaft along +Y, tip on top)
  // ------------------------------------------------------------------

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      spearModelUrl,
      (gltf) => {
      const model = gltf.scene;

      // Detect the shaft axis (longest dimension) and rotate it onto +Y.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      if (size.x >= size.y && size.x >= size.z) {
        model.rotation.z = -Math.PI / 2; // +X → +Y
      } else if (size.z >= size.y && size.z >= size.x) {
        model.rotation.x = -Math.PI / 2; // +Z → +Y... (tip assumed at +Z)
      }
      model.updateMatrixWorld(true);

      // Uniform scale so the spear length matches the normalized target.
      box.setFromObject(model);
      box.getSize(size);
      const scale = SpearViewmodel.TARGET_LENGTH / Math.max(size.y, 1e-6);
      model.scale.multiplyScalar(scale);

      // Recenter: shaft on the x/z origin, butt at BOTTOM_Y (tip on top).
      box.setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y += SpearViewmodel.BOTTOM_Y - box.min.y;

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

      this.spear.add(model);
      this.readyResolve();
      },
      undefined,
      () => this.readyResolve(), // failed load must never hang the warm-up
    );
  }

  // ------------------------------------------------------------------
  // Animation triggers (called by SpearWeapon)
  // ------------------------------------------------------------------

  /** Big horizontal sweep from the RIGHT to the LEFT. */
  startSweep(): void {
    this.mode = "SWEEP";
    this.clock = 0;
    this.rushGlow = 0;
    this.root.visible = true;
  }

  /** SPEAR_RUSH_POSE: snap the lance straight, tip forward, then hold. */
  startRush(): void {
    this.mode = "RUSH_ALIGN";
    this.clock = 0;
    this.rushGlow = 1;
    this.root.visible = true;
  }

  /** Rush over (hit / wall / timeout): short settle, then hide. */
  endRush(): void {
    if (this.mode !== "RUSH_ALIGN" && this.mode !== "RUSH_LOOP") return;
    this.mode = "RUSH_END";
    this.clock = 0;
  }

  hide(): void {
    this.mode = "HIDDEN";
    this.rushGlow = 0;
    this.root.visible = false;
  }

  update(dt: number): void {
    if (this.mode === "HIDDEN") return;
    this.clock += dt;

    switch (this.mode) {
      case "SWEEP":
        this.poseSweep();
        break;
      case "RUSH_ALIGN":
        this.poseRushAlign();
        break;
      case "RUSH_LOOP":
        this.poseRushLoop();
        break;
      case "RUSH_END":
        this.poseRushEnd();
        break;
    }

    // Energy pulse (stronger while rushing — the tip is the dangerous part).
    const pulse = 0.85 + 0.15 * Math.sin(this.clock * 14) + this.rushGlow * 0.9;
    for (const { mat, base } of this.pulseMats) mat.emissiveIntensity = base * pulse;
  }

  // ------------------------------------------------------------------
  // Poses
  // ------------------------------------------------------------------

  /**
   * Sweep: very short wind-up on the RIGHT, then the whole lance crosses
   * the screen horizontally to the LEFT (tip forward, shaft flat), with a
   * push forward mid-arc so the reach reads clearly. Follow-through +
   * recovery settle back to the rest anchor, then hide.
   */
  private poseSweep(): void {
    const T = sc.spearSweepDuration;
    const t = Math.min(this.clock / T, 1);
    const w = sc.spearSweepHitStart / T; // wind-up ends when the hit window opens
    const e = Math.min(0.85, (sc.spearSweepHitEnd + 0.06) / T); // sweep end

    const p = this.root.position;
    const r = this.root.rotation;

    if (t < w) {
      // Wind-up: pull the lance to the right, tip cocked forward-right.
      const k = easeOutCubic(t / w);
      p.set(
        lerp(SpearViewmodel.REST_POS.x, 0.6, k),
        lerp(SpearViewmodel.REST_POS.y, -0.3, k),
        lerp(SpearViewmodel.REST_POS.z, -0.6, k),
      );
      r.set(
        lerp(SpearViewmodel.REST_ROT.x, -1.25, k), // shaft lays toward forward
        lerp(SpearViewmodel.REST_ROT.y, -0.95, k), // tip aimed to the RIGHT
        lerp(SpearViewmodel.REST_ROT.z, -0.25, k),
      );
    } else if (t < e) {
      // Sweep: the tip really crosses the space in front of the player,
      // right → LEFT, pushing forward mid-arc (feel the length + weight).
      const k = easeOutCubic((t - w) / (e - w));
      const arc = Math.sin(k * Math.PI);
      p.set(lerp(0.6, -0.7, k), -0.3 - arc * 0.1, -0.6 - arc * 0.5);
      r.set(
        -1.25 - arc * 0.15,
        lerp(-0.95, 1.15, k), // yaw: tip travels right → left
        lerp(-0.25, 0.3, k),
      );
    } else {
      // Follow-through + recovery: settle back toward the rest anchor.
      const k = easeInOut((t - e) / (1 - e));
      p.set(
        lerp(-0.7, SpearViewmodel.REST_POS.x, k),
        lerp(-0.3, SpearViewmodel.REST_POS.y, k),
        lerp(-0.6, SpearViewmodel.REST_POS.z, k),
      );
      r.set(
        lerp(-1.25, SpearViewmodel.REST_ROT.x, k),
        lerp(1.15, SpearViewmodel.REST_ROT.y, k),
        lerp(0.3, SpearViewmodel.REST_ROT.z, k),
      );
    }

    if (t >= 1) this.hide();
  }

  /** Very fast alignment: the lance snaps straight, tip dead ahead. */
  private poseRushAlign(): void {
    const k = easeOutCubic(Math.min(this.clock / 0.12, 1));

    this.root.position.set(
      lerp(SpearViewmodel.REST_POS.x, 0.26, k),
      lerp(SpearViewmodel.REST_POS.y, -0.32, k),
      lerp(SpearViewmodel.REST_POS.z, -0.85, k),
    );
    this.root.rotation.set(
      lerp(SpearViewmodel.REST_ROT.x, -Math.PI / 2 + 0.06, k), // tip forward
      lerp(SpearViewmodel.REST_ROT.y, 0.04, k),
      lerp(SpearViewmodel.REST_ROT.z, 0.18, k),
    );

    if (this.clock >= 0.12) {
      this.mode = "RUSH_LOOP";
      this.clock = 0;
    }
  }

  /** Held rush pose: straight, tip forward, subtle speed vibration. */
  private poseRushLoop(): void {
    const vib = 0.008;
    this.root.position.set(
      0.26 + Math.sin(this.clock * 43) * vib,
      -0.32 + Math.cos(this.clock * 51) * vib,
      -0.85,
    );
    this.root.rotation.set(
      -Math.PI / 2 + 0.06 + Math.sin(this.clock * 31) * 0.004,
      0.04,
      0.18,
    );
  }

  /** Short settle after the rush, then hide. */
  private poseRushEnd(): void {
    const T = 0.25;
    const t = Math.min(this.clock / T, 1);
    const k = easeInOut(t);
    this.rushGlow = 1 - k;

    this.root.position.set(
      lerp(0.26, SpearViewmodel.REST_POS.x, k),
      lerp(-0.32, SpearViewmodel.REST_POS.y, k),
      lerp(-0.85, SpearViewmodel.REST_POS.z, k),
    );
    this.root.rotation.set(
      lerp(-Math.PI / 2 + 0.06, SpearViewmodel.REST_ROT.x, k),
      lerp(0.04, SpearViewmodel.REST_ROT.y, k),
      lerp(0.18, SpearViewmodel.REST_ROT.z, k),
    );

    if (t >= 1) this.hide();
  }
}