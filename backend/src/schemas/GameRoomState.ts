import { MapSchema, Schema, type } from "@colyseus/schema";
import { NetworkPlayer } from "./NetworkPlayer";

/** Explicit room lifecycle — the SERVER is the source of truth. */
export enum GameRoomPhase {
  LOBBY = "LOBBY",
  PLAYING = "PLAYING",
}

/**
 * Room state (Phase 2): connected players (keyed by session id) + the
 * current room phase. Gameplay combat state (HP, weapons…) comes later.
 */
export class GameRoomState extends Schema {
  @type({ map: NetworkPlayer }) players = new MapSchema<NetworkPlayer>();

  /** LOBBY until the host starts the game, then PLAYING (never back). */
  @type("string") phase: string = GameRoomPhase.LOBBY;
}