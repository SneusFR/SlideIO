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
 * HIT capsule tuned to the "Sprouty Smile" avatar silhouette (chubby chibi:
 * wider torso, huge head). Radius/half-height changed TOGETHER so that
 * halfHeight + radius stays 0.90 — the capsule still spans exactly
 * feet → top of head and PLAYER_FEET_OFFSET keeps matching the frontend
 * MovementConfig feet offset (movement capsule center = network y).
 */
export const PLAYER_CAPSULE_RADIUS = 0.42;
export const PLAYER_CAPSULE_HALF_HEIGHT = 0.48; // cylinder half-height
/** Capsule center → feet distance (= halfHeight + radius). */
export const PLAYER_FEET_OFFSET = PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
/** Head sphere center, relative to the CAPSULE CENTER (network y).
 *  Sprouty Smile's head is nearly half the body: in the normalized 1.8 m
 *  avatar it spans ≈ 1.04 → 1.80 above the feet → center ≈ 0.52 above the
 *  capsule center with a ≈ 0.36 radius. */
export const PLAYER_HEAD_OFFSET = 0.52;
export const PLAYER_HEAD_RADIUS = 0.36;
/** Eye height above the capsule center (fire-origin sanity checks). */
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
  hammer: {
    /** Damage = fraction of the TARGET's max HP. */
    sweepDamageFraction: 0.5,
    sweepRange: 3.4,
    sweepArcDegrees: 120,
    sweepHeight: 1.9,
    sweepDuration: 0.62,
    sweepCooldown: 0.5, // server anti-spam floor between sweeps
    sweepKnockback: 17,
    sweepVerticalKnockback: 5.5,
    slamDamageFraction: 0.5,
    slamRadius: 6,
    slamHeightTolerance: 3.0,
    slamKnockback: 13,
    slamVerticalKnockback: 7,
    /** Reported slam impact must be within this distance of the attacker. */
    slamMaxImpactDistance: 6,
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