import * as THREE from "three";
import { MultiplayerConfig as netCfg } from "./MultiplayerConfig";
import { toNetworkMovementState } from "./NetworkMovementState";
import type {
  MultiplayerClient,
  PlayerDiedEvent,
  PlayerRespawnedEvent,
} from "./MultiplayerClient";
import { RemotePlayerManager, JUMP_DEBUG } from "./RemotePlayerManager";
import { RemoteCombatVFXController } from "./remote/RemoteCombatVFXController";
import { preloadRemoteWeaponTemplates } from "./remote/RemoteWeaponController";
import { NetworkStatsSource } from "./NetworkStatsSource";
import type {
  HitConfirmedEvent,
  DamageTakenEvent,
} from "../../shared/combat/NetworkWeapons";
import type { PlayerMatchStats } from "../stats/MatchStatsManager";
import type { FPSCamera } from "../camera/FPSCamera";
import type { PlayerController } from "../player/PlayerController";
import type { PlayerMovement } from "../player/PlayerMovement";
import type { ParticleSystem } from "../effects/ParticleSystem";
import { NetworkMovementState } from "./NetworkMovementState";

/**
 * Bridges the running game and the multiplayer session:
 *
 *   local player  → transform sent on a FIXED network tick (~20 Hz,
 *                   decoupled from requestAnimationFrame)
 *   network state → RemotePlayerManager (avatars for the other players)
 *   server spawn  → applied to the local physics controller on start
 *
 * PHASE 4 — SERVER-AUTHORITATIVE COMBAT STATE:
 *   The server owns HP / alive / K / D / A. This controller is the ONLY
 *   frontend bridge for that state:
 *     server health  → onLocalHealthChanged  → HUD mirror
 *     server death   → onLocalDied           → existing death flow
 *     server respawn → physics teleport + onLocalRespawned
 *     server K/D/A   → onStatsChanged        → LeaderboardHUD
 *   The client NEVER decides it is dead/alive from its own numbers.
 *
 * PHASE 2 NOTE: local movement stays fully client-side (input → immediate
 * Rapier movement, zero added latency). The client REPORTS its transform;
 * the server only sanity-checks it.
 */
export class MultiplayerGameController {
  readonly remotes: RemotePlayerManager;
  /** Phase 5: remote weapon VFX / audio replay (server-confirmed actions). */
  readonly vfx: RemoteCombatVFXController;

  // ---- Phase 4 combat bridge callbacks (wired by Game) ----
  /** Server says the LOCAL player died — trigger the existing death flow. */
  onLocalDied: (() => void) | null = null;
  /** Server respawned the LOCAL player (body already teleported here). */
  onLocalRespawned: (() => void) | null = null;
  /** Server-owned local HP changed (mirror into the HUD health). */
  onLocalHealthChanged: ((health: number, maxHealth: number) => void) | null = null;
  /** The LOCAL player killed someone (kill HUD feedback + medals). */
  onLocalKill: ((isHeadshot: boolean, damageType: string) => void) | null = null;
  /** Server K/D/A changed — the sorted rows for the LeaderboardHUD. */
  onStatsChanged: ((stats: PlayerMatchStats[]) => void) | null = null;
  // ---- Phase 5 combat bridge callbacks (wired by Game) ----
  /** Server confirmed one of OUR hits (hitmarker + hit sound). */
  onHitConfirmed: ((event: HitConfirmedEvent) => void) | null = null;
  /** We took server-validated damage (directional feedback source). */
  onDamageTaken: ((event: DamageTakenEvent) => void) | null = null;
  /** Server knockback for the LOCAL player (applied to local physics). */
  onApplyImpulse: ((x: number, y: number, z: number) => void) | null = null;

  private readonly statsSource = new NetworkStatsSource();
  /** Local alive state as told BY THE SERVER (never by local HP math). */
  private localAlive = true;
  private lastLocalHealth = -1;

