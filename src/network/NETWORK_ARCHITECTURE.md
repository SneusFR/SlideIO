# SlideIO — Network Architecture (Phase 3)

## Current model (temporary — client-reported authority)

```text
LOCAL PLAYER
Input → immediate local Rapier simulation (ZERO added latency)
      → transform + velocity + movementState + sequence
        sent at a fixed network tick (~20 Hz, MultiplayerConfig.transformSendRate)
      → server sanity-checks (bounds / finite / monotonic sequence)
      → server stamps a SERVER timestamp (ts) and broadcasts via room state

REMOTE PLAYERS
Server state patches
      → SnapshotBuffer per remote player (ordered by server ts,
        stale sequences rejected, max ~1 s of history)
      → every render frame: renderTime = estimatedServerNow − 100 ms
        (RemoteInterpolationConfig.interpolationDelayMs)
      → interpolate position (lerp) + yaw/pitch (shortest-arc)
        between the two snapshots bracketing renderTime
      → no future snapshot? extrapolate with the last velocity for
        ≤ 125 ms (maxExtrapolationMs), then FREEZE (never drift)
      → jump > teleportThreshold (6 m)? SNAP (respawn / teleport)
      → RemotePlayerAnimationController maps NetworkMovementState
        (IDLE / RUNNING / AIRBORNE / SLIDING / DASHING) onto shared
        cached clips, one AnimationMixer per remote player,
        crossfades ~0.1–0.2 s, run speed scaled by horizontal speed
```

## Golden rules

- The LOCAL player is NEVER interpolated, delayed or smoothed — its feel
  stays 100 % local. The 100 ms interpolation delay applies to REMOTE
  players only.
- NEVER raise the network send rate to hide choppiness — snapshots +
  interpolation solve it at ~20 Hz.
- The network transmits STATES (`SLIDING`), never animation clip names.
- Snapshot ordering uses the SERVER timestamp (`ts`) — raw client clocks
  of different machines are never compared.

## Key files

| File | Role |
| --- | --- |
| `MultiplayerConfig.ts` | send rate, epsilons, heartbeat |
| `interpolation/RemoteInterpolationConfig.ts` | delay, extrapolation cap, teleport threshold, pitch clamp |
| `interpolation/SnapshotBuffer.ts` | per-player ring of snapshots + sample() (interp/extrap/teleport) |
| `interpolation/NetworkClock.ts` | estimated server time from stamped patches |
| `RemotePlayerManager.ts` | avatars, clip cache, snapshot push, per-frame sampling |
| `remote/RemotePlayerAnimationController.ts` | mixer, blending, poses, pitch look |
| `MultiplayerGameController.ts` | fixed-rate local transform sends (seq + velocity + state) |
| `backend/src/rooms/GameRoom.ts` | validation + server timestamping |

## Future phases (prepared, NOT implemented)

```text
LOCAL PLAYER   Input(seq, timestamp) → client prediction →
               server authoritative simulation → snapshot → reconciliation
REMOTE PLAYER  server snapshots → snapshot buffer → interpolation  (DONE in Phase 3)
```

The per-send `seq` in `MultiplayerGameController` is the seed of the
future input-sequence pipeline. When movement becomes server-authoritative,
the server will also COMPUTE `movementState` instead of trusting the client.