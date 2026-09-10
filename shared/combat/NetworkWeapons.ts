/**
 * SHARED combat contract (Phase 5) — pure TypeScript DATA only.
 *
 * Imported by BOTH the frontend (Vite) and the backend (Node/Colyseus).
 * MUST NEVER import Three.js, DOM, Rapier or Colyseus code.
 *
 * The server is the authority for every gameplay result computed from
 * these values; the client may read the same values for VFX/UI parity.
 */

/** Stable network identity of every equippable weapon. */
export enum NetworkWeaponId {
  PLASMA_RIFLE = "PLASMA_RIFLE",
  REVOLVER = "REVOLVER",
  OBLITERREUR = "OBLITERREUR",
  HAMMER = "HAMMER",
  SPEAR = "SPEAR",
  BASS_BLASTER = "BASS_BLASTER",
  POISON_SPRAYER = "POISON_SPRAYER",
  HEX_SNIPER = "HEX_SNIPER",
}

export function isNetworkWeaponId(raw: unknown): raw is NetworkWeaponId {
  return (
    typeof raw === "string" &&
    (Object.values(NetworkWeaponId) as string[]).includes(raw)
  );
}

/**
 * Logical weapon ACTIONS (events, not synced state).
 * The client says WHAT IT DID ("I fired in this direction"), never the
 * result ("I hit player X for Y damage") — the server validates everything.
 */
export enum WeaponActionType {
  /** Plasma Rifle continuous fire started / stopped (aim = transform yaw/pitch). */
  PLASMA_START = "PLASMA_START",
  PLASMA_STOP = "PLASMA_STOP",
  /** One revolver bullet (LMB single or RMB fan-fire — cadence validated server-side). */
  REVOLVER_FIRE = "REVOLVER_FIRE",
  /** Explosive revolver throw (server owns the projectile + AoE). */
  REVOLVER_THROW = "REVOLVER_THROW",
  /** Grounded hammer sweep (server melee-arc validation). */
  HAMMER_SWEEP = "HAMMER_SWEEP",
  /** Airborne ground slam started (visual broadcast; damage on impact msg). */
  HAMMER_SLAM_START = "HAMMER_SLAM_START",
  /** Ground slam landed — server computes the AoE around the reported impact. */
  HAMMER_SLAM_IMPACT = "HAMMER_SLAM_IMPACT",
  /** Spear horizontal sweep. */
  SPEAR_SWEEP = "SPEAR_SWEEP",
  /** Charged spear rush started / ended (rush hits are server ticks). */
  SPEAR_RUSH_START = "SPEAR_RUSH_START",
  SPEAR_RUSH_STOP = "SPEAR_RUSH_STOP",
  /** Obliterreur anchor placement (server re-raycasts + validates). */
  OBLITERREUR_PLACE = "OBLITERREUR_PLACE",
  /** Obliterreur vortex beam fired between the two anchors. */
  OBLITERREUR_FIRE = "OBLITERREUR_FIRE",
  /** MOLE STRIKE: dive underground (untargetable while burrowed). */
  MOLE_BURROW = "MOLE_BURROW",
  /** MOLE STRIKE: eruption — server computes the AoE around the point. */
  MOLE_EMERGE = "MOLE_EMERGE",
  /** One Bass Blaster musical note projectile (server simulates flight).
   *  px/py/pz piggyback the MUSIC GRAIN metadata (track index / playhead
   *  offset seconds / note index) so remote clients replay the exact same
   *  spatialized music fragment riding on the note. */
  BASS_FIRE = "BASS_FIRE",
  /** Lance-Poison continuous spray started / stopped (plasma-style). */
  POISON_START = "POISON_START",
  POISON_STOP = "POISON_STOP",
  /** HEX SNIPER: the creature projects its tongue along the aim (one
   *  shot — the server hitscans it; a grabbed player is reeled in by the
   *  server pull loop and bitten on arrival). */
  HEX_TONGUE_FIRE = "HEX_TONGUE_FIRE",
  /** VISUAL ONLY — the melee weapon is HELD (slot 2) / stowed again. The
   *  server-authoritative primary (WEAPON_EQUIP) never changes: this only
   *  drives the remote avatar's presentation. */
  MELEE_SHOW = "MELEE_SHOW",
  MELEE_HIDE = "MELEE_HIDE",
  /** VISUAL ONLY — weapon inspection started / cancelled (remote replay;
   *  a late arrival resumes at the elapsed time from `ts`). */
  INSPECT_START = "INSPECT_START",
  INSPECT_CANCEL = "INSPECT_CANCEL",
}

