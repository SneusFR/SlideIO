import * as THREE from 'three';
import { createBasketSkinFX } from './BasketSkinFX.js';
import { attachBasketLavaSurface, type BasketLavaSurface } from './BasketLavaSurface.js';

export type BasketSkinId = 'mandarine' | 'street_pop' | 'haute_tension' | 'eclipse_solaire';
export type BasketSkinContext = 'fp' | 'tp' | 'projectile' | 'icon';
export type BasketSkinQuality = 'low' | 'high';
export const BASKET_SKINS = Object.freeze([
  { id: 'mandarine', name: 'Mandarine', rarity: 'Peu commun', accent: '#ff973a' },
  { id: 'street_pop', name: 'Street Pop', rarity: 'Rare', accent: '#68bad7' },
  { id: 'haute_tension', name: 'Haute Tension', rarity: 'Epic', accent: '#a87bfa' },
  { id: 'eclipse_solaire', name: 'Éclipse solaire', rarity: 'Légendaire', accent: '#ffc052' },
] as const);

const MATERIALS = new Set(['Skin_Panels_A', 'Skin_Panels_B', 'Skin_Channels']);
const DEFAULT_URLS = {
  streetColor: new URL('../assets/textures/StreetPop_BaseColor.png', import.meta.url).href,
  electricColor: new URL('../assets/textures/HauteTension_BaseColor.png', import.meta.url).href,
  electricEmission: new URL('../assets/textures/HauteTension_Emissive.png', import.meta.url).href,
  solarColor: new URL('../assets/textures/EclipseSolaire_BaseColor.png', import.meta.url).href,
  solarEmission: new URL('../assets/textures/EclipseSolaire_Emissive.png', import.meta.url).href,
};
export type BasketSkinTextureURLs = typeof DEFAULT_URLS;
export interface BasketSkinLoadOptions {
  /** Override for a CDN or another folder layout; defaults are statically Vite-resolvable. */
  textureURLs?: Partial<BasketSkinTextureURLs>;
  manager?: THREE.LoadingManager;
}
export interface BasketSkinApplyOptions {
  context?: BasketSkinContext;
  quality?: BasketSkinQuality;
  seed?: number;
}
export interface BasketSkinFrame {
  /** Cosmetic charge only, clamped to 0..1. Never changes gameplay. */
  charge?: number;
  /** Match the cosmetic ball's visible flag, especially after a release. */
  visible?: boolean;
  /** Hide costly aura on distant/occluded balls without replacing the skin. */
  effectsEnabled?: boolean;
}
export interface BasketSkinHandle {
  readonly id: BasketSkinId;
  readonly target: THREE.Object3D;
  readonly effects: THREE.Group | null;
  readonly materialCount: number;
  readonly disposed: boolean;
  update(elapsedSeconds: number, frame?: BasketSkinFrame): void;
  dispose(): void;
}
export interface BasketSkinLibrary {
  apply(ballRoot: THREE.Object3D, id: BasketSkinId, options?: BasketSkinApplyOptions): BasketSkinHandle;
  readonly activeCount: number;
  readonly disposed: boolean;
  /** First removes every instance, then releases the five shared textures. */
  dispose(): void;
}

type Maps = Record<keyof BasketSkinTextureURLs, THREE.Texture>;
interface Binding {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  applied: THREE.Material | THREE.Material[];
}
interface AnimatedEmission { material: THREE.MeshStandardMaterial; base: number; boost: number }

