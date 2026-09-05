import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * RAPIER must already be initialized. The caller owns scene, world, lighting,
 * player movement and networking. Works with a fixed simulation step.
 * Tested with three 0.180.0 and @dimforge/rapier3d-compat 0.17.3.
 */
export async function loadAncientJungleCity({ THREE, RAPIER, scene, world, baseUrl = './', shadows = false }) {
  const rootUrl = new URL(baseUrl, globalThis.location?.href ?? import.meta.url);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [gltf, response] = await Promise.all([
    loader.loadAsync(new URL('ancient_jungle_city.glb', rootUrl).href),
    fetch(new URL('ancient_jungle_city.physics.json', rootUrl))
  ]);
  if (!response.ok) throw new Error(`Map physics: HTTP ${response.status}`);
  const metadata = await response.json();
  const colliders = [];
  try {
    for (const c of metadata.colliders) {
      let desc;
      if (c.type === 'cuboid') {
        desc = RAPIER.ColliderDesc.cuboid(...c.halfExtents).setTranslation(...c.position);
        const [x, y, z, w] = c.rotation;
        desc.setRotation({ x, y, z, w });
      } else if (c.type === 'convexHull') {
        desc = RAPIER.ColliderDesc.convexHull(new Float32Array(c.vertices.flat()));
      } else {
        throw new Error(`Unsupported collider: ${c.type}`);
      }
      if (!desc) throw new Error(`Invalid collider: ${c.id}`);
      // A parentless Rapier collider is fixed. No dynamic map body is needed.
      desc.setFriction(0).setRestitution(0);
      const collider = world.createCollider(desc);
      collider.userData = { map: metadata.name, id: c.uid, label: c.id };
      colliders.push(collider);
    }
  } catch (error) {
    colliders.forEach(collider => world.removeCollider(collider, false));
    throw error;
  }
  gltf.scene.name = 'Ancient Jungle City';
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = shadows;
    object.receiveShadow = shadows;
    object.frustumCulled = true;
    object.geometry.computeBoundingBox();
    object.geometry.computeBoundingSphere();
  });
  // Already metre-scale, Y-up and centred: do not rotate or scale the root.
  scene.add(gltf.scene);
  return {
    root: gltf.scene,
    metadata,
    colliders,
    dispose() {
      scene.remove(gltf.scene);
      for (const collider of colliders) world.removeCollider(collider, false);
      const geometries = new Set(), materials = new Set();
      gltf.scene.traverse(object => {
        if (!object.isMesh) return;
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m));
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
    }
  };
}

export function createMapCharacterController(world) {
  const controller = world.createCharacterController(0.025);
  controller.enableAutostep(0.25, 0.25, false);
  controller.enableSnapToGround(0.30);
  controller.setMaxSlopeClimbAngle(Math.PI / 6);
  controller.setMinSlopeSlideAngle(Math.PI / 4);
  return controller;
}