// ---------------------------------------------------------------------
// HEX SNIPER — server → clients action ids (NEVER sent by clients).
// Broadcast as WEAPON_ACTION_CONFIRMED events so every client replays
// the exact same tongue sequence the server decided.
// ---------------------------------------------------------------------

/** Tongue grabbed a player: `tid` = victim id, hx/hy/hz = grab point. */
export const HEX_ACTION_TONGUE_HIT = "HEX_TONGUE_HIT";
/** Tongue hit a wall / nothing: hx/hy/hz = tip end point (empty return). */
export const HEX_ACTION_TONGUE_MISS = "HEX_TONGUE_MISS";
/** Pull released WITHOUT a bite (blocked / timeout / death) — retract. */
export const HEX_ACTION_PULL_END = "HEX_PULL_END";
/** Victim arrived: the creature bites (`tid` = victim, hx/hy/hz = victim). */
export const HEX_ACTION_BITE = "HEX_BITE";

/**
 * Server → the VICTIM only: start / stop being reeled toward the attacker.
 * Movement is client-simulated (Phase 3 architecture), so the victim's
 * own character controller performs the pull toward the attacker's
 * displayed position — never a teleport, never through walls. The server
 * validates the ARRIVAL (distance check on its own transforms) and owns
 * every gameplay result (tongue damage, bite damage, knockback).
 */
export interface HexPullEvent {
  /** Attacker to be pulled toward (null when the pull stops). */
  attackerId: string | null;
  active: boolean;
}

export function isWeaponActionType(raw: unknown): raw is WeaponActionType {
  return (
    typeof raw === "string" &&
    (Object.values(WeaponActionType) as string[]).includes(raw)
  );
}

/** Hit zones shared by both sides (mirrors backend DamageTypes.HitZone). */
export enum NetworkHitZone {
  BODY = "BODY",
  HEAD = "HEAD",
}

// ---------------------------------------------------------------------
// Player hitbox constants (server hit detection ↔ frontend capsule)
// ---------------------------------------------------------------------

/**
 * CENTRAL character upscale factor: the Potato avatar renders 2.25 m tall
 * (1.80 m base × this factor), FEET ANCHORED. Every damage hitbox — the
 * server capsule/head-sphere below, the solo-bot hitboxes (BotModel) and
 * the local player's hit proxy (PlayerCombatant) — derives its dimensions
 * and vertical offsets from this single constant so client and server stay
 * coherent. The MOVEMENT capsule (MovementConfig / PlayerController / bot
 * colliders) is deliberately NOT scaled: this factor only affects what
 * shots can hit, never how characters move or collide.
 */
export const CHARACTER_HITBOX_SCALE = 1.25;

/**
 * HIT capsule tuned to the "Sprouty Smile" avatar silhouette (chubby chibi:
 * wider torso, huge head) at its REAL rendered height (1.80 m base ×
 * CHARACTER_HITBOX_SCALE = 2.25 m). FEET ANCHOR PRESERVED: the radius
 * grows with the silhouette while the half-height shrinks so that
 * halfHeight + radius stays 0.90 — the capsule still starts exactly at the
 * feet (movement capsule center = network y, PLAYER_FEET_OFFSET keeps
 * matching the frontend MovementConfig feet offset). The capsule spans
 * feet → 1.80 m; the scaled HEAD sphere covers the skull above it.
 */
