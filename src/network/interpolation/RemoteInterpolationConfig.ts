/**
 * Central configuration for REMOTE PLAYER rendering (Phase 3).
 *
 * These values only affect how OTHER players are displayed. They must
 * NEVER influence the local player: local movement stays an immediate,
 * zero-latency local simulation.
 *
 * Architecture (see src/network/NETWORK_ARCHITECTURE.md):
 *   Local player  → immediate local simulation (client authority for now)
 *   Remote player → snapshot buffer → interpolation slightly in the past
 */
export const RemoteInterpolationConfig = {
  /**
   * Remote players are rendered this many milliseconds in the PAST so two
   * snapshots normally bracket the render time. At ~30 network updates/sec
   * (≈33 ms between snapshots) 70 ms still covers two intervals + jitter
   * while cutting ~30 ms of the visible remote latency (what you FEEL as
   * "he lands later on my screen").
   */
  interpolationDelayMs: 70,

  /**
   * When no future snapshot exists (packet delay/loss/jitter), extrapolate
   * with the last known velocity for at most this long, then freeze.
   * Waiting beats sending the avatar across the map.
   */
  maxExtrapolationMs: 125,

  /**
   * When NO fresh snapshot arrived for this long (sender tab hidden,
   * heavy packet loss…), the frozen avatar falls back to a clean IDLE
   * pose with zero velocity — it must never keep sprinting on the spot.
   */
  staleStateFallbackMs: 400,

  /**
   * Snapshot-to-snapshot (or estimate-to-snapshot) distance above which we
   * SNAP instead of interpolating (respawn / phase teleport / anomaly).
   * Meters. Normal gameplay at hardCap ~34 m/s × 50 ms ≈ 1.7 m; a phase
   * traversal adds up to ~3.5 m — 6 m only triggers on real teleports.
   */
  teleportThreshold: 6,

  /** Maximum age of snapshots kept in the buffer (ms). Small by design. */
  snapshotMaxAgeMs: 1000,

  /** Hard cap on stored snapshots per remote player (safety net). */
  snapshotMaxCount: 32,

  /**
   * Max vertical look applied to the remote upper body (radians).
   * The ROOT never pitches — only spine/neck/head bones, clamped.
   */
  remoteVisualPitchClamp: 0.65,

  /**
   * Sign applied when converting camera pitch (+ = looking up) into bone
   * local X rotations. Flip to 1 if the rig ends up looking inverted.
   */
  remotePitchBoneSign: -1,

  /** Smoothing rate for the procedural upper-body pitch (1/s). */
  remotePitchSmoothing: 14,

  /**
   * Dev-only red marker showing the latest RAW network position next to
   * the interpolated character (proves interpolation works). Never shown
   * in normal gameplay.
   */
  showNetworkDebugMarkers: false,
} as const;