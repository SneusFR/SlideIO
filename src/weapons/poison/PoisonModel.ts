import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import poisonModelUrl from "../../assets/Lance_poison_jeu.glb?url";

/**
 * Shared, cached Lance-Poison GLB — same pipeline as the other weapons:
 * loaded exactly ONCE (module-level promise cache), consumers clone or
 * reuse the parsed scene.
 *
 * ASSET CONTRACT (src/assets/contrat_liquide.json):
 *   - root node `PoisonWeapon`; muzzle faces -X, up is +Y (glTF space);
 *   - `PoisonLiquid` + `PoisonMeniscus` carry 5 morph targets
 *     (Drain / TiltX / TiltZ / WaveSin / WaveCos);
 *   - every part exposes `userData.poisonRole`
 *     (body / controls / liquid / meniscus / glass / bubble);
 *   - bubbles carry `userData.{phase,sizeMeters,tankU,tankV}`;
 *   - zero animation clips — everything is driven by the game.
 *
 * Because the FPS convention is "muzzle faces -Z", the template wraps the
 * asset in a pivot rotated -PI/2 around Y. All tank math stays in the
 * PoisonWeapon LOCAL space (the pivot only reorients the whole asset).
 */

/** Tank interior dimensions (PoisonWeapon local space, meters). */
export interface PoisonTankDims {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  bottomY: number;
  topY: number;
  height: number;
}

/** Fallback dims — mirrors contrat_liquide.json / PoisonWeapon.userData.tank. */
export const POISON_TANK_FALLBACK: PoisonTankDims = {
  centerX: 0.03,
  centerZ: 0,
  halfX: 0.2502,
  halfZ: 0.0621,
  bottomY: 0.2784,
  topY: 0.5016,
  height: 0.2232,
};

export interface PoisonAsset {
  /** Pivot group: asset rotated so the muzzle faces -Z (FPS convention). */
  pivot: THREE.Group;
  /** The raw `PoisonWeapon` root (tank math happens in ITS local space). */
  weaponRoot: THREE.Object3D;
  /** Tank dims from userData (fallback to the shipped contract values). */
  tank: PoisonTankDims;
}

let assetPromise: Promise<PoisonAsset> | null = null;

/** Validate + read the tank dims from PoisonWeapon.userData (or fallback). */
function readTankDims(root: THREE.Object3D): PoisonTankDims {
  const raw = root.userData?.tank as Partial<PoisonTankDims> | undefined;
  const t = { ...POISON_TANK_FALLBACK, ...(raw ?? {}) };
  for (const key of Object.keys(t) as (keyof PoisonTankDims)[]) {
    if (!Number.isFinite(t[key])) {
      console.warn(`[Poison] tank.${key} invalid in GLB userData — using contract fallback`);
      return { ...POISON_TANK_FALLBACK };
    }
  }
  return t;
}

/**
 * Load + orient the Lance-Poison exactly once. The returned asset is the
 * SINGLE parsed instance: the local viewmodel owns it (only one poison
 * sprayer viewmodel ever exists; remote hands use the separate normalized
 * template of RemoteWeaponController).
 */
export function loadPoisonAsset(): Promise<PoisonAsset> {
  if (assetPromise) return assetPromise;
  assetPromise = new Promise((resolve, reject) => {
    new GLTFLoader().load(
      poisonModelUrl,
      (gltf) => {
        const weaponRoot = gltf.scene.getObjectByName("PoisonWeapon") ?? gltf.scene;
        if (weaponRoot === gltf.scene) {
          console.warn("[Poison] node 'PoisonWeapon' not found — using scene root");
        }
        // Muzzle faces -X in the asset → rotate -90° on Y so it faces -Z.
        const pivot = new THREE.Group();
        pivot.rotation.y = -Math.PI / 2;
        pivot.add(gltf.scene);
        resolve({ pivot, weaponRoot, tank: readTankDims(weaponRoot) });
      },
      undefined,
      reject,
    );
  });
  return assetPromise;
}