export const PLAYER_CAPSULE_RADIUS = 0.42 * CHARACTER_HITBOX_SCALE; // 0.525
/** Capsule center → feet distance — UNSCALED feet anchor (movement capsule). */
export const PLAYER_FEET_OFFSET = 0.9;
export const PLAYER_CAPSULE_HALF_HEIGHT = PLAYER_FEET_OFFSET - PLAYER_CAPSULE_RADIUS; // 0.375
/** Head sphere center, relative to the CAPSULE CENTER (network y).
 *  Base 1.8 m avatar: head center 1.42 m above the feet (0.52 above the
 *  center). Scaled: 1.42 × 1.25 = 1.775 m above the feet — the feet anchor
 *  itself never scales, so the center offset becomes 1.775 − 0.9 = 0.875. */
export const PLAYER_HEAD_OFFSET =
  (0.52 + PLAYER_FEET_OFFSET) * CHARACTER_HITBOX_SCALE - PLAYER_FEET_OFFSET; // 0.875
export const PLAYER_HEAD_RADIUS = 0.36 * CHARACTER_HITBOX_SCALE; // 0.45
/** Eye height above the capsule center (fire-origin sanity checks).
 *  CAMERA constant, not a hitbox — never scaled (the movement capsule and
 *  the local camera eye offset are unchanged). */
export const PLAYER_EYE_OFFSET = 0.55;

// ---------------------------------------------------------------------
// Server-authoritative weapon tuning (mirrors the local weapon configs)
// ---------------------------------------------------------------------

