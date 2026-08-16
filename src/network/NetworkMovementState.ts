import { MoveState } from "../player/PlayerMovement";

/**
 * Minimal movement state transmitted over the network (Phase 3).
 *
 * Sent as a compact uint8 — NEVER animation clip names. Each client decides
 * locally which animation clip / pose corresponds to a state.
 *
 * PHASE 3 NOTE (temporary architecture): this state is CLIENT-REPORTED by
 * the local simulation, exactly like the transform. A future
 * server-authoritative phase will compute/validate these states server-side.
 */
export enum NetworkMovementState {
  IDLE = 0,
  RUNNING = 1,
  AIRBORNE = 2,
  SLIDING = 3,
  DASHING = 4,
}

/** Speed under which a grounded player is considered IDLE (m/s). */
const IDLE_SPEED_THRESHOLD = 0.5;

/**
 * Map the rich local movement state machine onto the minimal network enum.
 * Special states collapse into the closest visual equivalent — remote
 * clients only need "what does this player LOOK like they are doing".
 */
export function toNetworkMovementState(
  state: MoveState,
  horizontalSpeed: number,
): NetworkMovementState {
  switch (state) {
    case MoveState.SLIDING:
      return NetworkMovementState.SLIDING;
    case MoveState.DASHING:
    case MoveState.SPEAR_RUSHING: // fast forward charge → dash-like visuals
      return NetworkMovementState.DASHING;
    case MoveState.AIRBORNE:
    case MoveState.WALL_SLIDING:
    case MoveState.GROUND_SLAMMING:
      return NetworkMovementState.AIRBORNE;
    case MoveState.UNDERGROUND: // burrowed: remote sees fast ground movement
    case MoveState.GROUNDED:
    default:
      return horizontalSpeed > IDLE_SPEED_THRESHOLD
        ? NetworkMovementState.RUNNING
        : NetworkMovementState.IDLE;
  }
}

/** Clamp an arbitrary network number into a valid NetworkMovementState. */
export function sanitizeNetworkMovementState(raw: number): NetworkMovementState {
  const v = Math.round(raw);
  return v >= NetworkMovementState.IDLE && v <= NetworkMovementState.DASHING
    ? (v as NetworkMovementState)
    : NetworkMovementState.IDLE;
}