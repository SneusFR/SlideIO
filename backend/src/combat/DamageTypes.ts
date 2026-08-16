/**
 * Server-side combat enums (Phase 4).
 *
 * String enums on purpose: they travel through messages/logs in a
 * human-readable form and mirror the frontend weapon identities without
 * importing frontend code (backend stays a standalone package).
 *
 * Phase 4 only USES DEBUG (dev damage tool). The real weapons are listed
 * now so Phase 5 (networked weapons) plugs into applyDamage() without
 * touching this file's consumers.
 */
export enum DamageType {
  DEBUG = "DEBUG",
  PLASMA = "PLASMA",
  REVOLVER = "REVOLVER",
  REVOLVER_EXPLOSION = "REVOLVER_EXPLOSION",
  HAMMER = "HAMMER",
  SPEAR = "SPEAR",
  OBLITERREUR = "OBLITERREUR",
  MOLE_STRIKE = "MOLE_STRIKE",
  ENVIRONMENT = "ENVIRONMENT",
}

/**
 * Where a hit landed. Phase 4 transports it end-to-end (damage → death
 * event) but applies NO headshot multiplier yet — the headshot phase will
 * compute/validate the zone server-side.
 */
export enum HitZone {
  BODY = "BODY",
  HEAD = "HEAD",
}

/** Type guards for untrusted message payloads. */
export function isDamageType(raw: unknown): raw is DamageType {
  return typeof raw === "string" && (Object.values(DamageType) as string[]).includes(raw);
}

export function isHitZone(raw: unknown): raw is HitZone {
  return typeof raw === "string" && (Object.values(HitZone) as string[]).includes(raw);
}