export const NetworkWeaponConfig = {
  plasma: {
    damagePerSecond: 55,
    range: 160,
    supportsHeadshots: true,
    headshotMultiplier: 2.0,
    /** Server combat tick for the continuous beam (Hz — never per frame). */
    damageTickRate: 20,
    /** Safety: a beam older than this without a STOP is force-stopped (s). */
    maxContinuousSeconds: 12,
  },
  revolver: {
    capacity: 6,
    bodyDamage: 50,
    headDamage: 100, // intentional weapon-specific rule (NOT the global ×2)
    range: 300,
    primaryFireInterval: 0.28,
    fanFireInterval: 0.1,
    /** Cadence tolerance so honest clients never get refused by jitter. */
    cadenceTolerance: 0.35,
    throwSpeed: 24,
    throwGravity: 16,
    projectileMaxLifetime: 6,
    explosionRadius: 5,
    /** Fraction of the victim's MAX HP dealt by the explosion. */
    explosionDamageFraction: 0.25,
    materializeDuration: 0.45,
  },
  /** BRICK MAUL r5 (mirrors frontend HammerConfig — same result solo/multi). */
  hammer: {
    /** WHIRLWIND: FLAT damage per victim for the WHOLE attack (max once). */
    sweepDamage: 50,
    sweepRange: 3.4,
    /** Full circle — three visual turns around the attacker. */
    sweepArcDegrees: 360,
    sweepHeight: 1.9,
    /** Whole attack (server-side bounded attack state, advanced in tick). */
    sweepDuration: 1.35,
    /** Active damage phase inside the attack (s from the authoritative start). */
    sweepActiveStart: 0.2,
    sweepActiveEnd: 1.04,
    sweepKnockback: 17,
    sweepVerticalKnockback: 5.5,
    /** GROUND SLAM: FLAT damage per victim at the single impact. */
    slamDamage: 50,
    slamRadius: 6,
    slamHeightTolerance: 3.0,
    slamKnockback: 13,
    slamVerticalKnockback: 7,
    /** Reported slam impact must be within this distance of the attacker. */
    slamMaxImpactDistance: 6,
    /** Slam_Land recovery after the real contact (s) — attack still engaged. */
    slamRecovery: 0.72,
    /** Safety cap on a slam waiting for its impact (s) — a lost IMPACT
     *  message can never lock the attacker's melee forever. */
    slamMaxAirSeconds: 6,
  },
  spear: {
    sweepDamageFraction: 0.35,
    sweepRange: 4.5,
    sweepArcDegrees: 140,
    sweepHeight: 1.9,
    sweepDuration: 0.7,
    sweepCooldown: 0.55,
    sweepKnockback: 12,
    sweepVerticalKnockback: 4,
    rushDamageFraction: 0.5,
    rushCooldown: 5.0,
    rushMaxDuration: 5.0,
    rushHitRadius: 1.1,
    rushTipReach: 2.4,
    rushKnockback: 24,
    rushVerticalKnockback: 6,
  },
  obliterreur: {
    beamDuration: 5.0,
    /** Fraction of MAX HP per second inside the vortex volume. */
    damagePerSecondFraction: 1.0,
    beamRadius: 1.65,
    targetHitRadius: 0.85,
    damageTickRate: 20,
    placementRange: 200,
    curveStrength: 0.45,
    curveHandleMin: 2.0,
    curveHandleMax: 14.0,
    curveSampleCount: 48,
    /** Client-reported anchor accepted when within this distance of the
     *  server raycast hit (client/server collider mismatch tolerance, m). */
    anchorTolerance: 3.0,
  },
  /** Bass Blaster — musical SMG (mirrors frontend BassBlasterConfig). */
  bassBlaster: {
    magazineSize: 30,
    /** Seconds between shots while the trigger is held (~11.8 rounds/s). */
    fireInterval: 0.085,
    /** Cadence tolerance so honest clients never get refused by jitter. */
    cadenceTolerance: 0.35,
    reloadDuration: 1.2,
    bodyDamage: 20,
    headDamage: 40, // weapon-specific ×2 head bonus
    /** Forward speed of a fired note (m/s) — straight flight, no gravity. */
    projectileSpeed: 140,
    /** Max flight time before a note fizzles out (s) → ~224 m range. */
    projectileLifetime: 1.6,
  },
  /** Lance-Poison — short-range continuous sprayer (mirrors PoisonConfig). */
  poison: {
    damagePerSecond: 65,
    /** Very short reach — the whole identity of the weapon. */
    range: 9,
    /** Poison never headshots (gas/liquid cone). */
    supportsHeadshots: false,
    /** Full tank spray time (capacity / drainPerSecond, s) — the server
     *  force-stops a stream that outlives a full tank + margin. */
    maxContinuousSeconds: 8.5,
  },
  /** HEX SNIPER — monster-head sniper (mirrors frontend HexSniperConfig). */
  hexSniper: {
    /** Flat damage the instant the tongue grabs a player. */
    tongueDamage: 50,
    /** Swept tongue radius (m) — widens the server hitscan capsule test. */
    tongueRadius: 0.16,
    /** No weapon range by design: the map bounds stop the tongue. This is
     *  the server ray length covering the whole map diagonal (m). */
    maxRange: 400,
    /** Anti-spam floor between two tongue shots (s) — the local weapon
     *  itself is single-shot (busy until the tongue is back). */
    fireCooldown: 0.25,
    /** Reel-in speed of the grabbed player (m/s) — victim-side movement. */
    pullSpeed: 60,
    /** Arrival gap kept between the victim and the shooter (m). */
    pullStopDistance: 1.6,
    /** Extra arrival tolerance on the SERVER distance check (m): the two
     *  transforms are client-reported at ~30 Hz — never exact. */
    arrivalTolerance: 0.9,
    /** Hard cap on one pull (s): a stuck / cheating victim is released. */
    pullMaxSeconds: 4,
    /** Release when the victim made no distance progress for this long (s)
     *  — blocked by a wall / ledge (mirrors the local pull-blocked rule). */
    pullStallSeconds: 0.6,
    /** Progress threshold per stall window (m). */
    pullStallMinProgress: 0.25,
    /** Flat bite damage on the reeled-in victim (arrival bite only). */
    biteDamage: 50,
    biteKnockback: 9,
    biteVerticalKnockback: 3,
  },
  /** MOLE STRIKE killstreak (mirrors frontend MoleStrikeConfig). */
  mole: {
    /** Damage radius around the emergence point (m). */
    radius: 7,
    /** Fraction of each victim's MAX HP dealt by the eruption. */
    damageFraction: 0.75,
    /** Vertical band around the emergence point that can be hit (m). */
    heightTolerance: 3.5,
    knockback: 16,
    verticalKnockback: 6,
    /** Reported emerge point must be near the attacker transform (m). */
    maxImpactDistance: 6,
    /** Max legal burrow time (underground + transitions + margin, s). */
    maxBurrowSeconds: 6.5,
  },
} as const;

