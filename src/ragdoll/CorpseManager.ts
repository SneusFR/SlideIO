import * as THREE from "three";
import { compileLikeWorldPass, killPrep, type KillPrepGpu } from "../effects/KillPrep";
import { markMatrixFresh, skipFreshMatrixUpdate } from "../effects/matrixFresh";
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

/** Cap of parked fade clones from evicted ephemeral sources (see orphanClones). */
const MAX_ORPHAN_CLONES = 16;

/** A fade clone made ahead of the kill (see CorpseManager.prewarm). */
interface ReadyClone {
  mat: THREE.Material;
  /** Its source was disposed: the clone goes too. */
  onSourceDispose: () => void;
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
  /**
   * Fade clones of EVICTED ephemeral sources (per-instance outfit
   * materials): kept alive in a bounded ring purely so three.js keeps their
   * compiled programs referenced; never handed out again (their source is
   * gone). Oldest entries are disposed past MAX_ORPHAN_CLONES.
   */
  private readonly orphanClones: THREE.Material[] = [];
  /**
   * KILLPREP: at most ONE initialized fade clone per source whose pool is
   * empty, made on an ordinary frame (prewarm) and handed out by the next
   * kill that would have cloned the source (acquireMaterial).
   */
  private readonly ready = new Map<THREE.Material, ReadyClone>();

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
    // A corpse has TWO looks with different programs: its opaque life (one
    // double-sided pass, see singlePassWhileOpaque) and its fade (three's
    // back-face + front-face passes). Each warm draw of a piece alternates
    // between them, so both compile during the loading screen.
    const sourceOf = new Map<THREE.Material, THREE.Material>();
    for (const entry of materials) sourceOf.set(entry.mat, entry.source);
    const hooked: { mesh: THREE.Mesh; previous: THREE.Mesh["onBeforeRender"] }[] = [];
    visual.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const previous = mesh.onBeforeRender;
      let draws = 0;
      mesh.onBeforeRender = function (this: THREE.Mesh, ...args) {
        const fading = draws++ % 2 === 1;
        for (const mat of Array.isArray(this.material) ? this.material : [this.material]) {
          const source = sourceOf.get(mat);
          if (source) mat.forceSinglePass = fading ? source.forceSinglePass : singlePassWhileOpaque(source);
        }
        previous.apply(this, args);
      };
      hooked.push({ mesh, previous });
    });
    return () => {
      for (const { mesh, previous } of hooked) mesh.onBeforeRender = previous;
      for (const entry of materials) this.releaseMaterial(entry);
    };
  }

  /**
   * PERF (KILLPREP, see effects/KillPrep.ts) — the fade clones the NEXT
   * corpse of `visual` would create, made and initialized now: for every
   * material on a visible mesh whose pool is empty (the kill would clone
   * it), one clone with the kill's settings, run through three's program
   * selection on `visual`'s own meshes (both looks, as in warmUp: the fade,
   * then the opaque life), no draw. `visual` = the corpse clone prepared
   * ahead (CorpseCloneSpare), showing the live materials. Returns the
   * number of clones made.
   */
  prewarm(visual: THREE.Object3D, gpu: KillPrepGpu): number {
    if (!killPrep.on) return 0;
    const made = new Map<THREE.Material, THREE.Material>(); // source → its new clone
    const shown = new Set<THREE.Object3D>();
    visual.traverseVisible((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      shown.add(mesh);
      for (const source of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (made.has(source) || this.ready.has(source) || !canPrepare(source)) continue;
        if ((this.materialPool.get(source)?.length ?? 0) > 0) continue; // the kill pops that one
        const entry: ReadyClone = {
          mat: createFadeClone(source),
          onSourceDispose: () => this.dropReady(source),
        };
        source.addEventListener("dispose", entry.onSourceDispose);
        this.ready.set(source, entry);
        made.set(source, entry.mat);
      }
    });
    if (made.size === 0) return 0;
    // Every drawable of `visual` shows only the NEW clones of its sources
    // (or no material: compile() skips it) — nothing else is touched.
    const saved: { obj: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
    visual.traverse((obj) => {
      const o = obj as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      saved.push({ obj: o, material: o.material });
      const clones: THREE.Material[] = [];
      if (shown.has(o)) {
        for (const source of Array.isArray(o.material) ? o.material : [o.material]) {
          const clone = made.get(source);
          if (clone && !clones.includes(clone)) clones.push(clone);
        }
      }
      o.material = (clones.length === 0 ? null : clones.length === 1 ? clones[0] : clones) as unknown as THREE.Material;
    });
    try {
      // The fade look first, the opaque life last: the kill's first draw
      // then finds its program already current (three's early out).
      for (const [source, clone] of made) clone.forceSinglePass = source.forceSinglePass;
      compileLikeWorldPass(visual, gpu);
      for (const [source, clone] of made) clone.forceSinglePass = singlePassWhileOpaque(source);
      compileLikeWorldPass(visual, gpu);
    } finally {
      for (const { obj, material } of saved) obj.material = material;
    }
    return made.size;
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
    // PERF: final after Game.frame's matrix pass — the renderer skips it (see matrixFresh).
    skipFreshMatrixUpdate(visual);

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

  /** Corpse matrices are final for this frame (see BotManager.markMatricesFresh). */
  markMatricesFresh(): void {
    for (const corpse of this.corpses) markMatrixFresh(corpse.visual);
  }

  /** Remove every corpse now (fresh match) — pooled materials are kept. */
  clear(): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) this.remove(i);
  }

  dispose(): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) this.remove(i);
    // Full teardown only (game exit): now the pooled clones can go.
    for (const pool of this.materialPool.values()) {
      for (const mat of pool) mat.dispose();
    }
    this.materialPool.clear();
    for (const mat of this.orphanClones) mat.dispose();
    this.orphanClones.length = 0;
    for (const source of [...this.ready.keys()]) this.dropReady(source);
  }

  // ------------------------------------------------------------------

  private startFade(corpse: Corpse): void {
    if (corpse.fade >= 0) return;
    corpse.fade = 0;
    // The clones are ALREADY transparent (created that way — see the
    // class doc: no program recompile). Only depthWrite flips here, which
    // is pure GL state (no shader change, no needsUpdate, no hitch).
    // The dissolve blends: double-sided pieces go back to three's two-pass
    // (back faces, then front faces) for the fade only (see
    // singlePassWhileOpaque) — again pure render state.
    for (const entry of corpse.materials) {
      entry.mat.depthWrite = false;
      entry.mat.forceSinglePass = entry.source.forceSinglePass;
    }
  }

  private remove(index: number): void {
    const corpse = this.corpses[index];
    corpse.ragdoll.dispose();
    this.scene.remove(corpse.visual);
    // NEVER disposed (that would destroy the compiled shader program and
    // force a recompile hitch on the next corpse) — reset + pool instead.
    // Geometries are SHARED with the living templates: never touched.
    // Unregister BEFORE releasing so the ephemeral-source eviction check
    // (sourceInUse) no longer counts this corpse.
    this.corpses.splice(index, 1);
    for (const entry of corpse.materials) this.releaseMaterial(entry);
    // The corpse visual is an independent SkeletonUtils clone: its
    // skeletons (and their bone DataTextures) belong to it alone — without
    // this every kill leaked one GPU bone texture per skinned piece.
    const skeletons = new Set<THREE.Skeleton>();
    corpse.visual.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) skeletons.add(skinned.skeleton);
    });
    for (const s of skeletons) s.dispose();
  }

  /**
   * True while at least one existing corpse still uses a clone of `source`
   * (eviction guard for EPHEMERAL sources — see releaseMaterial).
   */
  private sourceInUse(source: THREE.Material): boolean {
    for (const corpse of this.corpses) {
      for (const entry of corpse.materials) if (entry.source === source) return true;
    }
    return false;
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
      // Fresh corpse: opacity back to the SOURCE's (a glass visor keeps its
      // authored translucency, an opaque piece starts fully opaque) and the
      // source's depth rule (transparent glass never writes depth, or it
      // would hide the face behind it) until the fade flips it off.
      pooled.opacity = source.opacity;
      pooled.depthWrite = source.depthWrite;
      pooled.forceSinglePass = singlePassWhileOpaque(source);
      return pooled;
    }
    // KILLPREP: the clone made ahead (prewarm), brought to the source's
    // state of NOW — the very clone the next line would create.
    const ready = killPrep.on ? this.ready.get(source) : undefined;
    if (ready) {
      this.ready.delete(source);
      source.removeEventListener("dispose", ready.onSourceDispose);
      return refreshFadeClone(ready.mat, source);
    }
    return createFadeClone(source);
  }

  /** A ready clone whose source went away (disposed / manager torn down). */
  private dropReady(source: THREE.Material): void {
    const ready = this.ready.get(source);
    if (!ready) return;
    this.ready.delete(source);
    source.removeEventListener("dispose", ready.onSourceDispose);
    ready.mat.dispose();
  }

  /**
   * Return a clone to its source's pool (reset happens on acquire).
   *
   * BOUNDED lifecycle for PRIVATE sources (`userData.corpsePoolEphemeral`,
   * e.g. per-instance outfit materials that die with their avatar): once
   * no corpse uses that source any more, its clones are disposed and the
   * pool entry evicted — otherwise every outfit change of every player
   * would leave a permanent pool entry behind. Shared living materials
   * (character templates, weapons) keep the warm-forever policy.
   */
  private releaseMaterial(entry: CorpseMaterialEntry): void {
    if (entry.source.userData.corpsePoolEphemeral && !this.sourceInUse(entry.source)) {
      // Evict the per-source entry; park its clones in the bounded ORPHAN
      // ring so their compiled programs stay warm for the next outfit corpse
      // (same program signature) — the oldest beyond the cap are disposed.
      const stale = this.materialPool.get(entry.source) ?? [];
      this.materialPool.delete(entry.source);
      for (const mat of [entry.mat, ...stale]) {
        this.orphanClones.push(mat);
        if (this.orphanClones.length > MAX_ORPHAN_CLONES) this.orphanClones.shift()!.dispose();
      }
      return;
    }
    let pool = this.materialPool.get(entry.source);
    if (!pool) {
      pool = [];
      this.materialPool.set(entry.source, pool);
    }
    pool.push(entry.mat);
  }
}

