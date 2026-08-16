import { Client, Room } from "colyseus.js";
import { MultiplayerConfig } from "./MultiplayerConfig";
import type {
  WeaponActionConfirmedEvent,
  HitConfirmedEvent,
  DamageTakenEvent,
  ApplyImpulseEvent,
} from "../../shared/combat/NetworkWeapons";

/** Snapshot of a networked player (mirrors the backend NetworkPlayer). */
export interface NetworkPlayerInfo {
  id: string;
  name: string;
  isHost: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  // ---- Phase 3: interpolation + animation payload ----
  /** Client-reported velocity (m/s) — extrapolation + animation speed. */
  vx: number;
  vy: number;
  vz: number;
  /** NetworkMovementState as a raw number (sanitized before use). */
  state: number;
  /** Client transform sequence (monotonic; stale packets are rejected). */
  seq: number;
  /** SERVER timestamp (ms) at which this transform was accepted. */
  ts: number;
  // ---- Phase 4: SERVER-OWNED combat state (read-only on the client) ----
  health: number;
  maxHealth: number;
  isAlive: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** Server time (ms) of the scheduled respawn (0 while alive). */
  respawnAt: number;
  // ---- Phase 5: SERVER-VALIDATED equipped weapon (NetworkWeaponId) ----
  weapon: string;
}

/** Server → clients: someone died (killfeed / medals / VFX hooks). */
export interface PlayerDiedEvent {
  victimId: string;
  killerId: string | null;
  damageType: string;
  hitZone: string;
  isHeadshot: boolean;
}

/** Server → clients: someone respawned (hard teleport — never interpolate). */
export interface PlayerRespawnedEvent {
  playerId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Compact local transform sent to the server (primitives only).
 * Phase 3: also carries velocity + movement state + a client sequence
 * (one compact message — never separate TRANSFORM/ANIMATION packets).
 */
export interface LocalTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  state: number;
  seq: number;
}

/** Friendly error categories the UI can render nicely. */
export type MultiplayerErrorKind =
  | "not_found"
  | "full"
  | "in_progress"
  | "unavailable"
  | "unknown";

export class MultiplayerError extends Error {
  constructor(
    readonly kind: MultiplayerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MultiplayerError";
  }
}

/**
 * Thin wrapper around the Colyseus client — the ONLY place in the frontend
 * that talks to the multiplayer server. Centralizes connect / create / join /
 * leave, phase changes (LOBBY → PLAYING) and transform messages.
 *
 * Phase 2 NOTE: movement is client-reported (transform messages) — future
 * authoritative movement will replace/validate this flow.
 */
export class MultiplayerClient {
  /** Fired whenever the player list changes (join/leave/rename). */
  onPlayersChanged: ((players: NetworkPlayerInfo[]) => void) | null = null;
  /** Fired once when the room phase flips (e.g. LOBBY → PLAYING). */
  onPhaseChanged: ((phase: string) => void) | null = null;
  /**
   * Fired when the room connection ends for any reason.
   * `intentional` is true for a clean local leave, false for a drop/kick.
   */
  onLeft: ((intentional: boolean) => void) | null = null;
  /** Phase 4: server PLAYER_DIED event (authoritative death). */
  onPlayerDied: ((event: PlayerDiedEvent) => void) | null = null;
  /** Phase 4: server PLAYER_RESPAWNED event (authoritative respawn). */
  onPlayerRespawned: ((event: PlayerRespawnedEvent) => void) | null = null;
  // ---- Phase 5: server weapon events ----
  /** A VALIDATED weapon action to replay (remote VFX / audio / anim). */
  onWeaponActionConfirmed: ((event: WeaponActionConfirmedEvent) => void) | null = null;
  /** The server confirmed one of OUR hits (hitmarker source of truth). */
  onHitConfirmed: ((event: HitConfirmedEvent) => void) | null = null;
  /** We took server-validated damage (directional damage feedback). */
  onDamageTaken: ((event: DamageTakenEvent) => void) | null = null;
  /** Server knockback impulse for the LOCAL player. */
  onApplyImpulse: ((event: ApplyImpulseEvent) => void) | null = null;

