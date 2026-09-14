import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import hammerUrl from "../assets/voidhammer_opt.glb?url";
import spearUrl from "../assets/lance_opt.glb?url";
import rifleUrl from "../assets/voidrifle_opt.glb?url";
import obliterreurUrl from "../assets/obliterreur_opt.glb?url";
import revolverUrl from "../assets/revolver_opt.glb?url";
// Bass Blaster = PulseCarbine LOD1 (light version — plenty for a 384px icon).
import bassBlasterUrl from "../assets/PulseCarbine/PulseCarbine_LOD1.glb?url";
import poisonUrl from "../assets/Lance_poison_jeu.glb?url";
// Hex Sniper = the integration pack's canonical weapon GLB (no LOD exists
// for the new pack yet — a 384px icon renders it once, then disposes).
import hexSniperUrl from "../assets/potato/HexSniper_Weapon.glb?url";
// Goofy Basket = the ball LOD1 (light — plenty for a 384px icon).
import goofyBasketUrl from "../assets/goofybasket/GoofyBasket_LOD1.glb?url";
import { getGoofyBasketSkinLibrary } from "../weapons/goofybasket/GoofyBasketSkinRuntime";
import { DEFAULT_WEAPON_SKIN, isGoofyBasketSkinId, sanitizeWeaponSkin } from "../../shared/combat/WeaponSkins";

/**
 * Offscreen 3D icon factory for the Loadout menu.
 *
 * Each weapon's REAL in-game GLB is loaded once, framed in a tiny
 * offscreen scene (3/4 hero angle, transparent background) and
 * snapshotted into a PNG data-URL. Results are cached forever — the
 * WebGL context, geometries and materials are freed right after the
 * snapshot, so the menu only ever holds cheap <img> bitmaps.
 */

const MODEL_URLS: Record<string, string> = {
  HAMMER: hammerUrl,
  SPEAR: spearUrl,
  PLASMA_RIFLE: rifleUrl,
  OBLITERREUR: obliterreurUrl,
  REVOLVER: revolverUrl,
  BASS_BLASTER: bassBlasterUrl,
  POISON_SPRAYER: poisonUrl,
  HEX_SNIPER: hexSniperUrl,
  GOOFY_BASKET: goofyBasketUrl,
};

const ICON_SIZE = 384;
/** Extra empty space around the framed model (1 = tight fit). */
const FRAME_MARGIN = 1.12;

const iconCache = new Map<string, Promise<string | null>>();

/** True when a 3D icon exists for this loadout item id. */
export function hasWeaponIcon(id: string): boolean {
  return id in MODEL_URLS;
}

/**
 * PNG data-URL of the weapon's rendered 3D model (null on any failure).
 * Safe to call repeatedly: the render happens exactly once per
 * (weapon, skin) pair — the cache key includes the cosmetic skin id.
 */
export function getWeaponIconUrl(id: string, skinId: string = DEFAULT_WEAPON_SKIN): Promise<string | null> {
  const url = MODEL_URLS[id];
  if (!url) return Promise.resolve(null);
  const skin = sanitizeWeaponSkin(id, skinId);
  const key = `${id}|${skin}`;
  let cached = iconCache.get(key);
  if (!cached) {
    cached = renderIcon(url, id, skin).catch((err) => {
      console.warn(`[loadout] weapon icon failed for ${key}`, err);
      return null;
    });
    iconCache.set(key, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------
// Offscreen rendering
// ---------------------------------------------------------------------

interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
}

let ctx: RenderContext | null = null;
let pendingRenders = 0;

function getContext(): RenderContext {
  if (ctx) return ctx;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(ICON_SIZE, ICON_SIZE);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // Warm sun-lit setup so the models read "toy on a prairie", not "lab".
  scene.add(new THREE.AmbientLight(0xfff4dd, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2.2, 3.2, 3.6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe8ff, 0.9);
  fill.position.set(-3, 0.8, -2.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xd8ffb0, 0.7);
  rim.position.set(0, -2.5, 1.5);
  scene.add(rim);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  ctx = { renderer, scene, camera };
  return ctx;
}

/** Drop the WebGL context once every queued snapshot is done. */
function releaseContextIfIdle(): void {
  if (pendingRenders > 0 || !ctx) return;
  ctx.renderer.dispose();
  ctx = null;
}

async function renderIcon(url: string, weaponId: string, skinId: string): Promise<string | null> {
  pendingRenders++;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const { renderer, scene, camera } = getContext();

    // COSMETIC skin (GoofyBasket only): applied on THIS freshly loaded
    // instance with `context: "icon"` (materials only, no aura). The
    // handle is disposed BEFORE the deep dispose below so the library's
    // SHARED textures are restored out of the materials and never freed
    // by the generic cleanup (ownership rules: the library owns them).
    let skinHandle: { dispose(): void } | null = null;
    if (weaponId === "GOOFY_BASKET" && isGoofyBasketSkinId(skinId)) {
      const library = await getGoofyBasketSkinLibrary();
      if (library) {
        try {
          const handle = library.apply(gltf.scene, skinId, { context: "icon", quality: "low", seed: 3 });
          handle.update(0, { charge: 0, visible: true, effectsEnabled: false });
          skinHandle = handle;
        } catch (err) {
          console.warn(`[loadout] skin "${skinId}" failed on the icon — base model used`, err);
        }
      }
    }

    const staged = stageModel(gltf.scene);
    scene.add(staged);
    frameCamera(camera, staged);
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL("image/png");
    scene.remove(staged);
    skinHandle?.dispose(); // restore base materials first (shared textures safe)
    disposeDeep(staged);
    return dataUrl;
  } finally {
    pendingRenders--;
    releaseContextIfIdle();
  }
}

/**
 * Center the model, lay its longest axis horizontally (weapons read
 * best "pointing right") then tilt it into a slight 3/4 hero angle.
 */
function stageModel(model: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const size = box.getSize(new THREE.Vector3());

  const aligner = new THREE.Group();
  aligner.add(model);
  if (size.y >= size.x && size.y >= size.z) {
    aligner.rotation.z = -Math.PI / 2; // long axis Y → lay flat
  } else if (size.z > size.x) {
    aligner.rotation.y = Math.PI / 2; // long axis Z → point right
  }

  const hero = new THREE.Group();
  hero.add(aligner);
  hero.rotation.y = -0.5; // 3/4 turn toward the camera
  hero.rotation.x = 0.16; // slight top-down look
  return hero;
}

/** Square orthographic framing of the staged model with a margin. */
function frameCamera(camera: THREE.OrthographicCamera, staged: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(staged);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  staged.position.sub(center); // re-center after the hero tilt

  const half = (Math.max(size.x, size.y) / 2) * FRAME_MARGIN;
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;
  camera.near = 0.01;
  camera.far = size.z * 4 + 10;
  camera.position.set(0, 0, size.z * 2 + 1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

/** Free geometries/materials/textures of a snapshotted model. */
function disposeDeep(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const value of Object.values(mat)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      mat.dispose();
    }
  });
}