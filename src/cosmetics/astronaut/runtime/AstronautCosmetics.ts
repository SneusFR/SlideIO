import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const ASTRONAUT_SLOTS = ['shoes', 'pants', 'tops', 'bags', 'hats'] as const;
export type AstronautSlot = typeof ASTRONAUT_SLOTS[number];
export type AstronautContext = 'tp' | 'fp';
export interface AstronautHandle {
  readonly target: THREE.Object3D;
  readonly context: AstronautContext;
  readonly slots: readonly AstronautSlot[];
  readonly disposed: boolean;
  dispose(): void;
}
export interface AstronautApplyOptions {
  context: AstronautContext;
  /** Integrate outline/flash policies here; return cleanup for any added objects. */
  onMeshAdded?: (mesh: THREE.Mesh, slot: AstronautSlot) => void | (() => void);
}
export interface AstronautLibrary {
  readonly activeCount: number;
  readonly disposed: boolean;
  apply(target: THREE.Object3D, slots: readonly AstronautSlot[], options: AstronautApplyOptions): AstronautHandle;
  /** Call only after avatars AND corpse snapshots have released these assets. */
  dispose(): void;
}

const DEFAULT_URLS = {
  tpClothing: new URL('../assets/Astronaut_TP_Clothing.glb', import.meta.url).href,
  fpClothing: new URL('../assets/Astronaut_FP_Clothing.glb', import.meta.url).href,
  helmet: new URL('../assets/Astronaut_Helmet.glb', import.meta.url).href,
  backpack: new URL('../assets/Astronaut_Backpack.glb', import.meta.url).href,
};
export type AstronautAssetURLs = typeof DEFAULT_URLS;
export interface AstronautLoadOptions {
  assetURLs?: Partial<AstronautAssetURLs>;
  masksUrl?: string;
  manager?: THREE.LoadingManager;
}
interface SourceSignature {
  meshName: string;
  /** Audit reference: runtime verifies the actual geometry signatures below. */
  sourceSha256: string;
  positionCount: number;
  indexCount: number;
  positionSha256: string;
  indexSha256: string;
}
interface MaskManifest {
  version: 1;
  sources: Record<AstronautContext, SourceSignature>;
  triangles: Record<AstronautContext, Partial<Record<AstronautSlot, number[]>>>;
}
interface GeometryBinding {
  mesh: THREE.Mesh;
  original: THREE.BufferGeometry;
  applied: THREE.BufferGeometry;
}
interface InternalHandle extends AstronautHandle {
  geometryBindings: GeometryBinding[];
}
interface PreparedMesh { mesh: THREE.Mesh; slot: AstronautSlot }
const CLOTHES = {
  tp: { tops: 'Astro_Top', pants: 'Astro_Pants', shoes: 'Astro_Boots', hats: 'Astro_HelmetSeal' },
  fp: { tops: 'Astro_Sleeves' },
} as const;
const RIGID = {
  hats: { asset: 'helmet', socket: 'Head_Socket' },
  bags: { asset: 'backpack', socket: 'Back_Socket' },
} as const;

function requireUnique(root: THREE.Object3D, name: string): THREE.Object3D {
  const matches: THREE.Object3D[] = [];
  root.traverse(o => { if (o.name === name && !o.userData.astronautCosmetic) matches.push(o); });
  if (matches.length !== 1) throw new Error(`Astronaut: expected one ${name}, found ${matches.length}. Pass the live character rig, not a scene containing several players.`);
  return matches[0];
}

function matrixMatches(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  return a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= 1e-5);
}

// Synchronous SHA-256 keeps apply transactional, including geometry validation.
// Hash exactly the typed-array bytes, matching the export audit and masks.json.
const SHA_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function sha256(array: ArrayBufferView): string {
  const input = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  data.set(input); data[input.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(data.length - 4, input.length * 8);
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotr = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotr(a,7) ^ rotr(a,18) ^ (a >>> 3)) + words[i - 7] + (rotr(b,17) ^ rotr(b,19) ^ (b >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + words[i]) | 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,h].forEach((v,i) => { state[i] += v; });
  }
  return [...state].map(v => v.toString(16).padStart(8,'0')).join('');
}

