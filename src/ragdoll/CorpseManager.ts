import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { RagdollController, RagdollPartDef, RagdollImpact } from "./RagdollController";
import { RagdollConfig as rc } from "./RagdollConfig";
import { MovementConfig as mc } from "../player/MovementConfig";

export interface CorpseSpawnOptions {
  /** Character velocity at the moment of death (momentum is preserved). */
  velocity: THREE.Vector3;
  /** The fatal hit that triggered the death ragdoll (optional). */
  impact?: RagdollImpact | null;
}

/** One cloned material in use by a corpse (returned to the pool on removal). */
interface CorpseMaterialEntry {
  /** Source (living) material — the pool key. */
  source: THREE.Material;
  mat: THREE.Material;
  baseOpacity: number;
}

interface Corpse {
  visual: THREE.Object3D;
  ragdoll: RagdollController;
  /** Pooled material clones owned by this corpse while it exists. */
  materials: CorpseMaterialEntry[];
  age: number;
  /** Seconds of fade already elapsed (-1 = not fading yet). */
  fade: number;
}

/**
 * Owns every DEATH ragdoll (corpse) in the scene:
 *
 *   death → snapshot of the posed visual (independent clone — the real
 *   character can respawn elsewhere without teleporting its corpse)
 *   → full Rapier simulation (momentum + fatal-hit impulse preserved)
 *   → ~5 s of physics (Rapier auto-sleeps settled bodies)
 *   → short opacity dissolve → removal.
 *
 * A configurable cap keeps performance safe: past `maxCorpses` the OLDEST
 * corpse fades out early. Corpses falling under the kill plane are culled.
 *
 * The corpse's materials are CLONED at spawn (geometry stays shared with
 * the living templates): fading a corpse can never tint a living
 * character, and living damage-flashes never tint a corpse.
 *
 * PERF — the clones are POOLED and created `transparent` up front:
 *   - toggling `material.transparent` mid-life changes the WebGL program
 *     cache key → a synchronous shader recompile (a visible hitch every
 *     time a corpse started fading);
 *   - disposing the clones on removal dropped the program refcount to 0 →
 *     three.js destroyed the compiled program, and the NEXT corpse paid a
 *     full recompile again (a visible hitch every time a corpse vanished).
 * Pooled clones keep the programs warm forever: after the very first
 * corpse, spawn/fade/removal never compile or destroy anything.
 */
export class CorpseManager {
  private readonly corpses: Corpse[] = [];
  private readonly tmp = new THREE.Vector3();
  /** Reusable fade clones keyed by their SOURCE (living) material. */
  private readonly materialPool = new Map<THREE.Material, THREE.Material[]>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {}

  get count(): number {
    return this.corpses.length;
  }

  /**
   * GPU warm-up (see Game.warmUpRendering): claim the pooled transparent
   * fade clones on `visual` so ONE forced render compiles the corpse
   * shader programs NOW — `transparent: true` (+ skinning) is a different
   * program cache key than the living, opaque character materials, so the
   * FIRST real corpse used to pay a synchronous mid-fight recompile (the
   * "first kill freeze"). The caller renders the visual, then invokes the
   * returned release function: the clones go back to the pool and keep
   * their compiled programs warm forever (they are never disposed).
   */
  warmUp(visual: THREE.Object3D): () => void {
    const materials = this.claimMaterials(visual);
    return () => {
      for (const entry of materials) this.releaseMaterial(entry);
    };
  }

  /**
   * Register a corpse. `visual` must already be posed at the death pose in
   * WORLD space (independent clone); `parts` were built from that pose.
   * The manager takes ownership of the visual and adds it to the scene.
   */
  spawn(visual: THREE.Object3D, parts: RagdollPartDef[], options: CorpseSpawnOptions): void {
    // Corpse cap: the OLDEST corpse starts its fade right now.
    let alive = 0;
    for (const c of this.corpses) if (c.fade < 0) alive++;
    if (alive >= rc.maxCorpses) {
      const oldest = this.corpses.find((c) => c.fade < 0);
      if (oldest) this.startFade(oldest);
    }

    this.scene.add(visual);

    const materials = this.claimMaterials(visual);
    const ragdoll = new RagdollController(this.physics, this.scene);
    ragdoll.activate(visual, parts, {
      mode: "DEATH",
      velocity: options.velocity,
      impact: options.impact ?? null,
    });

    this.corpses.push({ visual, ragdoll, materials, age: 0, fade: -1 });
  }

