import dotenv from "dotenv";

dotenv.config();

/**
 * Central server configuration — every tunable value lives here so the
 * rest of the backend never reads process.env directly.
 */
export const serverConfig = {
  /** HTTP + WebSocket port (Colyseus default: 2567). */
  port: parseInt(process.env.PORT ?? "2567", 10),

  /** Room type name used by the client when creating/joining lobbies. */
  roomName: "game_room",

  /** SlideIO is designed for up to 8 players per match. */
  maxClientsPerRoom: 8,

  /** Phase 2: START GAME unlocks once this many players are in the lobby. */
  minPlayersToStart: 2,

  /**
   * Allowed browser origins for the matchmaking HTTP requests.
   * Comma-separated list in CORS_ORIGIN (e.g. the Vercel domain later).
   */
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),

  // ---- Phase 4: server-authoritative combat state ----

  /** HP every player spawns/respawns with. NEVER hardcode 100 elsewhere. */
  playerMaxHealth: 100,

  /** Seconds between a death and the server-driven respawn. */
  respawnDelay: 3.0,

  /** Seconds of damage immunity right after a (re)spawn. */
  respawnInvulnerability: 1.0,

  /** Assist window: damage older than this (seconds) never counts. */
  assistWindowSeconds: 8.0,

  /** Minimum fraction of the victim's max HP to be credited an assist. */
  assistMinDamageFraction: 0.15,

  /** Hard cap for a single damage application (sanity clamp). */
  maxSingleDamage: 1000,

  /**
   * DEV-ONLY debug damage tool (DEBUG_DAMAGE message). NEVER enabled in
   * production — a client must never be able to ask "kill player X" for
   * real. Delete this flag (and the GameRoom handler) once real weapons
   * are networked.
   */
  debugDamageEnabled: process.env.NODE_ENV !== "production",
} as const;
