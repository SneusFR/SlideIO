import { Schema, type } from "@colyseus/schema";

/**
 * Networked representation of a connected player (Phase 2).
 *
 * Identity comes from the Colyseus sessionId (`id`) — never from the
 * display name (two players may share the same name later).
 *
 * Transform fields are plain float32 primitives (never THREE objects):
 *   x / y / z  → capsule CENTER position in world meters
 *   yaw        → horizontal facing (radians, wrapped to [-PI, PI])
 *   pitch      → vertical look (radians) — stored for Phase 3 upper-body use
 *
 * NOTE (Phase 2): transforms are CLIENT-REPORTED and only sanity-checked.
 * Future authoritative movement (inputs → server simulation → prediction →
 * reconciliation) will replace/validate this — do NOT build other systems
 * on the assumption that the client stays the authority.
 */
export class NetworkPlayer extends Schema {
  /** Colyseus session id of the client (stable network identity). */
  @type("string") id = "";

  /** Display name chosen client-side (no account system yet). */
  @type("string") name = "";

  /** True for the lobby creator. HOST = lobby creator, NOT game authority. */
  @type("boolean") isHost = false;

  // ---- Transform (set by the server on spawn, then client-reported) ----
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") yaw = 0;
  @type("float32") pitch = 0;

  // ---- Phase 3: interpolation + animation payload ----
  /** Client-reported velocity (m/s) — remote extrapolation + anim speed. */
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") vz = 0;
  /** NetworkMovementState (0=IDLE 1=RUNNING 2=AIRBORNE 3=SLIDING 4=DASHING). */
  @type("uint8") state = 0;
  /** Client transform sequence (monotonic — stale packets are dropped). */
  @type("uint32") seq = 0;
  /** SERVER timestamp (ms) when this transform was accepted — the shared
   *  time base every client's snapshot interpolation relies on. */
  @type("float64") ts = 0;

  // ---- Phase 4: SERVER-AUTHORITATIVE combat state ----
  // These fields are written EXCLUSIVELY by the server (CombatManager /
  // RespawnManager). No client message can ever set them directly.

  /** Current HP (0..maxHealth) — clamped, never negative. */
  @type("uint16") health = 0;
  /** Max HP (from serverConfig.playerMaxHealth — never hardcoded). */
  @type("uint16") maxHealth = 0;
  /** False between a death and the server-driven respawn. */
  @type("boolean") isAlive = true;

  /** Match stats — the ONLY source of truth for the leaderboard. */
  @type("uint16") kills = 0;
  @type("uint16") deaths = 0;
  @type("uint16") assists = 0;

  /** SERVER timestamp (ms) of the scheduled respawn (0 while alive) —
   *  lets clients render a server-time based respawn countdown. */
  @type("float64") respawnAt = 0;

  // ---- Phase 5: SERVER-VALIDATED equipped weapon ----
  /** NetworkWeaponId string — written ONLY by the server (WeaponManager)
   *  after validating a WEAPON_EQUIP message. Remote clients read this to
   *  attach the right weapon model to the character's hand. */
  @type("string") weapon = "PLASMA_RIFLE";
}
