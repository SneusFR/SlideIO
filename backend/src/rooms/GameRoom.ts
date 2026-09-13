import { Client, Room, ServerError } from "colyseus";
import { CombatManager, PlayerDiedEvent } from "../combat/CombatManager";
import { ServerTransformTrace } from "../diagnostics/TransformTrace";
import { eventLoopMonitor } from "../diagnostics/EventLoopMonitor";
import { DamageType, HitZone, isDamageType, isHitZone } from "../combat/DamageTypes";
import { RespawnManager } from "../combat/RespawnManager";
import { serverConfig } from "../config/serverConfig";
import { GameRoomPhase, GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { WeaponManager } from "../weapons/WeaponManager";
import {
  NetworkWeaponId,
  PLAYER_FEET_OFFSET,
  WeaponActionMessage,
  WeaponEquipMessage,
} from "../../../shared/combat/NetworkWeapons";
import {
  DEFAULT_MAP_ID,
  getMapDefinition,
  isMapId,
  type MapDefinition,
} from "../../../shared/map/MapRegistry";

interface JoinOptions {
  name?: unknown;
}

/** Room creation options (the CREATOR picks the map — fixed afterwards). */
interface CreateOptions {
  name?: unknown;
  map?: unknown;
}

/**
 * Compact client-reported transform (Phase 2, extended in Phase 3 with
 * velocity + movement state + sequence — ONE message, no separate
 * TRANSFORM/ANIMATION/VELOCITY packets).
 */
interface TransformMessage {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  yaw?: unknown;
  pitch?: unknown;
  vx?: unknown;
  vy?: unknown;
  vz?: unknown;
  state?: unknown;
  seq?: unknown;
  /**
   * DEV-ONLY sender-clock timestamp (client performance.now(), ms). Used
   * exclusively for DELTAS between consecutive messages of the SAME sender
   * (sender stall vs network stall) — NEVER compared to the server clock.
   */
  cts?: unknown;
}

/**
 * DEV-ONLY debug damage request (see serverConfig.debugDamageEnabled).
 * Phase 5 will replace this with validated weapon-fire messages — the
 * server must NEVER trust "I dealt X damage to player B" in production.
 */
interface DebugDamageMessage {
  targetId?: unknown;
  amount?: unknown;
  damageType?: unknown;
  hitZone?: unknown;
}

/** World-bounds sanity limits for client-reported transforms. */
const MAX_ABS_XZ = 500;
const MIN_Y = -100;
const MAX_Y = 500;
const MAX_ABS_ANGLE = Math.PI * 2;
/** Max plausible per-axis speed (m/s) for client-reported velocity. */
const MAX_ABS_VELOCITY = 100;
/** NetworkMovementState range (see frontend NetworkMovementState enum). */
const MAX_MOVEMENT_STATE = 5; // 5 = BURROWED (MOLE STRIKE)

/**
 * Private game room.
 *
 * Phase 1: lobby (players list, host tag, invite joins).
 * Phase 2: START_GAME (host-only, server-validated), server-assigned
 *          distinct spawn points, and client-reported transform sync.
 *
 * NOTE (Phase 2): movement uses client-reported transforms with basic
 * sanity validation only. Future authoritative movement (inputs → server
 * simulation → prediction → reconciliation) will replace/validate this.
 */
export class GameRoom extends Room<GameRoomState> {
  maxClients = serverConfig.maxClientsPerRoom;

  /** The room's map (shared registry entry — colliders / spawns / hazards). */
  private map!: MapDefinition;
  /** Per-player hazard damage throttle (server ms of the next allowed tick). */
  private readonly hazardNextTickAt = new Map<string, number>();

  /** Phase 4: server authority over HP / death / stats (combat module). */
  private combat!: CombatManager;
  /** Phase 4: server-driven respawn timers + spawn selection. */
  private respawns!: RespawnManager;
  /** Phase 5: server authority over every networked weapon. */
  private weapons!: WeaponManager;
  /**
   * DEV-ONLY snapshot pipeline trace (receive gaps / patch gaps / seq /
   * coalescing). Null in production — every call site is `?.` guarded.
   */
  private trace: ServerTransformTrace | null = null;
  /** DEV-ONLY: throttled NET_DIAG relay to clients (F1 PIPELINE section). */
  private lastDiagBroadcastAt = 0;
  // ---- DEV-ONLY combat message rate counters (relayed via NET_DIAG,
  // aggregated over the diag interval — NEVER logged per message) ----
  /** WEAPON_ACTION messages received since the last NET_DIAG relay. */
  private combatMsgReceived = 0;
  /** Combat messages sent (confirms + hit/damage/impulse) since last relay. */
  private combatMsgSent = 0;
  /** performance.now() when the combat counters were last drained. */
  private combatCountersSince = 0;

  onCreate(options?: CreateOptions): void {
    this.setState(new GameRoomState());
    // Private lobby: never listed in public matchmaking. Join happens
    // exclusively via roomId (invite link / manual code).
    this.setPrivate(true);

    // MAP: validated against the shared registry — an unknown / missing id
    // falls back to the default map so old clients keep working unchanged.
    const mapId = isMapId(options?.map) ? options.map : DEFAULT_MAP_ID;
    this.map = getMapDefinition(mapId);
    this.state.mapId = this.map.id;
    // Lobby browser rows read the map from the room metadata (available
    // through getAvailableRooms without joining).
    void this.setMetadata({ map: this.map.id });

    this.combat = new CombatManager(this.state);
    this.combat.onPlayerDied = (event) => this.onPlayerDied(event);
    // Respawns use THIS map's validated spawn points (capsule centers +
    // the same small Y margin the frontend applies).
    this.respawns = new RespawnManager(
      this.clock,
      this.map.spawnPoints.map((s) => ({ x: s.x, y: s.y + 0.3, z: s.z, yaw: s.yaw })),
    );

    // State patches at 30 Hz (Colyseus default: 20 Hz). Transforms are
    // relayed through the synced state, so the patch rate is a direct
    // term of the remote-player latency chain:
    //   client send (30 Hz) → server patch (30 Hz) → interpolation delay.
    this.setPatchRate(1000 / 30);

    // ---- DEV-ONLY movement pipeline diagnostics (see TransformTrace) ----
    if (serverConfig.netTraceEnabled) {
      this.trace = new ServerTransformTrace(this.roomId);
      eventLoopMonitor.start(); // idempotent process-wide stall detector
    }

    // Phase 5 — GameRoom stays an orchestrator: receive message →
    // WeaponManager (validation + hit detection) → CombatManager →
    // broadcast result. All weapon logic lives in backend/src/weapons/.
    this.weapons = new WeaponManager({
      getPlayer: (id) => this.state.players.get(id),
      players: () => this.state.players.values(),
      applyDamage: (req) => this.combat.applyDamage(req),
      // The shooter's client DISCARDS its own confirmed actions (local
      // prediction already rendered them) — never echo the broadcast back
      // to the originating client: pure redundant traffic on its socket.
      broadcastAction: (event) => {
        // EXCEPTION — HEX SNIPER: the tongue's outcome (grab / miss / pull
        // end / bite) is decided HERE, so the shooter needs its own confirm
        // to drive its local weapon. Every other weapon stays shooter-excluded.
        // GOOFY BASKET: the throw level / projectile id / bounces / end are
        // decided here too — the shooter reconciles its predicted ball.
        const shooter =
          event.weapon === NetworkWeaponId.HEX_SNIPER || event.weapon === NetworkWeaponId.GOOFY_BASKET
            ? undefined
            : this.clientById(event.playerId);
        this.broadcast(
          "WEAPON_ACTION_CONFIRMED",
          event,
          shooter ? { except: shooter } : undefined,
        );
        this.combatMsgSent += Math.max(0, this.clients.length - (shooter ? 1 : 0));
      },
      sendHitConfirmed: (attackerId, ev) => {
        const client = this.clientById(attackerId);
        if (client) {
          client.send("HIT_CONFIRMED", ev);
          this.combatMsgSent++;
        }
      },
      sendDamageTaken: (victimId, ev) => {
        const client = this.clientById(victimId);
        if (client) {
          client.send("DAMAGE_TAKEN", ev);
          this.combatMsgSent++;
        }
      },
      sendImpulse: (victimId, impulse) => {
        const client = this.clientById(victimId);
        if (client) {
          client.send("APPLY_IMPULSE", impulse);
          this.combatMsgSent++;
        }
      },
      // HEX SNIPER: the victim reels itself toward the attacker (movement
      // is client-simulated) — start/stop is a direct message to it.
      sendHexPull: (victimId, ev) => {
        const client = this.clientById(victimId);
        if (client) {
          client.send("HEX_PULL", ev);
          this.combatMsgSent++;
        }
      },
      now: () => Date.now(),
    }, this.map.colliderBoxes);
    // Fixed 20 Hz combat tick (plasma DPS, oblit beam, rush, projectiles) —
    // damage uses the REAL deltaTime, never a per-frame loop.
    this.setSimulationInterval((deltaMs) => {
      if (this.state.phase === GameRoomPhase.PLAYING) {
        this.weapons.tick(deltaMs / 1000);
        // Map hazards (YARD acid pool): authoritative, independent of any
        // client rendering or graphics settings — pure transform checks.
        if (this.map.hazards.length > 0) this.tickHazards();
      }
    }, 50);

    this.onMessage("START_GAME", (client) => this.handleStartGame(client));
    // RTT measurement: echo the nonce IMMEDIATELY (the client computes
    // RTT from its own local clock — never cross-client Date.now math).
    // The optional `r` field carries the client's SMOOTHED RTT which is
    // published to everyone via the synced state (leaderboard ping).
    this.onMessage("PING", (client, message: { n?: unknown; r?: unknown }) => {
      const r = toFinite(message?.r);
      if (r !== null && r >= 0) {
        const player = this.state.players.get(client.sessionId);
        if (player) player.pingMs = Math.min(999, Math.round(r));
      }
      client.send("PONG", { n: toFinite(message?.n) ?? 0 });
    });
    this.onMessage("PLAYER_TRANSFORM", (client, message) =>
      this.handlePlayerTransform(client, message as TransformMessage),
    );
    // DEV-ONLY damage tool — handler refuses everything in production.
    this.onMessage("DEBUG_DAMAGE", (client, message) =>
      this.handleDebugDamage(client, message as DebugDamageMessage),
    );
    // Phase 5 — real weapons: state (equip) + events (actions).
    this.onMessage("WEAPON_EQUIP", (client, message) => {
      if (this.state.phase !== GameRoomPhase.PLAYING) return;
      const player = this.state.players.get(client.sessionId);
      if (player) this.weapons.handleEquip(player, (message as WeaponEquipMessage)?.weapon);
    });
    this.onMessage("WEAPON_ACTION", (client, message) => {
      if (this.state.phase !== GameRoomPhase.PLAYING) return;
      this.combatMsgReceived++; // DEV diag counter (aggregated, never logged)
      const player = this.state.players.get(client.sessionId);
      if (player) this.weapons.handleAction(player, (message ?? {}) as WeaponActionMessage);
    });

    console.log(`[GameRoom ${this.roomId}] created`);
  }

  onJoin(client: Client, options?: JoinOptions): void {
    // Phase 2: no join-in-progress — once PLAYING, new joins are refused.
    if (this.state.phase !== GameRoomPhase.LOBBY) {
      throw new ServerError(409, "game already started");
    }

    const name = sanitizeName(options?.name) ?? `PLAYER ${this.clients.length}`;

    const player = new NetworkPlayer();
    player.id = client.sessionId;
    player.name = name;
    player.isHost = this.state.players.size === 0;

    this.state.players.set(client.sessionId, player);
    console.log(`[GameRoom ${this.roomId}] ${name} joined (${client.sessionId})`);
  }

  onLeave(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    // Full combat cleanup: pending respawn timer, damage contributions,
    // spawn protection — no stale async work after a disconnect.
    this.respawns.cancel(client.sessionId);
    this.combat.removePlayer(client.sessionId);
    this.weapons.removePlayer(client.sessionId);
    this.hazardNextTickAt.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.trace?.removePlayer(client.sessionId);
    console.log(
      `[GameRoom ${this.roomId}] ${player?.name ?? client.sessionId} left`,
    );
  }

  /**
   * DEV-ONLY instrumentation of the ACTUAL replication mechanism: transforms
   * are relayed exclusively through Colyseus schema patches (there is NO
   * explicit movement broadcast) — this override timestamps every patch
   * broadcast, i.e. the exact moment mutated state leaves the server.
   * Production (trace null): behavior is byte-identical to the base class.
   */
  override broadcastPatch(): boolean {
    const hasChanges = super.broadcastPatch();
    if (this.trace) {
      if (hasChanges) this.trace.notePatchBroadcast();
      // Throttled NET_DIAG relay: server-side RX/TX gap stats for the F1
      // PIPELINE overlay (tiny payload, every ~2 s, dev only).
      const now = performance.now();
      if (now - this.lastDiagBroadcastAt >= 2000 && this.clients.length > 0) {
        this.lastDiagBroadcastAt = now;
        // Combat message rates: counters drained per relay window (~2 s).
        const windowSec =
          this.combatCountersSince > 0 ? (now - this.combatCountersSince) / 1000 : 2;
        const combatRxPerSec = Math.round(this.combatMsgReceived / Math.max(0.25, windowSec));
        const combatTxPerSec = Math.round(this.combatMsgSent / Math.max(0.25, windowSec));
        this.combatMsgReceived = 0;
        this.combatMsgSent = 0;
        this.combatCountersSince = now;
        this.broadcast("NET_DIAG", {
          players: this.trace.buildDiag(),
          patchAvgMs: Math.round(this.trace.patchGap.avgMs),
          patchMaxMs: Math.round(this.trace.patchGap.maxMs),
          loopStallMs: Math.round(eventLoopMonitor.recentMaxStallMs(5000)),
          combatRxPerSec,
          combatTxPerSec,
          // Worst per-client outbound WebSocket backlog (bytes). The `ws`
          // socket behind each Colyseus client exposes bufferedAmount —
          // read defensively (-1 = unavailable in this transport).
          wsBufferedMax: this.maxClientWsBuffered(),
        });
      }
    }
    return hasChanges;
  }

  onDispose(): void {
    this.respawns.cancelAll();
    console.log(`[GameRoom ${this.roomId}] disposed`);
  }

  // ------------------------------------------------------------------

  /**
   * Host requests the match start. The SERVER validates everything:
   * only the host, only from LOBBY, only with enough players. A non-host
   * (or fraudulent) START_GAME is silently refused.
   */
  private handleStartGame(client: Client): void {
    const requester = this.state.players.get(client.sessionId);
    if (!requester?.isHost) {
      console.warn(
        `[GameRoom ${this.roomId}] START_GAME refused — ${client.sessionId} is not host`,
      );
      return;
    }
    if (this.state.phase !== GameRoomPhase.LOBBY) return; // already started
    if (this.state.players.size < serverConfig.minPlayersToStart) {
      console.warn(`[GameRoom ${this.roomId}] START_GAME refused — not enough players`);
      return;
    }

    this.assignSpawnPoints();
    // Phase 4: everyone enters the match alive at full server-owned HP.
    this.state.players.forEach((player) => this.combat.initializePlayerForMatch(player));
    // Phase flip LAST so clients read their spawn in the same state patch.
    this.state.phase = GameRoomPhase.PLAYING;
    console.log(
      `[GameRoom ${this.roomId}] PLAYING — started by host with ${this.state.players.size} players`,
    );
  }

  /** Server-side spawn assignment: distinct points whenever possible. */
  private assignSpawnPoints(): void {
    // THIS map's spawn points (capsule centers + the frontend's Y margin).
    // Shuffled copy → different games use different pads; index-per-player
    // guarantees distinct spawns while players ≤ spawn points.
    const shuffled = this.map.spawnPoints.map((s) => ({
      x: s.x,
      y: s.y + 0.3,
      z: s.z,
      yaw: s.yaw,
    }));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let index = 0;
    this.state.players.forEach((player) => {
      const spawn = shuffled[index % shuffled.length];
      index++;
      player.x = spawn.x;
      player.y = spawn.y;
      player.z = spawn.z;
      player.yaw = spawn.yaw;
      player.pitch = 0;
    });
  }

  /**
   * Client-reported transform (Phase 2). Identity ALWAYS comes from
   * client.sessionId — a client can never move another player. Basic
   * sanity validation keeps a broken/malicious packet from corrupting
   * the room state (finite numbers, world bounds, angle range).
   */
  private handlePlayerTransform(client: Client, message: TransformMessage): void {
    if (this.state.phase !== GameRoomPhase.PLAYING) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    // A dead player cannot move — refuse transforms until the server
    // respawns them (the client also stops sending, this is the backstop).
    if (!player.isAlive) return;

    const x = toFinite(message?.x);
    const y = toFinite(message?.y);
    const z = toFinite(message?.z);
    const yaw = toFinite(message?.yaw);
    const pitch = toFinite(message?.pitch);
    if (x === null || y === null || z === null || yaw === null || pitch === null) return;

    if (Math.abs(x) > MAX_ABS_XZ || Math.abs(z) > MAX_ABS_XZ) return;
    if (y < MIN_Y || y > MAX_Y) return;
    if (Math.abs(yaw) > MAX_ABS_ANGLE || Math.abs(pitch) > MAX_ABS_ANGLE) return;

    // ---- Phase 3 payload (velocity + movement state + sequence) ----
    // Missing/invalid extras degrade gracefully to safe defaults so an
    // older client cannot corrupt the room state.
    const vx = clampFinite(message?.vx, MAX_ABS_VELOCITY);
    const vy = clampFinite(message?.vy, MAX_ABS_VELOCITY);
    const vz = clampFinite(message?.vz, MAX_ABS_VELOCITY);
    const rawState = toFinite(message?.state);
    const state =
      rawState !== null && rawState >= 0 && rawState <= MAX_MOVEMENT_STATE
        ? Math.round(rawState)
        : 0;

    // Out-of-order protection: a late packet must never move the player
    // back in time (clients also reject stale sequences on their side).
    const seq = toFinite(message?.seq);
    if (seq === null || seq < 0) return;
    const applied = seq > player.seq;

    // DEV-ONLY receive trace: gap since the previous transform of this
    // player, seq contiguity (dup/backwards/gap) and the sender-clock
    // spacing (cts deltas — never compared to the server clock). Counted
    // BEFORE the seq guard so rejected duplicates remain visible.
    this.trace?.noteReceive(client.sessionId, player.name, seq, toFinite(message?.cts), applied);

    if (!applied) return;

    player.x = x;
    player.y = y;
    player.z = z;
    player.yaw = yaw;
    player.pitch = pitch;
    player.vx = vx;
    player.vy = vy;
    player.vz = vz;
    player.state = state;
    player.seq = seq;
    // SERVER timestamp — the single time base every client interpolates
    // against (clients never compare their raw local clocks).
    player.ts = Date.now();
    // Phase 5: feed the lag-compensation history (ServerPlayerHistory).
    this.weapons.recordTransform(player);
  }

  // ------------------------------------------------------------------
  // Map hazards — server-authoritative environment damage (YARD acid)
  // ------------------------------------------------------------------

  /**
   * Acid check on the fixed simulation tick: a player whose FEET are
   * inside a hazard volume takes lethal environment damage (throttled per
   * player so the pipeline fires once, not 20×/s while dying). The client
   * shows its own local splash/feedback — the DEATH decision lives here.
   */
  private tickHazards(): void {
    const now = Date.now();
    this.state.players.forEach((player) => {
      if (!player.isAlive) return;
      if (now < (this.hazardNextTickAt.get(player.id) ?? 0)) return;
      const feetY = player.y - PLAYER_FEET_OFFSET;
      for (const hazard of this.map.hazards) {
        if (
          player.x >= hazard.min[0] && player.x <= hazard.max[0] &&
          feetY >= hazard.min[1] && feetY <= hazard.max[1] &&
          player.z >= hazard.min[2] && player.z <= hazard.max[2]
        ) {
          this.hazardNextTickAt.set(player.id, now + 800);
          // Lethal: the acid pool is a death pit, not a DoT — one tick
          // kills (spawn protection is still honored by applyDamage).
          this.combat.applyDamage({
            attackerId: null,
            targetId: player.id,
            amount: player.maxHealth,
            damageType: DamageType.ENVIRONMENT,
            hitZone: HitZone.BODY,
          });
          break;
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Phase 4 — combat state (death / respawn / debug damage)
  // ------------------------------------------------------------------

  /**
   * Single death handler: broadcast the PLAYER_DIED event (killfeed /
   * medals / VFX hooks) and schedule the server-driven respawn.
   */
  private onPlayerDied(event: PlayerDiedEvent): void {
    console.log(
      `[GameRoom ${this.roomId}] PLAYER_DIED ${event.victimId} by ${event.killerId ?? "world"} (${event.damageType})`,
    );
    this.broadcast("PLAYER_DIED", event);
    // Phase 5: a corpse cannot keep firing — stop beams/rush immediately.
    this.weapons.onPlayerDeath(event.victimId);

    this.respawns.schedule(event.victimId, serverConfig.respawnDelay, () =>
      this.respawnPlayer(event.victimId),
    );
  }

  /** Server-driven respawn: new spawn, full HP, protection, RESPAWN event. */
  private respawnPlayer(playerId: string): void {
    const player = this.state.players.get(playerId);
    if (!player || player.isAlive) return; // left the room / already alive

    const spawn = this.respawns.pickSpawn(this.state.players.values(), playerId);
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    player.yaw = spawn.yaw;
    player.pitch = 0;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.state = 0;
    // Bump the sequence: the respawn transform is a NEW, fresher state —
    // client snapshot buffers must never reject it as a stale packet
    // (they also hard-clear on the PLAYER_RESPAWNED event below).
    player.seq += 1;
    player.ts = Date.now();

    this.combat.handleRespawn(player);
    this.weapons.onPlayerRespawn(playerId);

    // Explicit event so clients hard-teleport (snapshot buffers must NEVER
    // interpolate from the death position to the new spawn).
    this.broadcast("PLAYER_RESPAWNED", {
      playerId,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: spawn.yaw,
    });
    console.log(`[GameRoom ${this.roomId}] RESPAWN ${player.name} (${playerId})`);
  }

  /**
   * DEV-ONLY: lets the debug tool exercise the damage pipeline before the
   * weapons are networked (Phase 5). Hard-disabled in production via
   * serverConfig.debugDamageEnabled — delete once real weapons exist.
   */
  private handleDebugDamage(client: Client, message: DebugDamageMessage): void {
    if (!serverConfig.debugDamageEnabled) return;
    if (this.state.phase !== GameRoomPhase.PLAYING) return;

    const targetId = typeof message?.targetId === "string" ? message.targetId : null;
    const amount = toFinite(message?.amount);
    if (!targetId || amount === null) return;

    const result = this.combat.applyDamage({
      attackerId: client.sessionId,
      targetId,
      amount,
      damageType: isDamageType(message?.damageType) ? message.damageType : DamageType.DEBUG,
      hitZone: isHitZone(message?.hitZone) ? message.hitZone : HitZone.BODY,
    });
    console.log(
      `[GameRoom ${this.roomId}] DEBUG_DAMAGE ${client.sessionId} → ${targetId}: ` +
        (result.applied ? `${result.damageDealt} dmg${result.victimDied ? " (KILL)" : ""}` : `refused (${result.refusedReason})`),
    );
  }

  /** Direct per-client message routing (HIT_CONFIRMED / DAMAGE_TAKEN…). */
  private clientById(sessionId: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === sessionId);
  }

  /**
   * DEV-ONLY: worst outbound WebSocket backlog across the connected
   * clients (bytes). The @colyseus/ws-transport client wraps a `ws`
   * WebSocket in `client.ref`, which exposes `bufferedAmount` — a growing
   * value here proves the SERVER is producing faster than the client's
   * TCP connection drains (backpressure). Defensive: any transport that
   * doesn't expose it yields -1 ("N/A" in the F1 overlay).
   */
  private maxClientWsBuffered(): number {
    let max = -1;
    for (const client of this.clients) {
      const ref = (client as unknown as { ref?: { bufferedAmount?: unknown } }).ref;
      const buffered = ref?.bufferedAmount;
      if (typeof buffered === "number" && Number.isFinite(buffered)) {
        if (buffered > max) max = buffered;
      }
    }
    return max;
  }
}

/** Strictly finite number or null (rejects NaN / Infinity / non-numbers). */
function toFinite(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Finite number clamped to ±limit; invalid values degrade to 0. */
function clampFinite(raw: unknown, limit: number): number {
  const value = toFinite(raw);
  if (value === null) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

/** Trim / clamp the client-provided display name; reject non-strings. */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, 20);
  return name.length > 0 ? name : null;
}