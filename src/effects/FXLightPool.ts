import * as THREE from "three";

/**
 * Shared pool of a FIXED number of scene point lights for every weapon /
 * impact VFX.
 *
 * WHY: each VFX used to own a PERMANENT PointLight (intensity 0 while
 * idle) because adding/removing a light at runtime changes the scene
 * light count and forces three.js to recompile every lit material — a
 * visible freeze. That kept ~12 point lights in the scene at all times,
 * and three.js forward lighting evaluates EVERY light per pixel in every
 * lit shader, lit or not — an identical GPU cost on LOW and HIGH that
 * dominated the frame on integrated GPUs.
 *
 * HOW: the pool owns POOL_SIZE lights created once and NEVER
 * added/removed (the anti-recompilation constraint is preserved — the
 * light count is constant, just much smaller). Effects use an
 * IMMEDIATE-MODE API: every frame an effect wants light, it calls
 * request() with its world position/color/intensity; commit() (called by
 * the Game right before rendering) assigns the highest-priority requests
 * to the physical lights and zeroes the rest. No acquire/release
 * lifecycle → nothing can leak or go stale; an unserved request simply
 * means the two brightest effects won this frame.
 */

/** Physical lights in the world scene — the per-pixel loop length. */
const POOL_SIZE = 2;
/** Pre-allocated request slots (grown on demand, never per-frame). */
const INITIAL_SLOTS = 8;

interface LightRequest {
  color: THREE.Color;
  intensity: number;
  distance: number;
  decay: number;
  position: THREE.Vector3;
  priority: number;
}

function makeSlot(): LightRequest {
  return {
    color: new THREE.Color(),
    intensity: 0,
    distance: 0,
    decay: 2,
    position: new THREE.Vector3(),
    priority: 0,
  };
}

class FXLightPool {
  private scene: THREE.Scene | null = null;
  private readonly lights: THREE.PointLight[] = [];
  private readonly slots: LightRequest[] = [];
  private requestCount = 0;
  /** Scratch: slot indices already assigned this commit. */
  private readonly taken: boolean[] = [];

  /**
   * Attach the pooled lights to the (new) world scene. Called once per
   * Game instance, BEFORE any weapon/VFX is constructed, so the light
   * count never changes afterwards.
   */
  init(scene: THREE.Scene): void {
    if (this.lights.length === 0) {
      for (let i = 0; i < POOL_SIZE; i++) {
        this.lights.push(new THREE.PointLight(0xffffff, 0, 1, 2));
      }
      for (let i = 0; i < INITIAL_SLOTS; i++) this.slots.push(makeSlot());
    }
    if (this.scene === scene) return;
    if (this.scene) for (const l of this.lights) this.scene.remove(l);
    for (const l of this.lights) {
      l.intensity = 0;
      scene.add(l);
    }
    this.scene = scene;
    this.requestCount = 0;
  }

  /**
   * Ask for light THIS FRAME at a world position. Call every frame the
   * effect is active — nothing persists across commits.
   * @param priority ties are broken by call order; defaults to intensity
   *                 so the brightest effects naturally win the pool.
   */
  request(
    color: THREE.Color | number,
    intensity: number,
    distance: number,
    decay: number,
    position: THREE.Vector3,
    priority = intensity,
  ): void {
    if (intensity <= 0) return;
    if (this.requestCount === this.slots.length) this.slots.push(makeSlot());
    const slot = this.slots[this.requestCount++];
    slot.color.set(color);
    slot.intensity = intensity;
    slot.distance = distance;
    slot.decay = decay;
    slot.position.copy(position);
    slot.priority = priority;
  }

  /**
   * Assign the POOL_SIZE highest-priority requests to the physical
   * lights, zero the rest, and clear the request list. Called once per
   * frame by the Game, after every VFX update and before rendering.
   */
  commit(): void {
    const n = this.requestCount;
    for (let i = 0; i < n; i++) this.taken[i] = false;

    for (const light of this.lights) {
      // Selection without sorting (n is tiny): best untaken request.
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (this.taken[i]) continue;
        if (best === -1 || this.slots[i].priority > this.slots[best].priority) {
          best = i;
        }
      }
      if (best === -1) {
        light.intensity = 0;
        continue;
      }
      this.taken[best] = true;
      const req = this.slots[best];
      light.color.copy(req.color);
      light.intensity = req.intensity;
      light.distance = req.distance;
      light.decay = req.decay;
      light.position.copy(req.position);
    }
    this.requestCount = 0;
  }
}

/** The single world-scene FX light pool (init'd by the Game). */
export const fxLights = new FXLightPool();