  private client: Client | null = null;
  private room: Room | null = null;
  /** True while we are intentionally leaving (suppresses onLeft feedback). */
  private leavingIntentionally = false;
  /** Last phase seen, to fire onPhaseChanged exactly on transitions. */
  private lastPhase = "";
  /** Monotonic per-client weapon action sequence (server dedup). */
  private weaponSeq = 0;

  get isConnected(): boolean {
    return this.room !== null;
  }

  get roomId(): string | null {
    return this.room?.roomId ?? null;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /** Current room phase ("LOBBY" | "PLAYING") or null if not connected. */
  get phase(): string | null {
    return (this.room?.state as RoomStateLike | undefined)?.phase ?? null;
  }

  /** Create a new private lobby and join it as HOST. */
  async createLobby(displayName: string): Promise<void> {
    const client = this.ensureClient();
    try {
      const room = await client.create(MultiplayerConfig.roomName, { name: displayName });
      this.bindRoom(room);
      logDev(`Created + joined room ${room.roomId}`);
    } catch (err) {
      throw toMultiplayerError(err);
    }
  }

  /** Join an existing lobby by room id (invite link or manual code). */
  async joinLobby(roomId: string, displayName: string): Promise<void> {
    const client = this.ensureClient();
    try {
      const room = await client.joinById(roomId, { name: displayName });
      this.bindRoom(room);
      logDev(`Joined room ${room.roomId}`);
    } catch (err) {
      throw toMultiplayerError(err);
    }
  }

  /** Leave the current room cleanly (no page reload needed). */
  async leaveLobby(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.leavingIntentionally = true;
    try {
      await room.leave(true);
    } catch {
      /* connection may already be gone — that's fine */
    }
    // onLeave handler performs the cleanup.
  }

  /** Ask the server to start the game (server validates the host). */
  requestStartGame(): void {
    this.room?.send("START_GAME");
  }

  /**
   * Send the local player transform (Phase 2 client-reported movement).
   * Values are rounded — centimeter/milliradian precision is plenty.
   */
  sendTransform(t: LocalTransform): void {
    this.room?.send("PLAYER_TRANSFORM", {
      x: round3(t.x),
      y: round3(t.y),
      z: round3(t.z),
      yaw: round3(t.yaw),
      pitch: round3(t.pitch),
      vx: round3(t.vx),
      vy: round3(t.vy),
      vz: round3(t.vz),
      state: t.state,
      seq: t.seq,
    });
  }

  /**
   * DEV-ONLY: exercise the server damage pipeline before weapons are
   * networked (Phase 5). The server hard-refuses this in production.
   */
  sendDebugDamage(targetId: string, amount: number): void {
    if (!import.meta.env.DEV) return;
    this.room?.send("DEBUG_DAMAGE", { targetId, amount });
  }

  // ------------------------------------------------------------------
  // Phase 5 — weapon messages (client says WHAT IT DID, never results)
  // ------------------------------------------------------------------

  /** Equip a weapon by its logical NetworkWeaponId (server validates). */
  sendWeaponEquip(weapon: string): void {
    this.room?.send("WEAPON_EQUIP", { weapon });
  }

  /**
   * Send one weapon ACTION (origin / direction / extra point only — the
   * server computes every hit). The sequence is auto-incremented here so
   * every call site stays trivially correct.
   */
  sendWeaponAction(
    action: string,
    data: {
      ox?: number;
      oy?: number;
      oz?: number;
      dx?: number;
      dy?: number;
      dz?: number;
      px?: number;
      py?: number;
      pz?: number;
      /** Obliterreur anchor slot (0 = A, 1 = B). */
      pi?: number;
    } = {},
  ): void {
    if (!this.room) return;
    this.weaponSeq++;
    this.room.send("WEAPON_ACTION", {
      action,
      seq: this.weaponSeq,
      ...(data.ox !== undefined ? { ox: round3(data.ox), oy: round3(data.oy ?? 0), oz: round3(data.oz ?? 0) } : {}),
      ...(data.dx !== undefined ? { dx: round3(data.dx), dy: round3(data.dy ?? 0), dz: round3(data.dz ?? 0) } : {}),
      ...(data.px !== undefined ? { px: round3(data.px), py: round3(data.py ?? 0), pz: round3(data.pz ?? 0) } : {}),
      ...(data.pi !== undefined ? { pi: data.pi } : {}),
    });
  }

  /** Snapshot of every player currently in the room state. */
  getPlayers(): NetworkPlayerInfo[] {
    const state = this.room?.state as RoomStateLike | undefined;
    if (!state?.players) return [];

    const players: NetworkPlayerInfo[] = [];
    state.players.forEach((p, key) => {
      players.push({
        id: p.id ?? key,
        name: p.name ?? "PLAYER",
        isHost: p.isHost === true,
        x: p.x ?? 0,
        y: p.y ?? 0,
        z: p.z ?? 0,
        yaw: p.yaw ?? 0,
        pitch: p.pitch ?? 0,
        vx: p.vx ?? 0,
        vy: p.vy ?? 0,
        vz: p.vz ?? 0,
        state: p.state ?? 0,
        seq: p.seq ?? 0,
        ts: p.ts ?? 0,
        health: p.health ?? 100,
        maxHealth: p.maxHealth ?? 100,
        isAlive: p.isAlive !== false,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        assists: p.assists ?? 0,
        respawnAt: p.respawnAt ?? 0,
        weapon: p.weapon ?? "PLASMA_RIFLE",
      });
    });
    return players;
  }

  /** This client's own player snapshot (server-assigned spawn included). */
  getLocalPlayer(): NetworkPlayerInfo | null {
    const me = this.sessionId;
    if (!me) return null;
    return this.getPlayers().find((p) => p.id === me) ?? null;
  }

  // ------------------------------------------------------------------

  private ensureClient(): Client {
    if (!this.client) {
      this.client = new Client(MultiplayerConfig.serverUrl);
      logDev(`Client ready → ${MultiplayerConfig.serverUrl}`);
    }
    return this.client;
  }

  private bindRoom(room: Room): void {
    this.room = room;
    this.leavingIntentionally = false;
    this.lastPhase = "";

    // Rooms are small: rebuild the full list on every state patch. Simple,
    // robust, and version-agnostic w.r.t. schema callbacks.
    room.onStateChange(() => {
      this.emitPlayers();
      this.emitPhase();
    });

    room.onError((code, message) => {
      logDev(`Room error ${code}: ${message ?? ""}`);
    });

    // ---- Phase 4: explicit combat events (death / respawn) ----
    // State patches carry the numbers; these events exist so clients can
    // trigger one-shot feedback (death FX, snapshot-buffer resets) reliably.
    room.onMessage("PLAYER_DIED", (message: Partial<PlayerDiedEvent>) => {
      if (typeof message?.victimId !== "string") return;
      this.onPlayerDied?.({
        victimId: message.victimId,
        killerId: typeof message.killerId === "string" ? message.killerId : null,
        damageType: typeof message.damageType === "string" ? message.damageType : "DEBUG",
        hitZone: typeof message.hitZone === "string" ? message.hitZone : "BODY",
        isHeadshot: message.isHeadshot === true,
      });
    });
    room.onMessage("PLAYER_RESPAWNED", (message: Partial<PlayerRespawnedEvent>) => {
      if (typeof message?.playerId !== "string") return;
      this.onPlayerRespawned?.({
        playerId: message.playerId,
        x: typeof message.x === "number" ? message.x : 0,
        y: typeof message.y === "number" ? message.y : 0,
        z: typeof message.z === "number" ? message.z : 0,
        yaw: typeof message.yaw === "number" ? message.yaw : 0,
      });
    });

    // ---- Phase 5: server weapon events ----
    room.onMessage("WEAPON_ACTION_CONFIRMED", (message: Partial<WeaponActionConfirmedEvent>) => {
      if (typeof message?.playerId !== "string" || typeof message?.action !== "string") return;
      this.onWeaponActionConfirmed?.({
        playerId: message.playerId,
        weapon: typeof message.weapon === "string" ? message.weapon : "PLASMA_RIFLE",
        action: message.action,
        seq: typeof message.seq === "number" ? message.seq : 0,
        ox: num(message.ox),
        oy: num(message.oy),
        oz: num(message.oz),
        dx: num(message.dx),
        dy: num(message.dy),
        dz: num(message.dz),
        ...(typeof message.hx === "number"
          ? { hx: message.hx, hy: num(message.hy), hz: num(message.hz) }
          : {}),
        ...(typeof message.px === "number"
          ? { px: message.px, py: num(message.py), pz: num(message.pz) }
          : {}),
      });
    });
    room.onMessage("HIT_CONFIRMED", (message: Partial<HitConfirmedEvent>) => {
      if (typeof message?.targetId !== "string") return;
      this.onHitConfirmed?.({
        targetId: message.targetId,
        hitZone: typeof message.hitZone === "string" ? message.hitZone : "BODY",
        damageDealt: num(message.damageDealt),
        killed: message.killed === true,
        weapon: typeof message.weapon === "string" ? message.weapon : "PLASMA_RIFLE",
      });
    });
    room.onMessage("DAMAGE_TAKEN", (message: Partial<DamageTakenEvent>) => {
      this.onDamageTaken?.({
        attackerId: typeof message?.attackerId === "string" ? message.attackerId : null,
        amount: num(message?.amount),
        ax: typeof message?.ax === "number" ? message.ax : undefined,
        ay: typeof message?.ay === "number" ? message.ay : undefined,
        az: typeof message?.az === "number" ? message.az : undefined,
      });
    });
    room.onMessage("APPLY_IMPULSE", (message: Partial<ApplyImpulseEvent>) => {
      this.onApplyImpulse?.({ x: num(message?.x), y: num(message?.y), z: num(message?.z) });
    });

    room.onLeave(() => {
      const intentional = this.leavingIntentionally;
      this.room = null;
      this.leavingIntentionally = false;
      logDev(intentional ? "Left room" : "Disconnected from room");
      this.onLeft?.(intentional);
    });

    // Emit the initial state (already available after create/join).
    this.emitPlayers();
    this.emitPhase();
  }

  private emitPlayers(): void {
    if (!this.room) return;
    this.onPlayersChanged?.(this.getPlayers());
  }

  private emitPhase(): void {
    const phase = this.phase;
    if (!phase || phase === this.lastPhase) return;
    this.lastPhase = phase;
    logDev(`Room phase → ${phase}`);
    this.onPhaseChanged?.(phase);
  }
}

/** Shape of the reflected room state / NetworkPlayer schema on the client. */
interface RoomStateLike {
  phase?: string;
  players?: {
    forEach(cb: (p: NetworkPlayerLike, key: string) => void): void;
  };
}

interface NetworkPlayerLike {
  id?: string;
  name?: string;
  isHost?: boolean;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  state?: number;
  seq?: number;
  ts?: number;
  health?: number;
  maxHealth?: number;
  isAlive?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  respawnAt?: number;
  weapon?: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Untrusted number → finite number (0 fallback). */
function num(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** Map raw Colyseus / network errors to friendly categories. */
function toMultiplayerError(err: unknown): MultiplayerError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes("already started") || lower.includes("in progress")) {
    return new MultiplayerError("in_progress", message);
  }
  if (lower.includes("not found") || lower.includes("expired") || lower.includes("invalid room")) {
    return new MultiplayerError("not_found", message);
  }
  if (lower.includes("locked") || lower.includes("full") || lower.includes("max")) {
    return new MultiplayerError("full", message);
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("econnrefused") ||
    lower.includes("network request failed") ||
    err instanceof TypeError ||
    err instanceof ProgressEvent
  ) {
    return new MultiplayerError("unavailable", message);
  }
  return new MultiplayerError("unknown", message);
}

function logDev(message: string): void {
  if (import.meta.env.DEV) console.log(`[Multiplayer] ${message}`);
}