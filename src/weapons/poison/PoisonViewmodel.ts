import * as THREE from "three";
import { PoisonConfig as cfg } from "./PoisonConfig";
import { loadPoisonAsset } from "./PoisonModel";
import { PoisonLiquidController } from "./PoisonLiquidController";
import { fxLights } from "../../effects/FXLightPool";

/**
 * First-person Lance-Poison viewmodel. PURELY visual: spray kick/jitter,
 * green glow lights, and the LIVING LIQUID TANK (morph-target driven by
 * PoisonLiquidController) never touch the real aim.
 *
 * Render layering (same anti-clipping pattern as every other viewmodel:
 * depthTest OFF + transparent pass + high renderOrder):
 *   100 body → 101 bubbles → 102 liquid → 103 meniscus → 104 glass
 * The liquid draws BEFORE the glass among transparents, and neither
 * writes depth (the glass must composite over the liquid behind it).
 */
export class PoisonViewmodel {
  /** Resolves once the GLB is parsed and attached (or failed). */
  readonly ready: Promise<void>;

  readonly group = new THREE.Group();
  /** Non-null once the GLB loaded — drives the tank every frame. */
  liquid: PoisonLiquidController | null = null;

  private readonly basePosition = new THREE.Vector3(
    cfg.viewmodelOffset.x,
    cfg.viewmodelOffset.y,
    cfg.viewmodelOffset.z,
  );
  private readonly muzzle = new THREE.Object3D();
  /** Pooled light state (physical lights: FXLightPool). */
  private readonly lightColor = new THREE.Color(cfg.poisonColor);
  private readonly tankLightWorld = new THREE.Vector3();
  /** Liquid/meniscus/bubble emissive materials (glow follows the charge). */
  private readonly glowMats: { mat: THREE.MeshStandardMaterial; base: number }[] = [];

  private kick = 0;
  private readonly muzzleWorldScratch = new THREE.Vector3();

  constructor(camera: THREE.Camera) {
    this.group.position.copy(this.basePosition);
    this.group.visible = false;
    camera.add(this.group);

    // Muzzle anchor: front tip (viewmodel faces -Z after the model pivot).
    this.muzzle.position.set(0, 0.03, -(cfg.viewmodelLength * 0.62));
    this.group.add(this.muzzle);

    // Green glow lights are POOLED (see FXLightPool): requested at the
    // muzzle / tank world positions every frame the weapon is visible.

    this.ready = this.loadModel();
  }

  private async loadModel(): Promise<void> {
    try {
      const asset = await loadPoisonAsset();

      // Uniform scale: total length (along Z after the -X → -Z pivot)
      // matches the configured viewmodel length.
      const box = new THREE.Box3().setFromObject(asset.pivot);
      const size = box.getSize(new THREE.Vector3());
      const scale = cfg.viewmodelLength / Math.max(size.z, 1e-6);
      asset.pivot.scale.setScalar(scale);

      // Recenter: grip zone near the group origin, muzzle toward -Z.
      box.setFromObject(asset.pivot);
      const center = box.getCenter(new THREE.Vector3());
      asset.pivot.position.x -= center.x;
      asset.pivot.position.y -= center.y;
      asset.pivot.position.z += -cfg.viewmodelLength * 0.1 - box.min.z;

      this.prepareMaterials(asset.weaponRoot);
      this.liquid = new PoisonLiquidController(asset.weaponRoot, asset.tank);
      this.group.add(asset.pivot);
    } catch (err) {
      console.error("[Poison] viewmodel GLB failed to load", err);
    }
  }

  /**
   * Viewmodel render prep, role-aware:
   *   - every mesh: depthTest off, transparent pass, no frustum culling
   *     (the standard "never clip into walls" viewmodel recipe);
   *   - liquid < glass render order so the glass composites OVER it;
   *   - liquid + glass keep depthWrite OFF (true transparents), the
   *     opaque-ish body/bubbles/meniscus rely on render order only;
   *   - poison emissives boosted for the glowing-green look.
   */
  private prepareMaterials(root: THREE.Object3D): void {
    const orderOf = (role: string | undefined): number => {
      switch (role) {
        case "bubble":
          return 101;
        case "liquid":
          return 102;
        case "meniscus":
          return 103;
        case "glass":
          return 104;
        default:
          return 100; // body & everything untagged
      }
    };

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Role can live on the mesh itself or on its named parent group.
      const role =
        (mesh.userData?.poisonRole as string | undefined) ??
        (mesh.parent?.userData?.poisonRole as string | undefined);
      mesh.renderOrder = orderOf(role);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        mat.depthTest = false; // never clip into walls
        mat.transparent = true; // draw AFTER world transparents
        if (role === "liquid" || role === "glass") mat.depthWrite = false;
        if (mat instanceof THREE.MeshStandardMaterial && mat.emissive.getHex() !== 0) {
          if (role === "liquid" || role === "meniscus" || role === "bubble") {
            mat.emissiveIntensity *= cfg.liquidEmissiveBoost;
          }
          this.glowMats.push({ mat, base: mat.emissiveIntensity });
        }
      }
    });
  }

  setHidden(hidden: boolean): void {
    this.group.visible = !hidden;
  }

  getMuzzleWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out ?? this.muzzleWorldScratch);
  }

  /**
   * Per-frame visual update.
   * @param dt        frame delta (s)
   * @param spraying  true while poison is actually being emitted
   * @param velocity  player world velocity (feeds the liquid inertia)
   * @param fill      0..1 tank fill fraction (charge / capacity)
   * @param time      elapsed seconds (glow pulse)
   */
  update(
    dt: number,
    spraying: boolean,
    velocity: THREE.Vector3,
    fill: number,
    time: number,
  ): void {
    // Kickback + jitter while spraying (visual only, smoothly recovers).
    const targetKick = spraying ? cfg.sprayKickback : 0;
    this.kick = THREE.MathUtils.damp(this.kick, targetKick, 14, dt);
    this.group.position.copy(this.basePosition);
    this.group.position.z += this.kick;
    if (spraying) {
      this.group.position.x += (Math.random() - 0.5) * cfg.sprayJitter;
      this.group.position.y += (Math.random() - 0.5) * cfg.sprayJitter;
    }

    // Green glow (pooled lights): tank pulse follows the charge; spray
    // light while firing — both requested at their WORLD positions.
    const visible = this.group.visible;
    const pulse = 0.85 + 0.15 * Math.sin(time * 5.2);
    if (visible) {
      const tankIntensity = cfg.tankLightIntensity * fill * pulse;
      if (tankIntensity > 0) {
        this.group.getWorldPosition(this.tankLightWorld);
        this.tankLightWorld.y += 0.12;
        fxLights.request(this.lightColor, tankIntensity, 2.2, 2, this.tankLightWorld);
      }
      if (spraying) {
        this.muzzle.getWorldPosition(this.muzzleWorldScratch);
        fxLights.request(
          this.lightColor,
          cfg.sprayLightIntensity * (0.85 + Math.random() * 0.3),
          5,
          2,
          this.muzzleWorldScratch,
        );
      }
    }
    for (const g of this.glowMats) {
      g.mat.emissiveIntensity = g.base * (0.35 + 0.65 * Math.max(fill, 0.15)) * pulse;
    }

    // The living tank: fill level + inertial surface + bubbles.
    this.liquid?.update(dt, velocity, fill);
  }

  /** Equip / respawn / teleport: clear the liquid motion memory. */
  resetMotion(): void {
    this.liquid?.resetMotionState();
  }
}
