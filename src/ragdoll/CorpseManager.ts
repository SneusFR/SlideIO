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

interface Corpse {
  visual: THREE.Object3D;
  ragdoll: RagdollController;
  /** Cloned materials owned by this corpse (faded then disposed). */
  materials: { mat: THREE.Material; baseOpacity: number }[];
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
 */
export class CorpseManager {
  private readonly corpses: Corpse[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {}

  get count(): number {
    return this.corpses.length;
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
  }

  // ------------------------------------------------------------------

  private startFade(corpse: Corpse): void {
    if (corpse.fade >= 0) return;
    corpse.fade = 0;
    // Enable transparency only when the dissolve actually starts (opaque
    // rendering stays on the fast path for the corpse's whole lifetime).
    for (const entry of corpse.materials) {
      entry.mat.transparent = true;
      entry.mat.depthWrite = false;
      entry.mat.needsUpdate = true;
    }
  }

  private remove(index: number): void {
    const corpse = this.corpses[index];
    corpse.ragdoll.dispose();
    this.scene.remove(corpse.visual);
    // Cloned materials are owned by the corpse; geometries are SHARED with
    // the living character templates and must never be disposed here.
    for (const entry of corpse.materials) entry.mat.dispose();
    this.corpses.splice(index, 1);
  }

  /**
   * Clone every mesh material of the corpse (deduplicated) so the fade —
   * and only the fade — owns them. Shared template materials are left
   * untouched on the living characters.
   */
  private claimMaterials(visual: THREE.Object3D): { mat: THREE.Material; baseOpacity: number }[] {
    const cloned = new Map<THREE.Material, THREE.Material>();
    const owned: { mat: THREE.Material; baseOpacity: number }[] = [];

    visual.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const replace = (mat: THREE.Material): THREE.Material => {
        let clone = cloned.get(mat);
        if (!clone) {
          clone = mat.clone();
          cloned.set(mat, clone);
          owned.push({ mat: clone, baseOpacity: clone.opacity });
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
}