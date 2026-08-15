import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PickupConfig as pc } from "./PickupConfig";
import medkitUrl from "../assets/medkit_opt.glb?url";
import coinUrl from "../assets/coin_opt.glb?url";

/**
 * GLB templates for the loot pickups.
 *
 * Each model is fetched + parsed EXACTLY ONCE (same pipeline as the
 * weapon viewmodels: optimized *_opt.glb + GLTFLoader). Every drop in
 * the world is a cheap `clone()` of the prepared template — geometry
 * and materials are shared between all instances, nothing is ever
 * re-downloaded or re-parsed on a kill.
 */
export class PickupAssets {
  medkitTemplate: THREE.Group | null = null;
  coinTemplate: THREE.Group | null = null;

  private started = false;

  /** Kick the one-time loads (call once at game startup). */
  load(): void {
    if (this.started) return;
    this.started = true;
    const loader = new GLTFLoader();
    loader.load(
      medkitUrl,
      (gltf) => {
        this.medkitTemplate = normalizeTemplate(
          gltf.scene,
          pc.medkitSize,
          pc.medkitGlowColor,
        );
      },
      undefined,
      (err) => console.warn("[pickups] medkit GLB failed to load", err),
    );
    loader.load(
      coinUrl,
      (gltf) => {
        this.coinTemplate = normalizeTemplate(
          gltf.scene,
          pc.coinSize,
          pc.coinGlowColor,
        );
      },
      undefined,
      (err) => console.warn("[pickups] coin GLB failed to load", err),
    );
  }
}

/**
 * Scale the raw model to the target gameplay size and center it at the
 * origin so pickups can position/rotate it trivially. Done once per GLB.
 * Also makes the pickup GLOW: the GLB materials become self-lit (their
 * own texture re-used as an emissive map) and an additive halo sprite is
 * baked into the template so every clone reads from across the map.
 */
function normalizeTemplate(
  model: THREE.Group,
  targetSize: number,
  glowColor: number,
): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  model.scale.setScalar(targetSize / maxDim);

  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Shared materials: mark them so per-bot dispose logic elsewhere
      // never destroys them by accident.
      const mat = mesh.material as THREE.Material;
      if (mat) {
        mat.userData.shared = true;
        // Self-illumination: reuse the albedo texture as an emissive map
        // so the pickup glows with its own colors even in shadow.
        if (mat instanceof THREE.MeshStandardMaterial) {
          if (mat.map) mat.emissiveMap = mat.map;
          mat.emissive.setHex(0xffffff);
          mat.emissiveIntensity = pc.glowEmissiveIntensity;
          mat.needsUpdate = true;
        }
      }
    }
  });

  const wrapper = new THREE.Group();
  wrapper.add(model);
  wrapper.add(makeHaloSprite(targetSize, glowColor));
  return wrapper;
}

/**
 * Soft additive radial-gradient billboard — a cheap "bloom" halo around
 * the pickup. The texture and material are created once per template and
 * shared by every clone (Sprite.clone() shares its material).
 */
function makeHaloSprite(targetSize: number, glowColor: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getHaloTexture(),
    color: glowColor,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: pc.glowHaloOpacity,
    depthWrite: false,
  });
  mat.userData.shared = true;
  const sprite = new THREE.Sprite(mat);
  const d = targetSize * pc.glowHaloScale;
  sprite.scale.set(d, d, 1);
  return sprite;
}

let haloTexture: THREE.Texture | null = null;

/** Lazily build the shared radial gradient texture (64px canvas). */
function getHaloTexture(): THREE.Texture {
  if (haloTexture) return haloTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(0.7, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(canvas);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}