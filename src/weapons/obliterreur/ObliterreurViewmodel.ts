import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ObliterreurConfig as oc } from "./ObliterreurConfig";
import obliterreurModelUrl from "../../assets/obliterreur_opt.glb?url";

/**
 * First-person view model of the OBLITERREUR.
 *
 * The GLB is loaded ONCE, normalized (long axis rotated onto -Z, scaled to
 * a fixed length, recentred) and anchored bottom-right of the camera — the
 * same pipeline as the Plasma Rifle / Astral Lance view models.
 *
 * Animation modes (purely cosmetic — never affects gameplay):
 *  IDLE       slow bob + gentle glow pulse
 *  PLACE      short back-kick + roll + glow spike (anchor placed)
 *  FIRE_START heavier kick + rise (beam fired)
 *  FIRE_LOOP  vibration jitter + strong glow while the vortex is open
 *  FIRE_END   settle back to idle
 */
type VmMode = "idle" | "place" | "fireStart" | "fireLoop" | "fireEnd";

export class ObliterreurViewmodel {
  private readonly root = new THREE.Group();
  private readonly basePosition = new THREE.Vector3(
    oc.viewmodelOffset.x,
    oc.viewmodelOffset.y,
    oc.viewmodelOffset.z,
  );
  /** Slight inward yaw so the weapon points toward the crosshair. */
  private static readonly BASE_YAW = -0.08;
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  private readonly glowMats: { mat: THREE.MeshStandardMaterial; base: number }[] = [];

  private mode: VmMode = "idle";
  private modeTimer = 0;
  private bobTime = 0;
  private hidden = false;

  constructor(camera: THREE.Camera) {
    this.root.position.copy(this.basePosition);
    this.root.rotation.y = ObliterreurViewmodel.BASE_YAW;
    camera.add(this.root);
    this.loadModel();
  }

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(obliterreurModelUrl, (gltf) => {
      const model = gltf.scene;

      // Rotate the longest bbox axis onto Z so the weapon faces -Z.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      if (size.x >= size.y && size.x >= size.z) {
        model.rotation.y = ObliterreurViewmodel.findFrontSign(model, box, "x") > 0
          ? Math.PI / 2
          : -Math.PI / 2;
      } else if (size.y >= size.x && size.y >= size.z) {
        model.rotation.x = Math.PI / 2;
      }
      // (already along Z → keep as-is; thin-end heuristic below still applies)

      // This asset is held handle-first by default — flip 180° around the
      // vertical axis so the handle sits in the hand and the front of the
      // weapon faces -Z (down the crosshair).
      model.rotateOnWorldAxis(ObliterreurViewmodel.UP, Math.PI);

      // Uniform scale to the target view-model length.
      box.setFromObject(model);
      box.getSize(size);
      const scale = oc.viewmodelLength / Math.max(size.z, 1e-6);
      model.scale.setScalar(scale);

      // Recenter: front tip at -length/2 … grip near 0, centered on x/y.
      box.setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.y -= center.y;
      model.position.z += -oc.viewmodelLength * 0.62 - box.min.z;

      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.renderOrder = 120; // view-model layer
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

      this.root.add(model);
      this.root.visible = !this.hidden;
    });
  }

  /**
   * Thin-cross-section heuristic along `axis`: the muzzle end of a weapon
   * is thinner than the grip end. Returns +1 if the muzzle is on the
   * positive side (compact version of PlasmaRifle.findMuzzleSign).
   */
  private static findFrontSign(
    model: THREE.Object3D,
    box: THREE.Box3,
    axis: "x",
  ): number {
    const min = box.min[axis];
    const max = box.max[axis];
    const centerA = (min + max) / 2;
    const half = Math.max((max - min) / 2, 1e-6);
    const pos = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const neg = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const v = new THREE.Vector3();

    model.updateMatrixWorld(true);
    model.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const attr = (obj.geometry as THREE.BufferGeometry).getAttribute("position");
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr as THREE.BufferAttribute, i).applyMatrix4(obj.matrixWorld);
        const t = (v[axis] - centerA) / half;
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
  // Mode triggers
  // ------------------------------------------------------------------

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.root.visible = !hidden;
  }

  /** Anchor point placed — quick back-kick + glow spike. */
  playPlace(): void {
    if (this.mode === "fireLoop" || this.mode === "fireStart") return;
    this.mode = "place";
    this.modeTimer = 0;
  }

  /** Beam fired — heavy kick then sustained vibration. */
  startFire(): void {
    this.mode = "fireStart";
    this.modeTimer = 0;
  }

  /** Beam over — settle back to idle. */
  endFire(): void {
    if (this.mode !== "fireStart" && this.mode !== "fireLoop") return;
    this.mode = "fireEnd";
    this.modeTimer = 0;
  }

  // ------------------------------------------------------------------
  // Per-frame animation
  // ------------------------------------------------------------------

  update(dt: number): void {
    this.bobTime += dt;
    this.modeTimer += dt;

    const p = this.root.position;
    p.copy(this.basePosition);
    this.root.rotation.set(0, ObliterreurViewmodel.BASE_YAW, 0);

    // Idle bob (always present, damped during actions).
    const bobY = Math.sin(this.bobTime * 1.7) * 0.008;
    const bobX = Math.sin(this.bobTime * 1.1) * 0.004;
    let glow = 1 + Math.sin(this.bobTime * 2.3) * 0.25; // slow pulse

    if (this.mode === "place") {
      const d = 0.3;
      const k = Math.min(1, this.modeTimer / d);
      const kick = Math.sin(k * Math.PI) * (1 - k * 0.4); // out-and-back, ease-out
      p.z += kick * 0.09;
      p.y -= kick * 0.02;
      this.root.rotation.z += kick * 0.1; // small roll
      glow += kick * 2.2; // glow spike
      if (k >= 1) this.mode = "idle";
    } else if (this.mode === "fireStart") {
      const d = 0.35;
      const k = Math.min(1, this.modeTimer / d);
      const kick = Math.sin(k * Math.PI);
      p.z += kick * 0.16;
      p.y += kick * 0.05; // rise
      this.root.rotation.x += kick * 0.12;
      glow += k * 2.5;
      if (k >= 1) {
        this.mode = "fireLoop";
        this.modeTimer = 0;
      }
    } else if (this.mode === "fireLoop") {
      // Straining against the open vortex: jitter + strong glow.
      p.x += (Math.random() - 0.5) * 0.006;
      p.y += (Math.random() - 0.5) * 0.006;
      p.z += 0.03 + Math.sin(this.bobTime * 21) * 0.004;
      glow = 3 + Math.sin(this.bobTime * 13) * 0.8;
    } else if (this.mode === "fireEnd") {
      const d = 0.3;
      const k = Math.min(1, this.modeTimer / d);
      const settle = 1 - k;
      p.z += settle * 0.03;
      glow = 1 + settle * 2;
      if (k >= 1) this.mode = "idle";
    }

    p.y += bobY;
    p.x += bobX;

    for (const g of this.glowMats) {
      g.mat.emissiveIntensity = g.base * glow;
    }
  }
}