/** A corpse's fade clone of `source`, created now. */
export function createFadeClone(source: THREE.Material): THREE.Material {
  return applyFadeSettings(source.clone(), source);
}

/**
 * KILLPREP: `clone` (a fade clone of `source` made earlier, never drawn)
 * brought to what createFadeClone(source) returns NOW: same values
 * (Material.clone() is `new constructor().copy(source)`), same settings.
 */
export function refreshFadeClone(clone: THREE.Material, source: THREE.Material): THREE.Material {
  return applyFadeSettings(clone.copy(source), source);
}

function applyFadeSettings(clone: THREE.Material, source: THREE.Material): THREE.Material {
  // Transparent FROM CREATION: the program is compiled once with the
  // final cache key — starting the fade later never recompiles anything.
  clone.transparent = true;
  // Depth rule inherited from the source: opaque body pieces write depth
  // until their fade; already-transparent sources (helmet glass) keep
  // depthWrite=false so the eyes and smile stay readable through them.
  clone.depthWrite = source.depthWrite;
  clone.forceSinglePass = singlePassWhileOpaque(source);
  // Corpses are NOT threats: never write the enemy-outline stencil mask
  // (inherited from living enemy materials via clone) — a corpse behind
  // a living enemy must not punch holes in that enemy's red contour.
  clone.stencilWrite = false;
  return clone;
}

