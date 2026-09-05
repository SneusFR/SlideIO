import type { AnimationMixer, Object3D } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Type surface of the vendored PulseCarbine animation controller
 * (PulseCarbineController.js, shipped with the asset — kept as plain JS).
 *
 * The controller owns the SINGLE AnimationMixer driving the weapon's
 * screen bars + piano keys (clips Idle / Fire / Fire_AltA / Fire_AltB /
 * MusicLoop) — never attach a second mixer to the same objects.
 */
export class PulseCarbineController {
  constructor(gltf: GLTF);
  /** SkeletonUtils clone of the GLB scene — add THIS to the scene graph. */
  readonly object: Object3D;
  readonly mixer: AnimationMixer;
  /** Attachment sockets resolved on the clone (undefined if absent). */
  readonly muzzle: Object3D | undefined;
  readonly grip: Object3D | undefined;
  readonly offhand: Object3D | undefined;
  /** Call once for every shot ACCEPTED by the game (each auto-fire round). */
  onFire(): void;
  /** true = continuous equalizer preview loop; false = animate on shots. */
  setMusic(enabled: boolean): void;
  /** Advance the mixer — call exactly once per frame, in seconds. */
  update(deltaSeconds: number): void;
  /** Stop animating THIS instance; shared GPU resources stay cached. */
  dispose(): void;
}
