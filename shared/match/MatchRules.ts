/**
 * SHARED match rules (FFA) — pure data, imported by the frontend (solo
 * timer, end screen) AND the backend (authoritative multiplayer clock).
 */

/** Length of one FFA match (seconds). */
export const MATCH_DURATION_SECONDS = 5 * 60;

/** Next-map vote countdown shown on the end screen (seconds). */
export const MAP_VOTE_SECONDS = 20;

/**
 * Extra time the SERVER waits before closing the vote: the end-screen intro
 * (glass shatter + title) plays before the vote countdown starts on the
 * clients (~2–5 s depending on victory / defeat).
 */
export const MAP_VOTE_INTRO_SECONDS = 5;

/**
 * After the vote, how long the room waits for its players to come back
 * (page reload onto the winning map) before it may auto-dispose when empty.
 */
export const LOBBY_REJOIN_GRACE_SECONDS = 90;

/** "4:59" — the HUD clock format. */
export function formatMatchClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