// ---------------------------------------------------------------------
// Message payload shapes (client → server / server → clients)
// ---------------------------------------------------------------------

/** Client → server: equip a weapon (logical ID only, never asset paths). */
export interface WeaponEquipMessage {
  weapon: string;
}

/** Client → server: a gameplay ACTION (origin/direction, never results). */
export interface WeaponActionMessage {
  action: string;
  /** Monotonic per-client sequence — dedup / stale rejection. */
  seq: number;
  /**
   * VIEW TIME (ms, server clock estimate): the render timestamp at which
   * the shooter SAW the remote players when the action was performed
   * (renderTime = estimatedServerNow − interpolationDelay). The server
   * rewinds its transform history to this exact time (clamped to a hard
   * safety window) so hits match what the shooter actually aimed at.
   * Absent/aberrant values fall back to a fixed conservative rewind.
   */
  vt?: number;
  /** Fire origin (eye position) — sanity-validated against the transform. */
  ox?: number;
  oy?: number;
  oz?: number;
  /** Normalized fire direction. */
  dx?: number;
  dy?: number;
  dz?: number;
  /** Extra point (slam impact, oblit anchor, mole feet…). */
  px?: number;
  py?: number;
  pz?: number;
  /** Obliterreur anchor SLOT (0 = A, 1 = B) — keeps both sides in
   *  lockstep with the local placement alternation. */
  pi?: number;
}

/** Server → all clients: a VALIDATED action to replay (VFX / audio / anim). */
export interface WeaponActionConfirmedEvent {
  playerId: string;
  weapon: string;
  action: string;
  seq: number;
  /**
   * SERVER clock (ms) at which the action was accepted = authoritative start
   * of its phase. Remote clients reconstruct a late arrival's elapsed time
   * from it (NetworkClock estimate): whirlwind / smash / inspection resume
   * at the right frame instead of restarting. Absent on legacy events.
   */
  ts?: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  /** Server hit point of the action ray/AoE (VFX impact), if any. */
  hx?: number;
  hy?: number;
  hz?: number;
  /** Obliterreur: second anchor / extra data. */
  px?: number;
  py?: number;
  pz?: number;
  /** HEX SNIPER: the grabbed / bitten victim id (remote tether anchor). */
  tid?: string;
}

/** Server → attacker: your hit was CONFIRMED (hitmarker source of truth). */
export interface HitConfirmedEvent {
  targetId: string;
  hitZone: string;
  damageDealt: number;
  killed: boolean;
  weapon: string;
}

/** Server → victim: you took damage (directional damage feedback). */
export interface DamageTakenEvent {
  attackerId: string | null;
  amount: number;
  /** Attacker world position at damage time (red-indicator direction). */
  ax?: number;
  ay?: number;
  az?: number;
}

/** Server → victim: knockback impulse (victim's local physics applies it). */
export interface ApplyImpulseEvent {
  x: number;
  y: number;
  z: number;
}