/**
 * Can a fade clone of `source` be made ahead? Not for shader materials:
 * copy() replaces their `uniforms` object, while three keeps using the one
 * it was initialized with — the ready clone would draw stale values.
 */
function canPrepare(source: THREE.Material): boolean {
  const s = source as THREE.Material & { isShaderMaterial?: boolean; isRawShaderMaterial?: boolean; isNodeMaterial?: boolean };
  return !s.isShaderMaterial && !s.isRawShaderMaterial && !s.isNodeMaterial;
}

/**
 * PERF — a fade clone of an OPAQUE source (opacity 1, writes depth) is
 * transparent only so that the dissolve never recompiles: until its fade it
 * looks exactly opaque. three.js still drew every transparent double-sided
 * piece TWICE (back faces, then front faces — and re-selected the program
 * for each pass): for a fully opaque, depth-writing surface the nearest
 * fragment wins either way, so one double-sided pass gives the same image
 * for half the draws. The fade (blended, no depth write) restores the
 * source's setting. Already-translucent sources (glass) keep two passes.
 */
function singlePassWhileOpaque(source: THREE.Material): boolean {
  if (source.forceSinglePass) return true;
  return !source.transparent && source.opacity >= 1 && source.depthWrite && source.blending === THREE.NormalBlending;
}
