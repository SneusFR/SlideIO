import { NetworkMovementState } from "../NetworkMovementState";
import { RemoteInterpolationConfig as cfg } from "./RemoteInterpolationConfig";

/** One received network state of a remote player (server-time stamped). */
export interface PlayerSnapshot {
  /** Server time (ms) at which the server accepted this transform. */
  timestamp: number;
  /** Client transform sequence (monotonic — stale packets are rejected). */
  sequence: number;

  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;

  velocityX: number;
  velocityY: number;
  velocityZ: number;

  movementState: NetworkMovementState;

  /** True when this snapshot is a teleport w.r.t. the previous one. */
  teleport: boolean;
}

/** Result of sampling the buffer at a given render time (reused object). */
export interface SampledPlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  movementState: NetworkMovementState;
  /** True when the pair crossed the teleport threshold → caller must SNAP. */
  teleported: boolean;
  /** True while estimating past the newest snapshot (short window only). */
  extrapolating: boolean;
}

/**
 * Small time-ordered buffer of the latest snapshots of ONE remote player.
 *
 * Render-time sampling:
 *   renderTime = estimatedServerTime - interpolationDelay
 *   → find the two snapshots bracketing renderTime → interpolate.
 *   → no future snapshot? extrapolate briefly with the last velocity, then freeze.
 *
 * Snapshot objects are POOLED — steady state allocates nothing per packet
 * or per frame (browser FPS: GC pressure matters).
 */
export class SnapshotBuffer {
  private readonly snapshots: PlayerSnapshot[] = [];
  private readonly pool: PlayerSnapshot[] = [];
  private lastSequence = -1;

  get count(): number {
    return this.snapshots.length;
  }

  get newest(): PlayerSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /**
   * Store a new network state. STALE snapshots (sequence/timestamp not newer
   * than the latest stored one) are ignored — the player never moves back
   * in time because a late packet arrived after a fresher one.
   */
  push(
    timestamp: number,
    sequence: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    movementState: NetworkMovementState,
  ): void {
    if (sequence <= this.lastSequence) return; // stale/out-of-order → ignore
    const prev = this.newest;
    if (prev && timestamp <= prev.timestamp) return; // non-monotonic time → ignore

    this.lastSequence = sequence;

    const snap = this.pool.pop() ?? createSnapshot();
    snap.timestamp = timestamp;
    snap.sequence = sequence;
    snap.x = x;
    snap.y = y;
    snap.z = z;
    snap.yaw = yaw;
    snap.pitch = pitch;
    snap.velocityX = velocityX;
    snap.velocityY = velocityY;
    snap.velocityZ = velocityZ;
    snap.movementState = movementState;
    // Teleport detection at ingestion: respawn / phase traversal / anomaly.
    snap.teleport = prev
      ? distSq(prev.x, prev.y, prev.z, x, y, z) > cfg.teleportThreshold * cfg.teleportThreshold
      : false;

    this.snapshots.push(snap);

    // Bounded memory: hard count cap (age-based pruning happens in sample()).
    while (this.snapshots.length > cfg.snapshotMaxCount) {
      this.pool.push(this.snapshots.shift()!);
    }
  }

