import type { AnimationMixer, Mesh, Object3D, Vector3 } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Type surface of the vendored HexSniper VISUAL controller
 * (HexSniperController.js, shipped with the kit — kept as plain JS).
 *
 * Visuals ONLY: the controller owns the single AnimationMixer of the clip
 * set (Idle / Fire / Tongue_Cast / Tongue_Hold / Tongue_Return / Bite) and
 * stretches the Tongue_Tether mesh (reparented into `effectsParent`, i.e.
 * the WORLD scene) between the creature's mouth and a world-space endpoint.
 * The game owns collision, player movement and damage (HexSniperAttacks).
 * Never attach a second mixer to the same bones.
 */
export class HexSniperController {
  constructor(
    gltf: GLTF,
    options?: { effectsParent?: Object3D | null; tongueWidthScale?: number },
  );
  /** SkeletonUtils clone of the GLB scene — add THIS to the weapon holder. */
  readonly object: Object3D;
  readonly mixer: AnimationMixer;
  /** Sockets resolved on the clone (undefined when absent from the GLB). */
  readonly muzzle: Object3D | undefined;
  readonly tongueOrigin: Object3D | undefined;
  readonly biteOrigin: Object3D | undefined;
  readonly grip: Object3D | undefined;
  readonly offhand: Object3D | undefined;
  readonly scope: Object3D | undefined;
  /** The stretched attack mesh (reparented into `effectsParent`). */
  readonly tether: Mesh;
  /** Current visual state (Idle / Tongue_Cast / Tongue_Hold / …). */
  state: string;
  /**
   * Optional resolver for the tether's WORLD start point. The tether lives
   * in the world scene while the weapon is drawn by a separate FP
   * camera/projection: return the world point that lands under the
   * rendered `socket` (default: the socket's raw world position).
   */
  tetherStartResolver: ((socket: Object3D, out: Vector3) => Vector3) | null;
  /** Tongue launched: hides Tongue_Idle, shows the stretched tether. */
  beginTongue(point?: Vector3 | null): void;
  /** Move the tether tip to a WORLD-space point (call as the tip flies). */
  setTongueEndpoint(point: Vector3): void;
  /** A player was grabbed (Tongue_Hold loop). */
  beginPull(): void;
  /** Empty return started (kept on Tongue_Hold while the tip flies back). */
  beginReturn(): void;
  /** Tip is back at the mouth: play Tongue_Return, restore Tongue_Idle. */
  endTongue(): void;
  /** Right-click bite (clip Bite — snaps + head shakes). */
  bite(): void;
  /** Hard reset to Idle (cancel path). */
  reset(): void;
  /**
   * Affectionate inspection (clip Inspect_Affection, 5.3 s, one-shot,
   * integration pack). Visuals only — animates the visual Tongue_Idle,
   * never the Tongue_Tether attack mesh, no gameplay events. Only from
   * Idle; returns true when started (the caller starts the FP arms
   * inspect clip the SAME frame — same clock, same progression).
   */
  beginInspect(): boolean;
  /**
   * Cancel a running inspection: back to Idle (combat pose). Default = a
   * short fade; `immediate` stops Inspect + its fade for real, puts Idle at
   * full weight and evaluates the mixer/world matrices right away (fire
   * interrupting the inspection — sockets are read the same frame).
   */
  cancelInspect(options?: { immediate?: boolean }): void;
  /** Legacy cosmetic reaction; gameplay uses HexSniperAttacks.tryTongue(). */
  onFire(): void;
  /** Advance the mixer + tether — call exactly once per RENDER frame. */
  update(dt: number): void;
  /** Free per-instance resources; shared cached GLB resources stay. */
  dispose(): void;
}
