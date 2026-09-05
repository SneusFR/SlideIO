import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { SpaceConfig as space } from "./SpaceConfig";
import { getQualitySettings } from "../game/GraphicsQuality";
import mapModelUrl from "../assets/MAP/ancient_jungle_city.glb?url";
import mapPhysicsData from "../assets/MAP/ancient_jungle_city.physics.json";

/**
 * "Ancient Jungle City" — 120 × 120 m outdoor FPS map (8 players).
 *
 * Visuals: a single Meshopt-compressed GLB (≈120k tris, 92 batches,
 * 4 materials, no textures), authored in Blender at 1 unit = 1 metre,
 * already Y-up and centred — NO extra rotation or scale on the root.
 *
 * Collisions: the separate physics JSON (111 fixed cuboids + 12 convex
 * hulls for the smooth stair ramps, max slope 14.04°). Decorative water,
 * mosaics and small props carry no colliders on purpose.
 *
 * Layout (elevations): Central Crossing 0 m, Golden Lane +1.5 m (west),
 * East Ridge +3 m (east), Terrace Path +1.5 m (south-east), Ruin Walk 0 m,
 * Canal Run 0 m (west), Lower Court −1.5 m (south), Sun Gate +3 m (north).
 * The map is physically bounded by its perimeter walls.
 *
 * Lighting stays the game's own "night / space" rig (see SpaceConfig) so
 * the deep-space backdrop, fog and grading keep working unchanged.
 */

// BVH-accelerated raycasting (three-mesh-bvh). The native Three.js
// Raycaster tests EVERY triangle of a mesh — fine on the old primitive
// map, catastrophic on this ≈120k-tri GLB where every plasma beam / bot
// shot raycasts the whole map each frame. `acceleratedRaycast` uses the
// BVH when a geometry has one (built below for every map mesh) and falls
// back to the stock raycast otherwise (bot models, player proxy, targets
// stay untouched).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface MapColliderEntry {
  id: string;
  type: "cuboid" | "convexHull";
  uid: string;
  position?: number[];
  halfExtents?: number[];
  rotation?: number[];
  vertices?: number[][];
}

export class JungleMap {
  readonly group = new THREE.Group();

  private constructor(physics: PhysicsWorld, mapScene: THREE.Group) {
    this.buildLighting();

    // ---- Visual scene (GLB) ----
    mapScene.name = "Ancient Jungle City";
    mapScene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true; // 30 m sectors → cheap culling
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      // BVH per map mesh: O(log n) beam/hitscan raycasts instead of
      // brute-force triangle iteration (built once at load time).
      mesh.geometry.computeBoundsTree();
    });
    this.group.add(mapScene);

    // ---- Fixed colliders (exact physics export, never approximate) ----
    const colliders = mapPhysicsData.colliders as unknown as MapColliderEntry[];
    for (const c of colliders) {
      if (c.type === "cuboid" && c.position && c.halfExtents) {
        const [qx, qy, qz, qw] = c.rotation ?? [0, 0, 0, 1];
        physics.addStaticBox(
          c.position[0],
          c.position[1],
          c.position[2],
          c.halfExtents[0] * 2,
          c.halfExtents[1] * 2,
          c.halfExtents[2] * 2,
          { x: qx, y: qy, z: qz, w: qw },
        );
      } else if (c.type === "convexHull" && c.vertices) {
        const flat = new Float32Array(c.vertices.length * 3);
        for (let i = 0; i < c.vertices.length; i++) {
          flat[i * 3] = c.vertices[i][0];
          flat[i * 3 + 1] = c.vertices[i][1];
          flat[i * 3 + 2] = c.vertices[i][2];
        }
        const collider = physics.addStaticConvexHull(flat);
        if (!collider) {
          console.warn(`JungleMap: convex hull failed for "${c.id}"`);
        }
      }
    }
  }

  /** Loads the GLB (Meshopt) and builds every fixed collider. */
  static async create(physics: PhysicsWorld): Promise<JungleMap> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(mapModelUrl);
    return new JungleMap(physics, gltf.scene);
  }

  /**
   * "Night / space" lighting rig (see SpaceConfig — no magic numbers):
   *  - HemisphereLight: dark violet-blue sky bounce over a neutral dark
   *    ground — the jungle stone takes a subtle space tint.
   *  - Main DirectionalLight = MOONLIGHT: cool white barely tinted violet,
   *    aligned with the visible moon direction (SpaceSky) so shadows and
   *    the sky composition agree. Only shadow-casting light (readability).
   *  - Low opposite violet rim light: a faint fill that catches ruin
   *    edges / characters with a purple sheen. No shadows — cheap.
   */
  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(
      space.spaceAmbientColor,
      space.spaceAmbientGroundColor,
      space.spaceAmbientIntensity,
    );
    this.group.add(hemi);

    // Moonlight — direction matches SpaceConfig.moonPosition (the visible moon).
    const moon = new THREE.DirectionalLight(space.moonLightColor, space.moonLightIntensity);
    moon.position
      .set(space.moonPosition.x, space.moonPosition.y, space.moonPosition.z)
      .normalize()
      .multiplyScalar(120);
    moon.castShadow = true;
    // Shadow resolution follows the quality preset (LOW halves it — the
    // night scene hides the softer edges almost completely).
    const shadowRes = getQualitySettings().shadowMapSize;
    moon.shadow.mapSize.set(shadowRes, shadowRes);
    // The 120 × 120 m map (background ruins included) must fit the frustum.
    moon.shadow.camera.left = -140;
    moon.shadow.camera.right = 140;
    moon.shadow.camera.top = 140;
    moon.shadow.camera.bottom = -140;
    moon.shadow.camera.far = 400;
    moon.shadow.bias = -0.0005;
    this.group.add(moon);

    // Violet rim/fill from the opposite low direction (subtle, shadowless).
    const rim = new THREE.DirectionalLight(space.rimLightColor, space.rimLightIntensity);
    rim.position
      .set(-space.moonPosition.x, 0.25, -space.moonPosition.z)
      .normalize()
      .multiplyScalar(120);
    this.group.add(rim);
  }
}