function readManifest(value: unknown): MaskManifest {
  const data = value as MaskManifest;
  if (data?.version !== 1) throw new Error('Astronaut: masks.json version must be 1.');
  for (const context of ['tp', 'fp'] as const) {
    const source = data.sources?.[context];
    if (!source || typeof source.meshName !== 'string'
      || !Number.isInteger(source.positionCount) || source.positionCount <= 0
      || !Number.isInteger(source.indexCount) || source.indexCount <= 0 || source.indexCount % 3
      || !/^[0-9a-f]{64}$/i.test(source.positionSha256)
      || !/^[0-9a-f]{64}$/i.test(source.indexSha256)) throw new Error(`Astronaut: invalid ${context} source signature.`);
    const masks = data.triangles?.[context];
    if (!masks || typeof masks !== 'object') throw new Error(`Astronaut: missing ${context} triangle masks.`);
    for (const [slot, values] of Object.entries(masks)) {
      if (!(slot in CLOTHES[context]) || !Array.isArray(values)
        || values.some(n => !Number.isInteger(n) || n < 0 || n >= source.indexCount / 3)) {
        throw new Error(`Astronaut: invalid ${context}/${slot} triangle ordinals.`);
      }
    }
    for (const slot of Object.keys(CLOTHES[context])) {
      if (!Array.isArray(masks[slot as AstronautSlot])) throw new Error(`Astronaut: missing ${context}/${slot} mask (use [] only when no skin needs hiding).`);
    }
  }
  return data;
}

function validateGeometry(geometry: THREE.BufferGeometry, signature: SourceSignature): void {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  if (!position || !index || !(position instanceof THREE.BufferAttribute)
    || position.count !== signature.positionCount || position.itemSize !== 3
    || index.count !== signature.indexCount
    || sha256(position.array) !== signature.positionSha256.toLowerCase()
    || sha256(index.array) !== signature.indexSha256.toLowerCase()) {
    throw new Error(`Astronaut: ${signature.meshName} geometry differs from the approved source; mask application cancelled.`);
  }
  if (geometry.drawRange.start !== 0 || (geometry.drawRange.count !== Infinity && geometry.drawRange.count !== index.count)) {
    throw new Error('Astronaut: a custom body drawRange requires a compatible mask contract.');
  }
}

function maskedGeometry(source: THREE.BufferGeometry, hidden: Set<number>): THREE.BufferGeometry {
  const index = source.index!;
  const indices: number[] = [];
  const prefix = new Uint32Array(index.count / 3 + 1);
  for (let triangle = 0; triangle < index.count / 3; triangle++) {
    if (!hidden.has(triangle)) for (let corner = 0; corner < 3; corner++) indices.push(index.getX(triangle * 3 + corner));
    prefix[triangle + 1] = indices.length;
  }
  for (const group of source.groups) {
    if (group.start % 3 || group.count % 3 || group.start + group.count > index.count) throw new Error('Astronaut: body material groups must align with triangles.');
  }
  const result = source.clone();
  result.setIndex(indices); result.clearGroups();
  for (const group of source.groups) {
    const start = prefix[group.start / 3], end = prefix[(group.start + group.count) / 3];
    if (end > start) result.addGroup(start, end - start, group.materialIndex);
  }
  result.setDrawRange(0, Infinity);
  result.name = `${source.name || 'Body'}_AstronautMask`;
  return result;
}

/**
 * Loads the approved suit without replacing the character, adding a second rig,
 * changing animation clocks or guessing a retarget scale. Assets must follow the
 * accompanying bind-space and masks.json contract.
 */
