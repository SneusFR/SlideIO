import type { Box3, Vector3 } from "three";
import type { HexSniperController } from "./HexSniperController";

/**
 * Type surface of the vendored HexSniper GAMEPLAY state machine
 * (HexSniperAttacks.js, shipped with the kit — kept as plain JS).
 *
 * Runs on the simulation authority. All positions are WORLD-space meters;
 * all callbacks are synchronous physics queries. There is NO maximum tongue
 * distance and NO flight timeout: the only limits are the first collision
 * and the real map bounds reported by `distanceToMapExit`.
 */

/** First contact of the swept tongue segment (tip position ON the segment). */
export interface HexSniperSweepHit {
  point: Vector3;
  /** "player" grabs and pulls; anything else triggers an empty return. */
  kind?: string;
  playerId?: number | string | null;
  [extra: string]: unknown;
}

/** One target inside the bite volume (id must be stable for dedup). */
export interface HexSniperBiteHit {
  id: number | string;
  kind?: string;
  playerId?: number | string;
  [extra: string]: unknown;
}

export interface HexSniperMoveResult {
  reached?: boolean;
  blocked?: boolean;
  valid?: boolean;
}

/** The five physics callbacks the game must provide (see the kit guide). */
export interface HexSniperWorldApi {
  /** Distance to the first exit of the REAL map bounds (0 = already out,
   *  Infinity = this direction never leaves). Never a fixed weapon range. */
  distanceToMapExit(point: Vector3, direction: Vector3, radius: number): number;
  /** Sweep the traveled segment with the tongue radius; first hit of ANY
   *  kind stops the flight. `point` = tip position at impact, on segment. */
  sweepTongue(
    from: Vector3,
    to: Vector3,
    options: { ownerId: number | string; radius: number },
  ): HexSniperSweepHit | null;
  /** Write the target's WORLD position; false = dead/despawned (release). */
  getPlayerPosition(id: number | string, out: Vector3): boolean;
  /** Physically drag the grabbed player toward `destination`.
   *  `maxDistance` is the displacement of ONE physics step — never a range.
   *  Must move through the player's own collider (never through walls). */
  movePlayerToward(
    id: number | string,
    destination: Vector3,
    options: { maxDistance: number; stopDistance: number; ownerId: number | string },
  ): HexSniperMoveResult;
  /** Targets inside the short bite volume, with wall occlusion applied. */
  queryBite(query: {
    origin: Vector3;
    direction: Vector3;
    range: number;
    radius: number;
    ownerId: number | string;
    attackId: number;
    pulse: number;
  }): HexSniperBiteHit[];
}

export interface HexSniperEvent {
  type: string;
  attackId: number;
  state: string;
  hit?: HexSniperBiteHit;
  playerId?: number | string;
  point?: Vector3;
  pulse?: number;
  reason?: string;
}

export class HexSniperAttacks {
  constructor(options: {
    world: HexSniperWorldApi;
    pose: {
      origin(out: Vector3): void;
      direction(out: Vector3): void;
      pullDestination(out: Vector3): void;
    };
    visuals?: HexSniperController | null;
    ownerId: number | string;
    onEvent?: (event: HexSniperEvent) => void;
    projectileSpeed?: number;
    returnSpeed?: number;
    pullSpeed?: number;
    tongueRadius?: number;
    pullStopDistance?: number;
    biteRange?: number;
    biteRadius?: number;
    /** Keep 29/30 and 10/30 with the shipped clips (bite windows depend). */
    biteDuration?: number;
    recoverDuration?: number;
  });
  /** Idle / Extending / Pulling / Retracting / Recovering / Biting. */
  state: string;
  attackId: number;
  /** Current WORLD tongue-tip position (replicate to clients when networked). */
  readonly tip: Vector3;
  disposed: boolean;
  /** Left click. False when busy — one attack at a time, no auto-repeat. */
  tryTongue(): boolean;
  /** Right click. Two dedup'd contact windows — never per-frame damage. */
  tryBite(): boolean;
  /** Advance the simulation — call once per PHYSICS step (seconds). */
  update(dt: number): void;
  /**
   * NETWORK (SlideIO addition): an external authority confirmed a grab on
   * `playerId` — latch the tongue on it (Extending / Pulling only). Fires
   * `tongue-player`. False when impossible (idle, unknown target…).
   */
  latchOn(playerId: number | string): boolean;
  /**
   * NETWORK (SlideIO addition): an external authority ended the flight /
   * pull WITHOUT a bite — empty return from the current tip. False unless
   * Extending / Pulling.
   */
  release(reason?: string): boolean;
  /** Death / unequip / stun: release without moving the target. */
  cancel(reason?: string): void;
  dispose(): void;
}

/** Ray exit from an axis-aligned map box, reduced by the tongue radius. */
export function distanceToBoxExit(
  point: Vector3,
  direction: Vector3,
  box: Box3,
  radius?: number,
): number;