  /** Per frame, AFTER physics.step (bodies were just integrated). */
  update(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i];
      corpse.age += dt;
      corpse.ragdoll.update(dt);

      // Safety culls: corrupted simulation or fell out of the world.
      corpse.ragdoll.getRootPosition(this.tmp);
      if (corpse.ragdoll.corrupted || this.tmp.y < mc.killPlaneY - 30) {
        this.remove(i);
        continue;
      }

      if (corpse.fade < 0 && corpse.age >= rc.corpseLifetime) this.startFade(corpse);

      if (corpse.fade >= 0) {
        corpse.fade += dt;
        const k = 1 - Math.min(corpse.fade / rc.corpseFadeDuration, 1);
        for (const entry of corpse.materials) entry.mat.opacity = entry.baseOpacity * k;
        if (corpse.fade >= rc.corpseFadeDuration) this.remove(i);
      }
    }
  }

  dispose(): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) this.remove(i);
    // Full teardown only (game exit): now the pooled clones can go.
    for (const pool of this.materialPool.values()) {
      for (const mat of pool) mat.dispose();
    }
    this.materialPool.clear();
  }

  // ------------------------------------------------------------------

  private startFade(corpse: Corpse): void {
    if (corpse.fade >= 0) return;
    corpse.fade = 0;
    // The clones are ALREADY transparent (created that way — see the
    // class doc: no program recompile). Only depthWrite flips here, which
    // is pure GL state (no shader change, no needsUpdate, no hitch).
    for (const entry of corpse.materials) entry.mat.depthWrite = false;
  }

  private remove(index: number): void {
    const corpse = this.corpses[index];
    corpse.ragdoll.dispose();
    this.scene.remove(corpse.visual);
    // NEVER disposed (that would destroy the compiled shader program and
    // force a recompile hitch on the next corpse) — reset + pool instead.
    // Geometries are SHARED with the living templates: never touched.
    for (const entry of corpse.materials) this.releaseMaterial(entry);
    this.corpses.splice(index, 1);
  }

  /**
   * Swap every mesh material of the corpse for a POOLED fade clone
   * (deduplicated per corpse) so the fade — and only the fade — owns them.
   * Shared template materials are left untouched on the living characters.
   */
  private claimMaterials(visual: THREE.Object3D): CorpseMaterialEntry[] {
    const claimed = new Map<THREE.Material, THREE.Material>();
    const owned: CorpseMaterialEntry[] = [];

    visual.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const replace = (mat: THREE.Material): THREE.Material => {
        let clone = claimed.get(mat);
        if (!clone) {
          clone = this.acquireMaterial(mat);
          claimed.set(mat, clone);
          owned.push({ source: mat, mat: clone, baseOpacity: mat.opacity });
        }
        return clone;
      };
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(replace);
      } else if (mesh.material) {
        mesh.material = replace(mesh.material);
      }
    });
    return owned;
  }

  /** Pooled clone for `source` — created once, then reused forever. */
  private acquireMaterial(source: THREE.Material): THREE.Material {
    const pool = this.materialPool.get(source);
    const pooled = pool?.pop();
    if (pooled) {
      // Fresh corpse: fully opaque again, depth-writing until its fade.
      pooled.opacity = source.opacity;
      pooled.depthWrite = true;
      return pooled;
    }
    const clone = source.clone();
    // Transparent FROM CREATION: the program is compiled once with the
    // final cache key — starting the fade later never recompiles anything.
    clone.transparent = true;
    clone.depthWrite = true;
    // Corpses are NOT threats: never write the enemy-outline stencil mask
    // (inherited from living enemy materials via clone) — a corpse behind
    // a living enemy must not punch holes in that enemy's red contour.
    clone.stencilWrite = false;
    return clone;
  }

  /** Return a clone to its source's pool (reset happens on acquire). */
  private releaseMaterial(entry: CorpseMaterialEntry): void {
    let pool = this.materialPool.get(entry.source);
    if (!pool) {
      pool = [];
      this.materialPool.set(entry.source, pool);
    }
    pool.push(entry.mat);
  }
}