  /**
   * Sample the interpolated state at `renderTime` (server-time ms).
   * Returns false when the buffer is empty (nothing to display yet).
   */
  sample(renderTime: number, out: SampledPlayerState): boolean {
    const snaps = this.snapshots;
    if (snaps.length === 0) return false;

    // Prune history: keep exactly one snapshot at/before renderTime (the
    // "before" of the pair) — anything older is garbage. Also drop by age.
    while (
      snaps.length >= 2 &&
      (snaps[1].timestamp <= renderTime ||
        snaps[0].timestamp < renderTime - cfg.snapshotMaxAgeMs)
    ) {
      this.pool.push(snaps.shift()!);
    }

    const first = snaps[0];

    // Case 1 — render time is before our oldest data: hold the oldest state
    // (brief warm-up right after a spawn/join).
    if (renderTime <= first.timestamp) {
      copySnapshot(first, out);
      out.teleported = first.teleport;
      out.extrapolating = false;
      return true;
    }

    const last = snaps[snaps.length - 1];

    // Case 2 — a future snapshot exists: interpolate inside the pair.
    if (renderTime < last.timestamp && snaps.length >= 2) {
      const before = snaps[0];
      const after = snaps[1];

      // Teleport pair: never lerp across the map — snap to the new state.
      if (after.teleport) {
        copySnapshot(after, out);
        out.teleported = true;
        out.extrapolating = false;
        return true;
      }

      const span = after.timestamp - before.timestamp;
      const t = span > 0 ? (renderTime - before.timestamp) / span : 1;

      out.x = before.x + (after.x - before.x) * t;
      out.y = before.y + (after.y - before.y) * t;
      out.z = before.z + (after.z - before.z) * t;
      // Angular interpolation via the SHORTEST arc (359° → 1° turns 2°, not 358°).
      out.yaw = before.yaw + shortestAngleDelta(before.yaw, after.yaw) * t;
      out.pitch = before.pitch + shortestAngleDelta(before.pitch, after.pitch) * t;
      out.velocityX = before.velocityX + (after.velocityX - before.velocityX) * t;
      out.velocityY = before.velocityY + (after.velocityY - before.velocityY) * t;
      out.velocityZ = before.velocityZ + (after.velocityZ - before.velocityZ) * t;
      // State comes from the newer snapshot: slides/dashes show up ASAP.
      out.movementState = after.movementState;
      out.teleported = false;
      out.extrapolating = false;
      return true;
    }

    // Case 3 — no future snapshot (delay / loss / jitter): SHORT velocity
    // extrapolation, then freeze at the limit. Never runs away forever.
    const aheadMs = renderTime - last.timestamp;
    const clampedMs = Math.min(aheadMs, cfg.maxExtrapolationMs);
    const dt = clampedMs / 1000;

    // Once the extrapolation window is exhausted the avatar is FROZEN —
    // report ZERO velocity so run animations stop scaling with a stale
    // speed, and after a longer stale window fall back to IDLE entirely
    // (a silent sender must never leave its ghost sprinting on the spot).
    const frozen = aheadMs >= cfg.maxExtrapolationMs;
    const stale = aheadMs >= cfg.staleStateFallbackMs;

    out.x = last.x + last.velocityX * dt;
    out.y = last.y + last.velocityY * dt;
    out.z = last.z + last.velocityZ * dt;
    out.yaw = last.yaw;
    out.pitch = last.pitch;
    out.velocityX = frozen ? 0 : last.velocityX;
    out.velocityY = frozen ? 0 : last.velocityY;
    out.velocityZ = frozen ? 0 : last.velocityZ;
    out.movementState = stale ? NetworkMovementState.IDLE : last.movementState;
    out.teleported = false;
    out.extrapolating = aheadMs > 1 && clampedMs > 1;
    return true;
  }

  clear(): void {
    while (this.snapshots.length > 0) this.pool.push(this.snapshots.pop()!);
    this.lastSequence = -1;
  }
}

/** Shortest signed angle from `from` to `to` (radians, handles wrap). */
export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function createSnapshot(): PlayerSnapshot {
  return {
    timestamp: 0,
    sequence: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    movementState: NetworkMovementState.IDLE,
    teleport: false,
  };
}

function copySnapshot(s: PlayerSnapshot, out: SampledPlayerState): void {
  out.x = s.x;
  out.y = s.y;
  out.z = s.z;
  out.yaw = s.yaw;
  out.pitch = s.pitch;
  out.velocityX = s.velocityX;
  out.velocityY = s.velocityY;
  out.velocityZ = s.velocityZ;
  out.movementState = s.movementState;
}

function distSq(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return dx * dx + dy * dy + dz * dz;
}