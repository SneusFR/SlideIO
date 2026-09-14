import * as THREE from "three";
import {
  loadAstronautCosmetics,
  ASTRONAUT_SLOTS,
  type AstronautContext,
  type AstronautHandle,
  type AstronautLibrary,
  type AstronautSlot,
} from "./runtime/AstronautCosmetics";
import {
  CHARACTER_COSMETIC_SLOTS,
  encodeCharacterCosmetics,
  isCharacterCosmeticId,
  type CharacterCosmeticsSelection,
} from "../../../shared/combat/CharacterCosmetics";
import { getEnemyOutlineMaterial } from "../../characters/PotatoCharacter";
import { CombatConfig as cc } from "../../combat/CombatConfig";

/**
 * Session-wide Potato Astronaut outfit runtime.
 *
 * ONE library (four GLBs + masks.json) for the whole client, loaded exactly
 * once and shared by every character owner: remote avatars, bots, the FP
 * arms and the Customize preview. A load failure is logged once and every
 * character simply keeps its base look — gameplay is never blocked by
 * cosmetics. The library is NEVER disposed while the page lives: its
 * geometries stay shared with corpse snapshots that outlive their avatar.
 *
 * `CharacterOutfitSlot` is the per-INSTANCE adapter: it maps the validated
 * cosmetic selection (shared contract ids) to the pack's slots, applies it
 * on a cloned character (never the shared template), waits for the library
 * when a selection lands before the assets are ready, caches the applied
 * selection so network snapshots / frames never re-apply, keeps the
 * PREVIOUS outfit when a new one fails validation, and hooks the game's
 * presentation rules (enemy outline hulls, stencil occlusion, bot flash
 * registration, corpse material lifecycle) through `onMeshAdded`.
 */

let libraryPromise: Promise<AstronautLibrary | null> | null = null;
let libraryNow: AstronautLibrary | null = null;

/** Shared library promise (null when the pack failed to load — base look kept). */
export function getAstronautLibrary(): Promise<AstronautLibrary | null> {
  if (libraryPromise) return libraryPromise;
  libraryPromise = loadAstronautCosmetics()
    .then((library) => {
      libraryNow = library;
      return library;
    })
    .catch((err: unknown) => {
      console.error("Astronaut outfit: pack failed to load — base character kept", err);
      return null;
    });
  return libraryPromise;
}

/** Synchronous access once loaded (null before / on failure). */
export function getAstronautLibraryNow(): AstronautLibrary | null {
  return libraryNow;
}

/**
 * Shared-contract selection → pack slots. Every whitelisted id of a slot is
 * a piece of this pack today (the only outfit); unknown ids never reach here
 * (validated at load / decode time) but are ignored defensively anyway.
 */
export function astronautSlotsOf(selection: CharacterCosmeticsSelection): AstronautSlot[] {
  const out: AstronautSlot[] = [];
  for (const slot of CHARACTER_COSMETIC_SLOTS) {
    const id = selection[slot];
    if (id && isCharacterCosmeticId(slot, id) && id.startsWith("astronaut_")) out.push(slot);
  }
  return out;
}

/** The full outfit (every pack slot) — warm-ups and previews. */
export const FULL_ASTRONAUT_SELECTION: CharacterCosmeticsSelection = {
  hats: "astronaut_helmet",
  bags: "astronaut_backpack",
  tops: "astronaut_top",
  pants: "astronaut_pants",
  shoes: "astronaut_shoes",
};

export interface CharacterOutfitSlotOptions {
  context: AstronautContext;
  /**
   * Build a red enemy-contour hull for every OPAQUE added piece (TP enemy
   * avatars). Hulls share the piece's geometry / skeleton, are tagged
   * `userData.enemyOutline` (corpse stripping, bot LOS toggling) and are
   * removed with the handle.
   */
  outline?: boolean;
  /** Initial visibility of the created hulls (bots: line-of-sight state). */
  outlineVisible?: () => boolean;
  /** A hull was created — return a cleanup (bots: unregister from their list). */
  onHullAdded?: (hull: THREE.Mesh) => void | (() => void);
  /**
   * The private materials of an added piece — return a cleanup (bots:
   * unregister from the damage-flash list BEFORE the handle disposes them).
   */
  onMaterialsAdded?: (materials: THREE.Material[]) => void | (() => void);
}

export class CharacterOutfitSlot {
  private target: THREE.Object3D | null = null;
  private handle: AstronautHandle | null = null;
  private wanted: CharacterCosmeticsSelection = {};
  private wantedKey = "";
  /** Encoded selection ACTUALLY applied on the current target ("" = base look). */
  private appliedKey = "";
  private disposed = false;
  /** Async apply guard: only the latest request may land. */
  private requestToken = 0;

  constructor(private readonly options: CharacterOutfitSlotOptions) {}

  /** True while a pack outfit is actually applied on the target. */
  get applied(): boolean {
    return this.handle !== null && !this.handle.disposed;
  }

  /** Encoded selection currently REQUESTED. */
  get selectionKey(): string {
    return this.wantedKey;
  }

  /**
   * Bind the character INSTANCE this slot dresses (the clone holding the
   * meshes AND the bones). Re-binding restores the previous instance first,
   * then re-applies the wanted outfit on the new one.
   */
  setTarget(target: THREE.Object3D | null): void {
    if (this.target === target) return;
    this.releaseHandle();
    this.target = target;
    this.refresh();
  }