  private networkAccumulator = 0;
  private timeSinceSend = 0;
  private readonly lastSent = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, state: -1 };
  private readonly posScratch = new THREE.Vector3();
  /**
   * Monotonic per-send sequence (Phase 3). Also the seed of the future
   * client-prediction pipeline: authoritative movement will attach this
   * same kind of sequence/timestamp to INPUTS for server reconciliation.
   */
  private sendSequence = 0;

  /**
   * Background keep-alive: the render loop (rAF) is throttled/stopped when
   * the tab is hidden — the local simulation can't run, but the server and
   * every remote client must still see a CLEAN standing player at the last
   * position (never a ghost extrapolated forever with a stale velocity).
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;

  constructor(
    private readonly client: MultiplayerClient,
    scene: THREE.Scene,
    private readonly fpsCamera: FPSCamera,
    private readonly player: PlayerController,
    private readonly movement: PlayerMovement,
  ) {
    this.remotes = new RemotePlayerManager(scene);
    this.vfx = new RemoteCombatVFXController(scene, this.remotes, () => client.sessionId);

    // Server combat events (one-shot; the synced state is the backstop).
    client.onPlayerDied = (event) => this.handlePlayerDied(event);
    client.onPlayerRespawned = (event) => this.handlePlayerRespawned(event);

    // ---- Phase 5: server-confirmed weapon events ----
    client.onWeaponActionConfirmed = (event) => this.vfx.handleAction(event);
    client.onHitConfirmed = (event) => this.onHitConfirmed?.(event);
    client.onDamageTaken = (event) => this.onDamageTaken?.(event);
    client.onApplyImpulse = (event) => this.onApplyImpulse?.(event.x, event.y, event.z);

    this.lastFrameAt = performance.now();
    this.keepaliveTimer = setInterval(() => this.backgroundKeepalive(), 250);

    // DEV-ONLY damage tool: `mpDamage("PLAYER 65", 25)` from the console.
    // The server hard-refuses DEBUG_DAMAGE in production — easy to delete
    // once real weapons are networked (Phase 5).
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).mpDamage = (
        target: string,
        amount: number,
      ) => this.debugDamage(target, amount);
    }
  }

  /**
   * Load the shared character asset + EVERY remote weapon GLB template
   * before entering the map (first shots must never parse a GLB), then
   * warm the remote VFX materials so first actions never compile shaders.
   */
  async preload(): Promise<void> {
    await Promise.all([this.remotes.preload(), preloadRemoteWeaponTemplates()]);
    this.vfx.warmUp();
  }

  /** Static world meshes remote plasma beams visually stop on. */
  setRaycastTargets(targets: THREE.Object3D[]): void {
    this.vfx.setRaycastTargets(targets);
  }

  /** Shared ParticleSystem: remote VFX emit the same particles as local. */
  setParticles(particles: ParticleSystem): void {
    this.vfx.setParticles(particles);
  }

  /**
   * Apply the SERVER-ASSIGNED spawn to the local player: physics body
   * teleported, velocity zeroed (movement.respawn does both) and the
   * camera aligned with the spawn yaw.
   */
  applyServerSpawn(): void {
    const me = this.client.getLocalPlayer();
    if (!me) return;
    this.movement.respawn({ x: me.x, y: me.y, z: me.z });
    this.fpsCamera.yaw = me.yaw;
    this.fpsCamera.pitch = me.pitch;
  }

  /**
   * Seconds until the server respawns the LOCAL player (server clock),
   * or null while no reliable estimate exists yet.
   */
  getRespawnCountdown(): number | null {
    const me = this.client.getLocalPlayer();
    if (!me || me.isAlive || me.respawnAt <= 0) return null;
    const now = this.remotes.getServerNow();
    if (now === null) return null;
    return Math.max(0, (me.respawnAt - now) / 1000);
  }

  /**
   * Per-frame update (runs every render frame, even in the Escape menu so
   * remote players keep moving). Network SENDS happen on their own
   * accumulator tick — never once per render frame.
   */
  update(dt: number): void {
    this.lastFrameAt = performance.now();
    const players = this.client.getPlayers();

    // Remote avatars: reconcile with the latest server state + smooth.
    this.remotes.sync(players, this.client.sessionId);
    this.remotes.update(dt);

    // Phase 5: remote weapon VFX (beams follow the interpolated aim) +
    // cleanup of VFX owned by players who left the room. Obliterreur
    // anchors are also dropped when their owner switches weapons.
    this.vfx.update(dt);
    this.vfx.prune(new Set(players.map((p) => p.id)));
    this.vfx.syncEquippedWeapons(players);

    // ---- Phase 4: server-owned local combat state ----
    const me = this.client.getLocalPlayer();
    if (me) {
      // Feed the shared server clock with our own accepted-transform time.
      this.remotes.noteServerTime(me.ts);

      // HP mirror (server value is exact — HUD only).
      if (me.health !== this.lastLocalHealth) {
        this.lastLocalHealth = me.health;
        this.onLocalHealthChanged?.(me.health, me.maxHealth);
      }

      // Alive-flag backstop: if a PLAYER_DIED / PLAYER_RESPAWNED message
      // was missed, the synchronized state still drives the transitions.
      if (this.localAlive && !me.isAlive) {
        this.localAlive = false;
        this.onLocalDied?.();
      } else if (!this.localAlive && me.isAlive) {
        this.localAlive = true;
        this.applyServerSpawn();
        this.onLocalRespawned?.();
      }
    }

    // Leaderboard: pure projection of the server state (host has ZERO
    // ranking priority; ALL room players appear from second one, 0/0/0).
    const stats = this.statsSource.build(players, this.client.sessionId);
    if (stats) this.onStatsChanged?.(stats);

    // ---- Fixed-rate transform send (network tick ≠ render tick) ----
    this.networkAccumulator += dt;
    this.timeSinceSend += dt;
    const interval = 1 / netCfg.transformSendRate;
    if (this.networkAccumulator < interval) return;
    this.networkAccumulator %= interval;

    if (!this.client.isConnected) return;
    // DEAD players don't move: stop reporting transforms until the server
    // respawns us (the server also refuses them — this is just polite).
    if (!this.localAlive) return;

    const pos = this.player.getPosition(this.posScratch);
    const yaw = wrapAngle(this.fpsCamera.yaw);
    const pitch = this.fpsCamera.pitch;

    // Phase 3 payload: real local velocity (from the movement simulation —
    // remote clients use it for extrapolation + animation speed) and the
    // minimal movement state (CLIENT-REPORTED for now; a server-
    // authoritative phase will compute/validate it server-side).
    const vel = this.movement.velocity;
    const state = toNetworkMovementState(this.movement.state, Math.hypot(vel.x, vel.z));

    // Idle suppression: skip identical transforms, with a rare heartbeat.
    // A movement-state change ALWAYS sends (slide/dash must show up now).
    const moved =
      Math.abs(pos.x - this.lastSent.x) > netCfg.positionEpsilon ||
      Math.abs(pos.y - this.lastSent.y) > netCfg.positionEpsilon ||
      Math.abs(pos.z - this.lastSent.z) > netCfg.positionEpsilon ||
      Math.abs(yaw - this.lastSent.yaw) > netCfg.rotationEpsilon ||
      Math.abs(pitch - this.lastSent.pitch) > netCfg.rotationEpsilon ||
      state !== this.lastSent.state;
    if (!moved && this.timeSinceSend < netCfg.transformHeartbeat) return;

    this.sendSequence++;
    // TEMP DEBUG: what the jumping client actually sends (AIRBORNE frames
    // + every state change, e.g. the landing GROUNDED transform).
    if (
      JUMP_DEBUG &&
      (state === NetworkMovementState.AIRBORNE || state !== this.lastSent.state)
    ) {
      console.log(
        `[LOCAL]`,
        `seq=${this.sendSequence}`,
        `y=${pos.y.toFixed(2)}`,
        `vy=${vel.y.toFixed(2)}`,
        `st=${state}`,
        `mv=${this.movement.state}`,
      );
    }
    this.client.sendTransform({
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw,
      pitch,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      state,
      seq: this.sendSequence,
    });
    this.lastSent.x = pos.x;
    this.lastSent.y = pos.y;
    this.lastSent.z = pos.z;
    this.lastSent.yaw = yaw;
    this.lastSent.pitch = pitch;
    this.lastSent.state = state;
    this.timeSinceSend = 0;
  }

  /**
   * While rAF is stalled (hidden tab): report the CURRENT position with
   * zero velocity + IDLE so the server hit detection and every remote
   * client keep an exact, clean, hittable avatar for this player.
   */
  private backgroundKeepalive(): void {
    if (performance.now() - this.lastFrameAt < 300) return; // loop is alive
    if (!this.client.isConnected || !this.localAlive) return;
    const pos = this.player.getPosition(this.posScratch);
    this.sendSequence++;
    
    this.client.sendTransform({
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw: wrapAngle(this.fpsCamera.yaw),
      pitch: this.fpsCamera.pitch,
      vx: 0,
      vy: 0,
      vz: 0,
      state: NetworkMovementState.IDLE,
      seq: this.sendSequence,
    });
    this.lastSent.x = pos.x;
    this.lastSent.y = pos.y;
    this.lastSent.z = pos.z;
    this.lastSent.state = NetworkMovementState.IDLE;
    this.timeSinceSend = 0;
  }

  /** Tear down every remote avatar (leave game / connection lost). */
  dispose(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.client.onPlayerDied = null;
    this.client.onPlayerRespawned = null;
    this.client.onWeaponActionConfirmed = null;
    this.client.onHitConfirmed = null;
    this.client.onDamageTaken = null;
    this.client.onApplyImpulse = null;
    this.vfx.dispose();
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).mpDamage;
    }
    this.remotes.dispose();
  }

  // ------------------------------------------------------------------
  // Phase 4 — server combat events
  // ------------------------------------------------------------------

  private handlePlayerDied(event: PlayerDiedEvent): void {
    const localId = this.client.sessionId;
    // Corpses never keep beams / anchors alive (projectiles survive).
    this.vfx.onPlayerDied(event.victimId);
    if (event.victimId === localId) {
      // SERVER decided the local player is dead (never local HP math).
      if (this.localAlive) {
        this.localAlive = false;
        this.onLocalDied?.();
      }
    } else if (event.killerId === localId) {
      this.onLocalKill?.(event.isHeadshot, event.damageType);
    }
    // Remote victims: the synced isAlive flag hides their avatar in sync().
  }

  private handlePlayerRespawned(event: PlayerRespawnedEvent): void {
    if (event.playerId === this.client.sessionId) {
      // SERVER respawn: teleport the physics body to the event's spawn
      // (velocity zeroed — no dash/slide/fall momentum survives death).
      this.localAlive = true;
      this.movement.respawn({ x: event.x, y: event.y, z: event.z });
      this.fpsCamera.yaw = event.yaw;
      this.fpsCamera.pitch = 0;
      this.onLocalRespawned?.();
    } else {
      // Remote respawn = legitimate teleport: clear its snapshot buffer so
      // it can NEVER be interpolated from the death spot to the new spawn.
      this.remotes.notifyRespawn(event.playerId);
    }
  }

  /** DEV-ONLY console helper: resolve a name/sessionId → DEBUG_DAMAGE. */
  private debugDamage(target: string, amount: number): void {
    if (!import.meta.env.DEV) return;
    const needle = String(target).trim().toLowerCase();
    const player =
      this.client.getPlayers().find((p) => p.id === target) ??
      this.client.getPlayers().find((p) => p.name.toLowerCase() === needle);
    if (!player) {
      console.warn(`[Multiplayer] mpDamage: no player matching "${target}"`);
      return;
    }
    this.client.sendDebugDamage(player.id, amount);
    console.log(`[Multiplayer] DEBUG_DAMAGE → ${player.name} (${player.id}) for ${amount}`);
  }
}

/** Wrap an unbounded angle into [-PI, PI] before sending. */
function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}