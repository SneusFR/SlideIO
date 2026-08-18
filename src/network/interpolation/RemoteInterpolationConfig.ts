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
   * INITIAL interpolation delay (ms). Remote players are rendered this
   * many milliseconds in the PAST so two snapshots normally bracket the
   * render time. The delay then ADAPTS at runtime between
   * adaptiveDelayMinMs and adaptiveDelayMaxMs based on the measured
   * snapshot rate + arrival jitter (see AdaptiveInterpolationDelay).
   */
  interpolationDelayMs: 70,

  // ---- Adaptive interpolation delay (AdaptiveInterpolationDelay) ----
  /** Floor of the adaptive delay (ms) — never below ~1.5 snapshot gaps. */
  adaptiveDelayMinMs: 50,
  /** Ceiling of the adaptive delay (ms) — worst tolerated connections. */
  adaptiveDelayMaxMs: 150,
  /** Safety margin added on top of gap + jitter (ms). */
  adaptiveSafetyMarginMs: 8,
  /** Jitter envelope decay (ms of envelope per second of clean traffic). */
  adaptiveJitterDecayMsPerSec: 15,
  /**
   * Gap envelope decay (ms/s). The delay must cover the WORST recent
   * snapshot gap, not the average: client sends (30 Hz) land in a single
   * server schema slot patched at 30 Hz — when two sends fall inside one
   * patch window the first is overwritten, producing regular ~2× gaps
   * that an average would hide (→ extrapolation freezes mid-jump).
   */
  adaptiveGapDecayMsPerSec: 10,
  /** Applied-delay raise speed (ms/s) — fast: protect the next frames. */
  adaptiveRaiseRateMsPerSec: 240,
  /** Applied-delay lower speed (ms/s) — slow: invisible timeline drift. */
  adaptiveLowerRateMsPerSec: 6,
  /** Lateness samples above this (ms) are stale artifacts — ignored. */
  adaptiveLatenessCapMs: 400,
  /** Snapshot gaps above this (ms) are idle suppression — ignored. */
  adaptiveGapCapMs: 300,

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