function configureMaterial(m: THREE.MeshStandardMaterial, id: BasketSkinId, maps: Maps): AnimatedEmission | null {
  const channel = m.name === 'Skin_Channels';
  const panelB = m.name === 'Skin_Panels_B';
  m.map = null; m.emissiveMap = null;
  m.emissive.set(0x000000); m.emissiveIntensity = 0;
  m.metalness = 0; m.roughness = .78;
  m.transparent = false; m.opacity = 1; m.depthTest = true; m.depthWrite = true;
  m.toneMapped = true;
  let emission: AnimatedEmission | null = null;
  if (id === 'mandarine') {
    m.color.set(channel ? '#352820' : panelB ? '#f98b25' : '#ff972e');
    m.roughness = channel ? .94 : .82;
  } else if (id === 'street_pop') {
    m.color.set(channel ? '#18202a' : '#ffffff');
    if (!channel) m.map = maps.streetColor;
    m.roughness = .76;
  } else if (id === 'haute_tension') {
    m.color.set(channel ? '#0a5260' : '#ffffff');
    m.emissive.set(channel ? '#28dfff' : '#ffffff');
    if (!channel) { m.map = maps.electricColor; m.emissiveMap = maps.electricEmission; }
    m.roughness = channel ? .43 : .62;
    emission = { material: m, base: channel ? 1.55 : 1.10, boost: channel ? .70 : .45 };
  } else {
    m.color.set(channel ? '#b97518' : '#ffffff');
    m.emissive.set(channel ? '#ff991d' : '#ffffff');
    if (!channel) { m.map = maps.solarColor; m.emissiveMap = maps.solarEmission; }
    m.roughness = channel ? .36 : .52;
    m.metalness = channel ? .30 : .16;
    emission = { material: m, base: channel ? 2.05 : 1.40, boost: channel ? 1.0 : .65 };
  }
  if (emission) m.emissiveIntensity = emission.base;
  m.needsUpdate = true;
  return emission;
}

/** Ball bounds in target-local space, even when target/ancestors have zero scale. */
function localBounds(root: THREE.Object3D, meshes: THREE.Mesh[]): THREE.Box3 {
  const total = new THREE.Box3();
  for (const mesh of meshes) {
    const local = new THREE.Matrix4();
    let node: THREE.Object3D | null = mesh;
    while (node && node !== root) {
      if (node.matrixAutoUpdate) node.updateMatrix();
      local.premultiply(node.matrix);
      node = node.parent;
    }
    if (node !== root) throw new Error('GoofyBasket skin target must contain the ball meshes.');
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) total.union(mesh.geometry.boundingBox.clone().applyMatrix4(local));
  }
  return total;
}

