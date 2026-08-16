import { Client, Room, ServerError } from "colyseus";
import { CombatManager, PlayerDiedEvent } from "../combat/CombatManager";
import { DamageType, HitZone, isDamageType, isHitZone } from "../combat/DamageTypes";
import { MULTIPLAYER_SPAWN_POINTS, RespawnManager } from "../combat/RespawnManager";
import { serverConfig } from "../config/serverConfig";
import { GameRoomPhase, GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { WeaponManager } from "../weapons/WeaponManager";
import {
  WeaponActionMessage,
  WeaponEquipMessage,
} from "../../../shared/combat/NetworkWeapons";

interface JoinOptions {
  name?: unknown;
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
const MAX_MOVEMENT_STATE = 4;

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

  /** Phase 4: server authority over HP / death / stats (combat module). */
  private combat!: CombatManager;
  /** Phase 4: server-driven respawn timers + spawn selection. */
  private respawns!: RespawnManager;
  /** Phase 5: server authority over every networked weapon. */
  private weapons!: WeaponManager;

  onCreate(): void {
    this.setState(new GameRoomState());
    // Private lobby: never listed in public matchmaking. Join happens
    // exclusively via roomId (invite link / manual code).
    this.setPrivate(true);

    this.combat = new CombatManager(this.state);
    this.combat.onPlayerDied = (event) => this.onPlayerDied(event);
    this.respawns = new RespawnManager(this.clock);

    // Phase 5 — GameRoom stays an orchestrator: receive message →
    // WeaponManager (validation + hit detection) → CombatManager →
    // broadcast result. All weapon logic lives in backend/src/weapons/.
    this.weapons = new WeaponManager({
      getPlayer: (id) => this.state.players.get(id),
      players: () => this.state.players.values(),
      applyDamage: (req) => this.combat.applyDamage(req),
      broadcastAction: (event) => this.broadcast("WEAPON_ACTION_CONFIRMED", event),
      sendHitConfirmed: (attackerId, ev) =>
        this.clientById(attackerId)?.send("HIT_CONFIRMED", ev),
      sendDamageTaken: (victimId, ev) =>
        this.clientById(victimId)?.send("DAMAGE_TAKEN", ev),
      sendImpulse: (victimId, impulse) =>
        this.clientById(victimId)?.send("APPLY_IMPULSE", impulse),
      now: () => Date.now(),
    });
    // Fixed 20 Hz combat tick (plasma DPS, oblit beam, rush, projectiles) —
    // damage uses the REAL deltaTime, never a per-frame loop.
    this.setSimulationInterval((deltaMs) => {
      if (this.state.phase === GameRoomPhase.PLAYING) {
        this.weapons.tick(deltaMs / 1000);
      }
    }, 50);

    this.onMessage("START_GAME", (client) => this.handleStartGame(client));
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
    this.state.players.delete(client.sessionId);
    console.log(
      `[GameRoom ${this.roomId}] ${player?.name ?? client.sessionId} left`,
    );
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
    // Shuffled copy → different games use different pads; index-per-player
    // guarantees distinct spawns while players ≤ spawn points.
    const shuffled = [...MULTIPLAYER_SPAWN_POINTS];
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
    if (seq <= player.seq) return;

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