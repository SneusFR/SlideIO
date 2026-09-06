import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { YardConfig as yard } from "./YardConfig";
import { getQualitySettings } from "../game/GraphicsQuality";
import mapModelUrl from "../assets/MAP/Yard/yard_01.glb?url";
import mapPhysicsData from "../assets/MAP/Yard/yard_01.physics.json";

/**
 * "YARD 01 Expanded" — acid parkour and power tower (8 players).
 *
 * Visuals: a single Meshopt-compressed GLB (≈219k tris, 4 materials, one
 * 1024×256 atlas, 82 static groups + 18 animated objects + the acid
 * surface), authored at 1 unit = 1 metre, already Y-up and centred —
 * NO extra rotation or scale on the root.
 *
 * Collisions: the separate physics JSON (388 fixed colliders — 372
 * cuboids + 16 convex hulls: 5 smooth movement ramps at 20.6°, their
 * cheeks and one prop). Convex hull vertices are ABSOLUTE world
 * coordinates — never translated/rotated again. The perimeter boundary
 * volumes rise to 32 m so the tower and rooftops can't be escaped.
 *
 * Animations (bubbles / ripples / fans / cameras / terminal, 4 s loop) are
 * NOT played here — YardEffects owns the single AnimationMixer.
 *
 * Lighting: the map's own "contaminated industrial dusk" rig (YardConfig),
 * distinct from the Jungle map's violet space rig.
 */

// BVH-accelerated raycasting (idempotent — JungleMap installs the same
// prototypes; whichever map loads first wins, the result is identical).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface YardColliderEntry {
  id: string;
  type: "cuboid" | "convexHull";
  position?: number[];
  halfExtents?: number[];
  rotation?: number[];
  vertices?: number[][];
  purpose?: string;
}

/** Interactable metadata (terminals) straight from the physics export. */
export interface YardInteractable {
  id: string;
  position: [number, number, number];
  radius: number;
  label: string;
  effect: string;
  requiresLineOfSight: boolean;
}

/** Axis-aligned hazard volume (acid pool) from the physics export. */
export interface YardHazard {
  id: string;
  type: string;
  min: [number, number, number];
  max: [number, number, number];
  respawnFeet: [number, number, number];
}

export class YardMap {
  readonly group = new THREE.Group();
  /** GLB scene root (YardEffects binds its AnimationMixer to this). */
  readonly root: THREE.Group;
  /** Animation clips of the export (4 s loop, 18 animated objects). */
  readonly animations: THREE.AnimationClip[];
  /** Hazard volumes (client-side feedback — the SERVER owns MP deaths). */
  readonly hazards: YardHazard[];
  /** Terminal interactables (west supercomputer + upper control console). */
  readonly interactables: YardInteractable[];

  private constructor(
    physics: PhysicsWorld,
    mapScene: THREE.Group,
    animations: THREE.AnimationClip[],
  ) {
    this.root = mapScene;
    this.animations = animations;
    const data = mapPhysicsData as unknown as {
      hazards?: YardHazard[];
      interactables?: YardInteractable[];
    };
    this.hazards = data.hazards ?? [];
    this.interactables = data.interactables ?? [];

    this.buildLighting();

    // ---- Visual scene (GLB) ----
    mapScene.name = "YARD_01";
    mapScene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true; // spatial sectors → cheap culling
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      // BVH per map mesh: O(log n) beam/hitscan raycasts (built once).
      mesh.geometry.computeBoundsTree();
    });
    this.group.add(mapScene);

    // ---- Fixed colliders (exact physics export, created ONCE) ----
    // Cuboids keep their quaternion; hull vertices are already absolute.
    const colliders = mapPhysicsData.colliders as unknown as YardColliderEntry[];
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
          console.warn(`YardMap: convex hull failed for "${c.id}"`);
        }
      }
    }
  }

  /** Loads the GLB (Meshopt) and builds every fixed collider. */
  static async create(physics: PhysicsWorld): Promise<YardMap> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    try {
      gltf = await loader.loadAsync(mapModelUrl);
    } catch (err) {
      throw new Error(
        `YardMap: failed to load/decode yard_01.glb (Meshopt) — ${String(err)}`,
      );
    }
    return new YardMap(physics, gltf.scene, gltf.animations);
  }

  /**
   * "Contaminated industrial dusk" rig (see YardConfig):
   *  - HemisphereLight: smoggy amber sky bounce over dark asphalt.
   *  - Main DirectionalLight = HAZY LOW SUN: warm rust, aligned with the
   *    visible sun sprite (YardSky). Only shadow-casting light.
   *  - Acid-green rim fill from the west (the pool's answer glow) — cheap,
   *    shadowless.
   */
  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(
      yard.ambientSkyColor,
      yard.ambientGroundColor,
      yard.ambientIntensity,
    );
    this.group.add(hemi);

    const sun = new THREE.DirectionalLight(yard.sunLightColor, yard.sunLightIntensity);
    sun.position
      .set(yard.sunPosition.x, yard.sunPosition.y, yard.sunPosition.z)
      .normalize()
      .multiplyScalar(140);
    sun.castShadow = true;
    const shadowRes = getQualitySettings().shadowMapSize;
    sun.shadow.mapSize.set(shadowRes, shadowRes);
    // The 112 × 168 m arena (background land included) must fit the frustum.
    sun.shadow.camera.left = -160;
    sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160;
    sun.shadow.camera.bottom = -160;
    sun.shadow.camera.far = 450;
    sun.shadow.bias = -0.0005;
    this.group.add(sun);

    const rim = new THREE.DirectionalLight(yard.rimLightColor, yard.rimLightIntensity);
    rim.position
      .set(yard.acidGlowPosition.x, yard.acidGlowPosition.y, yard.acidGlowPosition.z)
      .normalize()
      .multiplyScalar(120);
    this.group.add(rim);
  }
}