/** Load once per game/session. Geometry, GLTF templates and gameplay are never replaced. */
export async function loadGoofyBasketSkins(options: BasketSkinLoadOptions = {}): Promise<BasketSkinLibrary> {
  const urls = { ...DEFAULT_URLS, ...options.textureURLs };
  const loader = new THREE.TextureLoader(options.manager);
  const names = Object.keys(DEFAULT_URLS) as (keyof Maps)[];
  const loaded = await Promise.allSettled(names.map(async key => {
    const texture = await loader.loadAsync(urls[key]);
    texture.name = `GoofyBasketSkin:${key}`;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 1;
    texture.needsUpdate = true;
    return texture;
  }));
  const failure = loaded.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') {
    for (const result of loaded) if (result.status === 'fulfilled') result.value.dispose();
    throw new Error(`Could not load GoofyBasket skin textures: ${String(failure.reason)}`);
  }
  const maps = Object.fromEntries(names.map((key, i) => [key, (loaded[i] as PromiseFulfilledResult<THREE.Texture>).value])) as Maps;
  const targets = new WeakMap<THREE.Object3D, BasketSkinHandle>();
  const active = new Set<BasketSkinHandle>();
  let libraryDisposed = false;
  const library: BasketSkinLibrary = {
    get activeCount() { return active.size; },
    get disposed() { return libraryDisposed; },
    apply(target, id, options = {}) {
      if (libraryDisposed) throw new Error('GoofyBasket skin library has been disposed.');
      if (!BASKET_SKINS.some(s => s.id === id)) throw new Error(`Unknown GoofyBasket skin: ${id}`);
      targets.get(target)?.dispose();
      const context = options.context ?? 'tp';
      const quality = options.quality ?? (context === 'projectile' ? 'low' : 'high');
      const seed = Number.isFinite(options.seed) ? options.seed! : 0;
      const meshes: THREE.Mesh[] = [];
      target.traverse(object => {
        if (!(object as THREE.Mesh).isMesh || object.userData.basketSkinFX) return;
        const mesh = object as THREE.Mesh;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (list.some(m => MATERIALS.has(m.name))) meshes.push(mesh);
      });
      if (!meshes.length) throw new Error('No GoofyBasket materials found. Pass the ball root, not the character or a new sphere.');
      const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      const animated: AnimatedEmission[] = [];
      const lava: BasketLavaSurface[] = [];
      const bindings: Binding[] = [];
      const replacements = (original: THREE.Material): THREE.Material => {
        if (!MATERIALS.has(original.name)) return original;
        if (!(original as THREE.MeshStandardMaterial).isMeshStandardMaterial) throw new Error(`Expected a PBR ball material: ${original.name}`);
        if (clones.has(original)) return clones.get(original)!;
        const m = (original as THREE.MeshStandardMaterial).clone();
        clones.set(original, m);
        const motion = configureMaterial(m, id, maps);
        if (motion) animated.push(motion);
        return m;
      };
      let fx: ReturnType<typeof createBasketSkinFX> | null = null;
      try {
        for (const mesh of meshes) {
          const original = mesh.material;
          const applied = Array.isArray(original) ? original.map(replacements) : replacements(original);
          bindings.push({ mesh, original, applied });
        }
        const bounds = localBounds(target, meshes);
        const size = bounds.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) * .5;
        if (!Number.isFinite(radius) || radius <= 0) throw new Error('Invalid GoofyBasket bounds.');
        if (id === 'eclipse_solaire') {
          for (const material of clones.values()) {
            if (material.name !== 'Skin_Channels') {
              // Source GLB positions have a .125 radius before scene-node scaling.
              lava.push(attachBasketLavaSurface(material, seed, .125));
            }
          }
        }
        if (context !== 'icon' && (id === 'haute_tension' || id === 'eclipse_solaire')) {
          fx = createBasketSkinFX(id === 'haute_tension' ? 'electric' : 'solar', radius, quality, seed);
          fx.root.name = `GoofyBasketFX:${id}`;
          bounds.getCenter(fx.root.position);
          fx.root.traverse(o => {
            o.userData.basketSkinFX = true;
            if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) o.raycast = () => {};
          });
        }
        for (const binding of bindings) binding.mesh.material = binding.applied;
        if (fx) target.add(fx.root);
      } catch (error) {
        for (const binding of bindings) if (binding.mesh.material === binding.applied) binding.mesh.material = binding.original;
        for (const material of clones.values()) material.dispose();
        fx?.dispose();
        throw error;
      }
      let disposed = false;
      const instance: BasketSkinHandle = {
        id, target,
        effects: fx?.root ?? null,
        materialCount: clones.size,
        get disposed() { return disposed; },
        update(elapsedSeconds, frame = {}) {
          if (disposed) return;
          const time = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
          const charge = Math.min(1, Math.max(0, Number.isFinite(frame.charge) ? frame.charge! : 0));
          const pulse = id === 'haute_tension' ? 1 + .065 * Math.sin(time * 4.0 + seed) : 1 + .045 * Math.sin(time * 1.9 + seed);
          for (const item of animated) item.material.emissiveIntensity = (item.base + item.boost * charge) * pulse;
          for (const surface of lava) surface.update(time, charge);
          if (fx) {
            fx.root.visible = frame.visible !== false && frame.effectsEnabled !== false;
            if (fx.root.visible) fx.update(time, charge);
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const binding of bindings) if (binding.mesh.material === binding.applied) binding.mesh.material = binding.original;
          if (fx) { fx.root.removeFromParent(); fx.dispose(); }
          for (const material of clones.values()) material.dispose();
          active.delete(instance);
          if (targets.get(target) === instance) targets.delete(target);
        },
      };
      active.add(instance); targets.set(target, instance); instance.update(0);
      return instance;
    },
    dispose() {
      if (libraryDisposed) return;
      for (const instance of [...active]) instance.dispose();
      for (const texture of Object.values(maps)) texture.dispose();
      libraryDisposed = true;
    },
  };
  return library;
}
