/**
 * Central multiplayer configuration for the frontend.
 *
 * The backend URL comes from VITE_MULTIPLAYER_SERVER_URL (see .env.example);
 * it falls back to the local Colyseus default so `npm run dev` works with
 * zero setup. Never hardcode the server URL anywhere else.
 */
export const MultiplayerConfig = {
  /** WebSocket endpoint of the Colyseus server. */
  serverUrl:
    (import.meta.env.VITE_MULTIPLAYER_SERVER_URL as string | undefined) ??
    "ws://localhost:2567",

  /** Room type registered on the backend (see backend serverConfig). */
  roomName: "game_room",

  /** URL prefix used for invite links: {origin}/join/{roomId}. */
  joinPathPrefix: "/join/",

  /** localStorage key for the player's display name. */
  displayNameStorageKey: "slideio.displayName",

  /** Max length for display names (mirrors backend sanitization). */
  maxNameLength: 20,

  /** Phase 2: START GAME unlocks with this many players (mirrors backend). */
  minPlayersToStart: 2,

  // ---- Network tick (SEPARATE from the render tick) ----
  /**
   * Local transform updates sent per second. 30 Hz halves the average
   * sampling latency vs 20 Hz (payload is tiny) — combined with the
   * server patch rate + interpolation delay this is what other players
   * FEEL as responsiveness.
   */
  transformSendRate: 30,
  /** Don't resend while perfectly still: min position delta (meters). */
  positionEpsilon: 0.01,
  /** Min yaw/pitch delta (radians) before a resend. */
  rotationEpsilon: 0.005,
  /** Rare keep-alive while idle (seconds between forced sends). */
  transformHeartbeat: 2.0,

  /** Remote avatar smoothing factor (light lerp only — Phase 3 will bring
   *  proper snapshot interpolation). */
  remoteLerpSpeed: 14,
} as const;

/** Build a shareable invite link for a room, based on the current origin. */
export function buildInviteLink(roomId: string): string {
  return `${window.location.origin}${MultiplayerConfig.joinPathPrefix}${roomId}`;
}

/** Extract the room id from a `/join/{roomId}` path, or null. */
export function parseJoinRoomId(pathname: string): string | null {
  const match = /^\/join\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return match ? match[1] : null;
}

/** Load the persisted display name (or null if never set). */
export function loadDisplayName(): string | null {
  try {
    const name = localStorage.getItem(MultiplayerConfig.displayNameStorageKey);
    return name && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/** Persist the display name for future sessions. */
export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(
      MultiplayerConfig.displayNameStorageKey,
      name.trim().slice(0, MultiplayerConfig.maxNameLength),
    );
  } catch {
    /* private browsing — non-fatal */
  }
}

/** Temporary guest name for players joining via invite without a profile. */
export function generateGuestName(): string {
  return `PLAYER ${Math.floor(10 + Math.random() * 90)}`;
}