import type * as THREE from "three";
import {
  loadGoofyBasketSkins,
  type BasketSkinContext,
  type BasketSkinHandle,
  type BasketSkinLibrary,
  type BasketSkinQuality,
} from "./skins/runtime/GoofyBasketSkins";
import { DEFAULT_WEAPON_SKIN, isGoofyBasketSkinId } from "../../../shared/combat/WeaponSkins";

/**
 * Session-wide GoofyBasket skin runtime.
 *
 * ONE skin library (five shared textures) for the whole client, loaded
 * exactly once and shared between every ball owner (FP viewmodel, remote
 * TP balls, world projectiles, menu previews / icons). A texture failure
 * is logged once and every ball simply stays the base ball — gameplay is
 * never blocked by cosmetics.
 *
 * `GoofyBasketSkinSlot` is the per-INSTANCE adapter every owner uses: it
 * applies a skin to a cloned ball (never the shared GLB template), waits
 * for the library when a skin is requested before the textures are ready,
 * keeps the handle updated from the owner's existing loop, and restores
 * the original materials on dispose (handle.dispose only frees the
 * instance's private clones — the library keeps its textures).
 */

let libraryPromise: Promise<BasketSkinLibrary | null> | null = null;
let libraryNow: BasketSkinLibrary | null = null;

/** Shared library promise (null when the textures failed — base ball kept). */
export function getGoofyBasketSkinLibrary(): Promise<BasketSkinLibrary | null> {
  if (libraryPromise) return libraryPromise;
  libraryPromise = loadGoofyBasketSkins()
    .then((library) => {
      libraryNow = library;
      return library;
    })
    .catch((err: unknown) => {
      console.error("GoofyBasket skins: texture load failed — base ball kept", err);
      return null;
    });
  return libraryPromise;
}

/** Synchronous access once loaded (null before / on failure). */
export function getGoofyBasketSkinLibraryNow(): BasketSkinLibrary | null {
  return libraryNow;
}

/** Full session shutdown only: every instance restored, shared textures freed. */
export function disposeGoofyBasketSkinLibrary(): void {
  libraryNow?.dispose();
  libraryNow = null;
  libraryPromise = null;
}

export interface GoofyBasketSkinSlotOptions {
  context: BasketSkinContext;
  quality: BasketSkinQuality;
  seed?: number;
}

/** Per-frame cosmetic state handed by the owner (mirrors BasketSkinFrame). */
export interface GoofyBasketSkinFrame {
  /** Normalized charge 0..1 (cosmetic only). */
  charge: number;
  /** EXACT visibility of the owner's ball (aura hidden with it). */
  visible: boolean;
  /** Aura budget switch (distance / occlusion) — materials stay applied. */
  effectsEnabled: boolean;
}

export class GoofyBasketSkinSlot {
  private target: THREE.Object3D | null = null;
  private handle: BasketSkinHandle | null = null;
  private wanted: string = DEFAULT_WEAPON_SKIN;
  private quality: BasketSkinQuality;
  private readonly context: BasketSkinContext;
  private readonly seed: number;
  private disposed = false;
  /** Async apply guard: only the latest request may land. */
  private requestToken = 0;

  constructor(options: GoofyBasketSkinSlotOptions) {
    this.context = options.context;
    this.quality = options.quality;
    this.seed = options.seed ?? (seedCounter++ * 7.31) % 1024;
  }

  /** Currently REQUESTED skin id ("default" = base materials). */
  get skinId(): string {
    return this.wanted;
  }

  /** True while a pack skin is actually applied on the target. */
  get applied(): boolean {
    return this.handle !== null && !this.handle.disposed;
  }

  /**
   * Bind the ball INSTANCE this slot dresses. Re-binding (new clone after
   * a respawn / re-attach) restores the previous instance first, then
   * re-applies the wanted skin on the new one.
   */
  setTarget(ball: THREE.Object3D | null): void {
    if (this.target === ball) return;
    this.releaseHandle();
    this.target = ball;
    this.refresh();
  }

  /** Request a skin id (validated: unknown ids fall back to the base ball). */
  setSkin(skinId: string): void {
    const valid = isGoofyBasketSkinId(skinId) ? skinId : DEFAULT_WEAPON_SKIN;
    if (valid === this.wanted) return;
    this.wanted = valid;
    this.refresh();
  }

  /** Change the FX quality (re-applies the same skin with a fresh handle). */
  setQuality(quality: BasketSkinQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    if (this.handle) {
      this.releaseHandle();
      this.refresh();
    }
  }

  /** Owner's per-frame hook (the owner's OWN loop — never a new one). */
  update(elapsedSeconds: number, frame: GoofyBasketSkinFrame): void {
    if (!this.handle || this.handle.disposed) return;
    this.handle.update(elapsedSeconds, frame);
  }

  /** Restore the original materials and free this instance's private resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestToken++;
    this.releaseHandle();
    this.target = null;
  }

  // ------------------------------------------------------------------

  private releaseHandle(): void {
    if (!this.handle) return;
    if (!this.handle.disposed) this.handle.dispose();
    this.handle = null;
  }

  /** Reconcile (target, wanted, quality) → the applied handle. */
  private refresh(): void {
    if (this.disposed) return;
    const token = ++this.requestToken;
    if (!this.target || this.wanted === DEFAULT_WEAPON_SKIN) {
      this.releaseHandle();
      return;
    }
    const library = libraryNow;
    if (library) {
      this.applyNow(library);
      return;
    }
    // Skin requested before the textures are ready: apply when they land
    // (the request is dropped if the skin / target changed meanwhile).
    void getGoofyBasketSkinLibrary().then((lib) => {
      if (!lib || token !== this.requestToken || this.disposed) return;
      this.applyNow(lib);
    });
  }

  private applyNow(library: BasketSkinLibrary): void {
    if (!this.target || library.disposed || !isGoofyBasketSkinId(this.wanted)) return;
    if (this.handle && !this.handle.disposed && this.handle.id === this.wanted && this.handle.target === this.target) return;
    this.releaseHandle();
    try {
      this.handle = library.apply(this.target, this.wanted, {
        context: this.context,
        quality: this.quality,
        seed: this.seed,
      });
    } catch (err) {
      console.error(`GoofyBasket skins: apply "${this.wanted}" failed — base ball kept`, err);
      this.handle = null;
    }
  }
}


let seedCounter = 1;