export async function loadAstronautCosmetics(options: AstronautLoadOptions = {}): Promise<AstronautLibrary> {
  const urls = { ...DEFAULT_URLS, ...options.assetURLs };
  const loader = new GLTFLoader(options.manager);
  const keys = Object.keys(DEFAULT_URLS) as (keyof AstronautAssetURLs)[];
  const settled = await Promise.allSettled([
    ...keys.map(key => loader.loadAsync(urls[key])),
    fetch(options.masksUrl ?? new URL('../assets/masks.json', import.meta.url).href).then(async response => {
      if (!response.ok) throw new Error(`Astronaut masks: HTTP ${response.status}`);
      return readManifest(await response.json());
    }),
  ]);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const exportSkeletons = new Set<THREE.Skeleton>();
  for (let i = 0; i < keys.length; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;
    (result.value as GLTF).scene.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) exportSkeletons.add((mesh as THREE.SkinnedMesh).skeleton);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
      }
    });
  }
  const releaseAssets = () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    for (const skeleton of exportSkeletons) skeleton.dispose();
  };
  const failure = settled.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') { releaseAssets(); throw failure.reason; }
  const assets = Object.fromEntries(keys.map((key,i) => [key,(settled[i] as PromiseFulfilledResult<GLTF>).value])) as Record<keyof AstronautAssetURLs, GLTF>;
  const manifest = (settled[keys.length] as PromiseFulfilledResult<MaskManifest>).value;
  const clothes = new Map<string, THREE.SkinnedMesh>();
  try {
    for (const context of ['tp','fp'] as const) {
      const asset = assets[context === 'tp' ? 'tpClothing' : 'fpClothing'];
      asset.scene.updateMatrixWorld(true);
      for (const [slot,name] of Object.entries(CLOTHES[context])) {
        const mesh = requireUnique(asset.scene,name) as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) throw new Error(`Astronaut: ${name} must be skinned.`);
        clothes.set(`${context}:${slot}`,mesh);
      }
    }
    for (const item of Object.values(RIGID)) {
      const scene = assets[item.asset].scene;
      scene.updateMatrix();
      if (!matrixMatches(scene.matrix,new THREE.Matrix4())) throw new Error(`Astronaut: ${item.asset} root must be identity in socket-local space.`);
      scene.traverse(o => { if ((o as THREE.Bone).isBone || (o as THREE.SkinnedMesh).isSkinnedMesh) throw new Error(`Astronaut: ${item.asset} must be a rigid accessory without an armature.`); });
    }
  } catch (error) { releaseAssets(); throw error; }

  const targets = new WeakMap<THREE.Object3D, InternalHandle>();
  const active = new Set<InternalHandle>();
  const maskCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
  const remapCache = new Map<string, THREE.BufferGeometry>();
  let libraryDisposed = false;
  const library: AstronautLibrary = {
    get activeCount() { return active.size; },
    get disposed() { return libraryDisposed; },
    apply(target, selection, applyOptions) {
      if (libraryDisposed) throw new Error('Astronaut: library has been disposed.');
      if (!target?.isObject3D || !['tp','fp'].includes(applyOptions?.context)) throw new Error('Astronaut: pass a live target and a tp/fp context.');
      if (!Array.isArray(selection) || selection.some(slot => !ASTRONAUT_SLOTS.includes(slot))) throw new Error('Astronaut: invalid slot selection.');
      const context = applyOptions.context;
      const slots = Object.freeze(ASTRONAUT_SLOTS.filter(slot => selection.includes(slot)));
      const previous = targets.get(target);
      const body = requireUnique(target,manifest.sources[context].meshName) as THREE.SkinnedMesh;
      if (!body.isSkinnedMesh || !body.parent) throw new Error('Astronaut: the reference body must be a live SkinnedMesh.');
      const priorBinding = previous?.geometryBindings.find(binding => binding.mesh === body && body.geometry === binding.applied);
      const baseGeometry = priorBinding?.original ?? body.geometry;
      validateGeometry(baseGeometry,manifest.sources[context]);
      if (body.matrixAutoUpdate) body.updateMatrix();
      const boneIndices = new Map<string,number>();
      body.skeleton.bones.forEach((bone,i) => {
        if (boneIndices.has(bone.name)) throw new Error(`Astronaut: duplicate bone ${bone.name}.`);
        let ancestor: THREE.Object3D | null = bone;
        while (ancestor && ancestor !== target) ancestor = ancestor.parent;
        if (!ancestor) throw new Error(`Astronaut: ${bone.name} belongs to a different rig; use SkeletonUtils.clone for the character.`);
        boneIndices.set(bone.name,i);
      });
      const mounts: { parent: THREE.Object3D; node: THREE.Object3D }[] = [];
      const preparedMeshes: PreparedMesh[] = [];
      const ownMaterials = new Map<THREE.Material,THREE.Material>();
      const cleanups: (() => void)[] = [];
      const cloneMaterial = (source: THREE.Material) => {
        let clone = ownMaterials.get(source);
        if (!clone) { clone = source.clone(); ownMaterials.set(source,clone); }
        return clone;
      };
      const tagMesh = (mesh: THREE.Mesh, slot: AstronautSlot) => {
        mesh.userData.astronautCosmetic = true; mesh.userData.astronautSlot = slot;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material);
        mesh.castShadow = body.castShadow; mesh.receiveShadow = body.receiveShadow;
        mesh.frustumCulled = false; // Animated bounds belong to the shared character pose.
        mesh.raycast = () => {}; // Cosmetic pieces do not change hitboxes.
        preparedMeshes.push({mesh,slot});
      };
      const removePrepared = () => {
        for (const cleanup of cleanups.reverse()) {
          try { cleanup(); } catch (error) { console.warn('Astronaut mesh cleanup failed',error); }
        }
        cleanups.length = 0;
        for (const mount of mounts) mount.node.removeFromParent();
        for (const material of ownMaterials.values()) material.dispose();
        ownMaterials.clear();
      };
      let geometryBindings: GeometryBinding[] = [];
      try {
        for (const slot of slots) {
          const source = clothes.get(`${context}:${slot}`);
          if (source) {
            if (!matrixMatches(source.bindMatrix,body.bindMatrix)) throw new Error(`Astronaut: ${source.name} bindMatrix differs from the reference body.`);
            const remap = source.skeleton.bones.map((bone,i) => {
              const targetIndex = boneIndices.get(bone.name);
              if (targetIndex === undefined || !matrixMatches(source.skeleton.boneInverses[i],body.skeleton.boneInverses[targetIndex])) {
                throw new Error(`Astronaut: ${source.name}/${bone.name} inverse bind differs from the live reference rig.`);
              }
              return targetIndex;
            });
            const skinIndex = source.geometry.getAttribute('skinIndex');
            const skinWeight = source.geometry.getAttribute('skinWeight');
            const position = source.geometry.getAttribute('position');
            if (!position || !skinIndex || !skinWeight || skinIndex.itemSize !== 4 || skinWeight.itemSize !== 4
              || skinIndex.count !== position.count || skinWeight.count !== position.count) throw new Error(`Astronaut: invalid skin attributes on ${source.name}.`);
            for (let i = 0; i < skinIndex.count; i++) {
              let sum = 0;
              for (let j = 0; j < 4; j++) {
                const bone = skinIndex.getComponent(i,j), weight = skinWeight.getComponent(i,j);
                if (!Number.isInteger(bone) || remap[bone] === undefined || !Number.isFinite(weight) || weight < 0 || weight > 1.0001) {
                  throw new Error(`Astronaut: invalid skin joint/weight on ${source.name}.`);
                }
                sum += weight;
              }
              if (Math.abs(sum - 1) > 0.001) throw new Error(`Astronaut: weights must already be normalized on ${source.name}.`);
            }
            const key = `${context}:${slot}:${remap.join(',')}`;
            let geometry = source.geometry;
            if (remap.some((value,i) => value !== i)) {
              const cached = remapCache.get(key);
              if (cached) geometry = cached;
              else {
                geometry = source.geometry.clone();
                const mapped = new Uint16Array(skinIndex.count * 4);
                for (let i = 0; i < skinIndex.count; i++) for (let j = 0; j < 4; j++) {
                  const bone = skinIndex.getComponent(i,j);
                  mapped[i * 4 + j] = remap[bone];
                }
                geometry.setAttribute('skinIndex',new THREE.BufferAttribute(mapped,4));
                remapCache.set(key,geometry); geometries.add(geometry);
              }
            }
            // No export skeleton is attached: this mesh uses the same live skeleton.
            const mesh = new THREE.SkinnedMesh(geometry,source.material);
            mesh.name = source.name;
            mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion); mesh.scale.copy(body.scale);
            mesh.matrix.copy(body.matrix); mesh.matrixAutoUpdate = body.matrixAutoUpdate;
            mesh.bindMode = body.bindMode;
            mesh.bind(body.skeleton,body.bindMatrix);
            tagMesh(mesh,slot); mounts.push({parent:body.parent,node:mesh});
          }
          // One logical hat equips both the deformable neck seal above and the
          // complete rigid helmet below. They are removed by the same handle.
          if (context === 'tp' && slot in RIGID) {
            const item = RIGID[slot as keyof typeof RIGID];
            const socket = requireUnique(target,item.socket);
            const node = assets[item.asset].scene.clone(true);
            node.name = `Astronaut_${slot}`;
            node.traverse(object => {
              object.userData.astronautCosmetic = true; object.userData.astronautSlot = slot;
              if ((object as THREE.Mesh).isMesh) tagMesh(object as THREE.Mesh,slot);
            });
            mounts.push({parent:socket,node});
          }
        }
        const hidden = new Set<number>();
        for (const slot of slots) for (const triangle of manifest.triangles[context][slot] ?? []) hidden.add(triangle);
        if (hidden.size) {
          let cache = maskCache.get(baseGeometry);
          if (!cache) { cache = new Map(); maskCache.set(baseGeometry,cache); }
          const key = [...hidden].sort((a,b) => a-b).join(',');
          let masked = cache.get(key);
          if (!masked) { masked = maskedGeometry(baseGeometry,hidden); cache.set(key,masked); geometries.add(masked); }
          geometryBindings.push({mesh:body,original:baseGeometry,applied:masked});
          target.traverse(object => {
            const mesh = object as THREE.Mesh;
            if (mesh.isMesh && mesh.userData.enemyOutline && !mesh.userData.astronautCosmetic) {
              const prior = previous?.geometryBindings.find(binding => binding.mesh === mesh && mesh.geometry === binding.applied);
              const original = prior?.original ?? mesh.geometry;
              if (original === baseGeometry) geometryBindings.push({mesh,original,applied:masked!});
            }
          });
        }
        // Hooks run before replacing the previous outfit. A hook failure rolls
        // back only the prepared pieces, leaving the previous outfit intact.
        for (const mount of mounts) mount.parent.add(mount.node);
        for (const {mesh,slot} of preparedMeshes) {
          const cleanup = applyOptions.onMeshAdded?.(mesh,slot);
          if (cleanup) cleanups.push(cleanup);
        }
      } catch (error) { removePrepared(); throw error; }

      previous?.dispose();
      for (const binding of geometryBindings) binding.mesh.geometry = binding.applied;
      let handleDisposed = false;
      const handle: InternalHandle = {
        target, context, slots, geometryBindings,
        get disposed() { return handleDisposed; },
        dispose() {
          if (handleDisposed) return;
          handleDisposed = true;
          removePrepared();
          for (const binding of geometryBindings) {
            if (binding.mesh.geometry === binding.applied) binding.mesh.geometry = binding.original;
          }
          geometryBindings = [];
          if (targets.get(target) === handle) targets.delete(target);
          active.delete(handle);
        },
      };
      targets.set(target,handle); active.add(handle);
      return handle;
    },
    dispose() {
      if (libraryDisposed) return;
      libraryDisposed = true;
      for (const handle of [...active]) handle.dispose();
      releaseAssets();
    },
  };
  return library;
}
