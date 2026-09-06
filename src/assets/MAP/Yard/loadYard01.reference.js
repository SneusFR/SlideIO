import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// YARD exports are already in metres, Y-up. Keep the map's parent transform at identity.
// Initialize Rapier and create your world before calling either exported function.
const vector = (a) => ({ x: a[0], y: a[1], z: a[2] });
function finiteArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new TypeError(`YARD: ${label} must contain ${length} finite numbers`);
  }
  return value;
}

export function createYardColliders(physics, world, RAPIER, { collisionGroups = 0xffffffff } = {}) {
  if (!Array.isArray(physics?.colliders)) throw new TypeError('YARD: colliders array missing');
  const colliders = [];
  const byId = new Map();
  try {
    for (const item of physics.colliders) {
      if (!item.id || byId.has(item.id)) throw new Error(`YARD: missing or duplicate collider ID ${item.id}`);
      let descriptor;
      if (item.type === 'cuboid') {
        const extents = finiteArray(item.halfExtents, 3, `${item.id}.halfExtents`);
        if (extents.some((n) => n <= 0)) throw new RangeError(`YARD: invalid extents for ${item.id}`);
        const position = finiteArray(item.position, 3, `${item.id}.position`);
        const rotation = finiteArray(item.rotation ?? [0, 0, 0, 1], 4, `${item.id}.rotation`);
        const length = Math.hypot(...rotation);
        if (length < 1e-8) throw new RangeError(`YARD: zero quaternion for ${item.id}`);
        descriptor = RAPIER.ColliderDesc.cuboid(...extents)
          .setTranslation(...position)
          .setRotation({ x: rotation[0] / length, y: rotation[1] / length,
            z: rotation[2] / length, w: rotation[3] / length });
      } else if (item.type === 'convexHull') {
        if (!Array.isArray(item.vertices) || item.vertices.length < 4) {
          throw new TypeError(`YARD: insufficient convex vertices for ${item.id}`);
        }
        const vertices = item.vertices.flatMap((v) => finiteArray(v, 3, `${item.id}.vertices`));
        // Hull vertices are absolute game coordinates. Do not translate/rotate them again.
        descriptor = RAPIER.ColliderDesc.convexHull(new Float32Array(vertices));
        if (!descriptor) throw new Error(`YARD: Rapier rejected convex hull ${item.id}`);
      } else {
        throw new Error(`YARD: unsupported collider type ${item.type}`);
      }
      descriptor.setFriction(0.65).setRestitution(0).setCollisionGroups(collisionGroups);
      // Parentless colliders are static. The map has no simulated decorative props.
      const collider = world.createCollider(descriptor);
      colliders.push(collider);
      byId.set(item.id, { collider, metadata: item });
    }
    world.updateSceneQueries();
  } catch (error) {
    for (const collider of colliders) world.removeCollider(collider, false);
    throw error;
  }
  return { colliders, byId };
}

async function json(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`YARD: ${response.status} loading ${url}`);
  return response.json();
}

function releaseScene(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [object.material].flat().filter(Boolean)) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    texture.dispose();
    if (typeof texture.source?.data?.close === 'function') texture.source.data.close();
  }
}

/**
 * Example:
 * await RAPIER.init();
 * const world = new RAPIER.World({ x: 0, y: -28, z: 0 });
 * const yard = await loadYard01({ scene, world, RAPIER, baseUrl: '/maps/yard/' });
 * Use yard.metadata.spawns with your spawn-selection logic; they are test candidates.
 * Remove the map before freeing world: yard.dispose(); world.free();
 * The GLB is self-contained. Serve these files over HTTP rather than file://.
 */
export async function loadYard01({ scene, world, RAPIER, baseUrl = './',
  glbUrl, physicsUrl, manifestUrl, meshoptDecoder, collisionGroups = 0xffffffff,
  castShadow = true, receiveShadow = true, signal } = {}) {
  if (!scene?.add || !world?.createCollider || !RAPIER?.ColliderDesc) {
    throw new TypeError('YARD: scene, initialized world and RAPIER are required');
  }
  const base = new URL(baseUrl, globalThis.location?.href ?? import.meta.url);
  const assetUrl = glbUrl ?? new URL('yard_01.glb', base).href;
  const dataUrl = physicsUrl ?? new URL('yard_01.physics.json', base).href;
  const loader = new GLTFLoader();
  if (meshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);
  // Fetch the specification first so a failed JSON request cannot leak a loaded GLB.
  const physics = await json(dataUrl, signal);
  const manifest = manifestUrl ? await json(manifestUrl, signal) : null;
  const gltf = await loader.loadAsync(assetUrl);
  const root = gltf.scene;
  let created;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('YARD load cancelled');
    created = createYardColliders(physics, world, RAPIER, { collisionGroups });
    root.name = 'YARD_01';
    root.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = castShadow;
        object.receiveShadow = receiveShadow;
      }
    });
    scene.add(root);
  } catch (error) {
    if (created) for (const collider of created.colliders) world.removeCollider(collider, false);
    releaseScene(root);
    throw error;
  }
  let disposed = false;
  return {
    root,
    animations: gltf.animations,
    colliders: created.colliders,
    collidersById: created.byId,
    metadata: { ...physics, manifest },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      for (const collider of created.colliders) world.removeCollider(collider, false);
      world.updateSceneQueries();
      releaseScene(root);
    },
  };
}
