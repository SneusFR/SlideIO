import { MapSchema, Schema, type } from "@colyseus/schema";
import { NetworkPlayer } from "./NetworkPlayer";

/** Explicit room lifecycle — the SERVER is the source of truth. */
export enum GameRoomPhase {
  LOBBY = "LOBBY",
  PLAYING = "PLAYING",
  /** Match clock ran out: end screen + next-map vote, then back to LOBBY. */
  ENDED = "ENDED",
}

/**
 * Room state (Phase 2): connected players (keyed by session id) + the
 * current room phase. Gameplay combat state (HP, weapons…) comes later.
 */
export class GameRoomState extends Schema {
  @type({ map: NetworkPlayer }) players = new MapSchema<NetworkPlayer>();

  /**
   * LOBBY → PLAYING (host start) → ENDED (match clock ran out, map vote)
   * → LOBBY again on the voted map.
   */
  @type("string") phase: string = GameRoomPhase.LOBBY;

  /** MapId the room plays on (set at creation, then by the end-of-match vote). */
  @type("string") mapId: string = "JUNGLE";

  /** SERVER time (ms) at which the running match ends (0 outside a match). */
  @type("float64") matchEndsAt = 0;
}