  /** Request a (validated) selection; unchanged selections are a no-op. */
  setSelection(selection: CharacterCosmeticsSelection): void {
    const key = encodeCharacterCosmetics(selection);
    if (key === this.wantedKey) return;
    this.wanted = { ...selection };
    this.wantedKey = key;
    this.refresh();
  }

  /** Restore the base character and free this instance's private resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestToken++;
    this.releaseHandle();
    this.target = null;
  }

  // ------------------------------------------------------------------

  private releaseHandle(): void {
    if (this.handle && !this.handle.disposed) this.handle.dispose();
    this.handle = null;
    this.appliedKey = "";
  }

  /** Reconcile (target, wanted) → the applied handle. */
  private refresh(): void {
    if (this.disposed) return;
    const token = ++this.requestToken;
    if (!this.target || astronautSlotsOf(this.wanted).length === 0) {
      this.releaseHandle();
      return;
    }
    if (libraryNow) {
      this.applyNow(libraryNow);
      return;
    }
    // Selection received before the assets are ready: apply when they land
    // (dropped if the target / selection changed or the owner was removed).
    void getAstronautLibrary().then((library) => {
      if (!library || token !== this.requestToken || this.disposed) return;
      this.applyNow(library);
    });
  }

  private applyNow(library: AstronautLibrary): void {
    const target = this.target;
    if (!target || library.disposed) return;
    if (this.handle && !this.handle.disposed && this.appliedKey === this.wantedKey) return;
    const slots = astronautSlotsOf(this.wanted);
    try {
      // library.apply is TRANSACTIONAL: the previous handle on this target
      // is replaced only after the new outfit fully validated; on failure
      // the previous outfit stays applied and we keep referencing it.
      this.handle = library.apply(target, slots, {
        context: this.options.context,
        onMeshAdded: (mesh, slot) => this.onMeshAdded(mesh, slot),
      });
      this.appliedKey = this.wantedKey;
    } catch (err) {
      console.error(`Astronaut outfit: apply "${this.wantedKey}" failed — previous look kept`, err);
    }
  }

  /**
   * Presentation hooks for one added piece (clothes + rigid accessories):
   *   - private materials are marked EPHEMERAL for the CorpseManager pool
   *     (bounded lifecycle: their fade clones are evicted once unused);
   *   - opaque pieces become enemy-outline stencil OCCLUDERS like the body
   *     (the transparent visor never writes the stencil: the face and the
   *     contour behind the glass stay readable);
   *   - an inverted-hull outline follows opaque pieces when requested.
   */
  private onMeshAdded(mesh: THREE.Mesh, _slot: AstronautSlot): void | (() => void) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cleanups: (() => void)[] = [];
    let opaque = true;
    for (const mat of materials) {
      mat.userData.corpsePoolEphemeral = true;
      if (mat.transparent) {
        opaque = false;
        continue;
      }
      if (this.options.context === "tp") {
        mat.stencilWrite = true;
        mat.stencilRef = 1;
        mat.stencilFunc = THREE.AlwaysStencilFunc;
        mat.stencilZPass = THREE.ReplaceStencilOp;
      }
    }
    const materialCleanup = this.options.onMaterialsAdded?.(materials);
    if (materialCleanup) cleanups.push(materialCleanup);

    if (this.options.outline && opaque && this.options.context === "tp") {
      const hull = buildOutlineHull(mesh);
      hull.visible = (this.options.outlineVisible?.() ?? true) && cc.enemyOutlineEnabled;
      // Skinned pieces are siblings of the body (same parent, same
      // skeleton); rigid pieces get the hull as a child at identity.
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.parent!.add(hull);
      else mesh.add(hull);
      const hullCleanup = this.options.onHullAdded?.(hull);
      cleanups.push(() => {
        hullCleanup?.();
        hull.removeFromParent();
      });
    }
    if (cleanups.length === 0) return;
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }
}

/**
 * Enemy contour hull of one outfit piece — same shared stencil-tested
 * material and render order as the body hulls built on the template
 * (PotatoCharacter). Skinned pieces bind the hull to the SAME live skeleton
 * / bindMatrix; rigid pieces ride their socket through the parent chain.
 */
function buildOutlineHull(source: THREE.Mesh): THREE.Mesh {
  let hull: THREE.Mesh;
  if ((source as THREE.SkinnedMesh).isSkinnedMesh) {
    const skinned = source as THREE.SkinnedMesh;
    const h = new THREE.SkinnedMesh(skinned.geometry, getEnemyOutlineMaterial());
    h.position.copy(skinned.position);
    h.quaternion.copy(skinned.quaternion);
    h.scale.copy(skinned.scale);
    h.matrixAutoUpdate = skinned.matrixAutoUpdate;
    h.matrix.copy(skinned.matrix);
    h.bindMode = skinned.bindMode;
    h.bind(skinned.skeleton, skinned.bindMatrix);
    hull = h;
  } else {
    hull = new THREE.Mesh(source.geometry, getEnemyOutlineMaterial());
  }
  hull.name = `${source.name}_Outline`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.frustumCulled = false;
  hull.renderOrder = 1;
  hull.userData.enemyOutline = true;
  hull.userData.astronautCosmetic = true;
  hull.raycast = () => {};
  return hull;
}

export { ASTRONAUT_SLOTS };
export type { AstronautContext, AstronautLibrary, AstronautSlot };
