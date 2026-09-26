/**
 * POPCORN SHOTGUN — SHARED gameplay rules (pure TypeScript, no Three.js).
 *
 * Imported by the frontend (local prediction + remote visuals) AND by the
 * backend (authoritative damage). The same seed gives the same 12 pellet
 * directions everywhere: the shooter sends its seed with POPCORN_FIRE, the
 * server recomputes the pellets from it, remote clients replay them.
 *
 * Reference: src/weapons/popcorn/PopcornSpread.ts (pack v5.1). The PRNG,
 * the draw order and the ring construction are IDENTICAL (checked by
 * scripts/test-popcorn-shotgun.mts); only the ring radii are re-tuned for
 * the REAL SlideIO hit volumes (server: 1.05 m wide body capsule + 0.9 m
 * head sphere — far bigger than the 0.44 × 0.78 m target of the pack).
 *
 * One deliberate difference with the pack: the pattern's "up" axis is the
 * camera up WITHOUT roll (derived from forward + world Y). The server only
 * receives the forward direction and the local camera rolls a little
 * (strafe tilt, impact shake): a rolled up axis would rotate the pattern
 * and break the client/server parity.
 */
import {
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_HEAD_OFFSET,
  PLAYER_HEAD_RADIUS,
} from "./NetworkWeapons";

export interface PopcornVec3 {
  x: number;
  y: number;
  z: number;
}

export interface PopcornRing {
  n: number;
  deg: number;
  phaseDeg: number;
}

export const PopcornShotgunConfig = {
  /** Popcorn loads per reload (tank: full → half → empty). */
  shots: 2,
  /** Pellets per shot = sum of the ring counts below. */
  pellets: 12,
  /**
   * Pattern rings (degrees from the aim axis). Pack reference: 1.6° / 3.4°
   * tuned on a 0.44 × 0.78 m target. SlideIO hit volumes are far bigger
   * (server capsule Ø 1.05 m + head sphere r 0.45 m, solo bot boxes
   * 0.875 m wide): with the pack radii a body shot still killed at 10 m.
   * 4.2° / 8.4° restores the pack's distance profile on the REAL volumes
   * (12 · 10.2 · 8.8 · 7.3 · 5.2 · 3.4 · 2.2 · 1.6 · 1.0 · 1.0 pellets at
   * 2 · 4 · 5 · 6 · 8 · 10 · 12 · 15 · 20 · 30 m — table printed by
   * scripts/test-popcorn-shotgun.mts). Tighter = more range.
   */
  rings: [
    { n: 1, deg: 0, phaseDeg: 0 },
    { n: 5, deg: 4.2, phaseDeg: 0 },
    { n: 6, deg: 8.4, phaseDeg: 30 },
  ] as readonly PopcornRing[],
  /** Per-pellet gaussian noise (degrees, standard deviation). */
  jitterDeg: 0.25,
  /** Beyond this distance a pellet hits nothing (m). */
  maxRange: 40,
  /** Share of MAX HP removed by ONE full-power pellet (8 pellets = kill). */
  pelletDamageFraction: 1 / 8,
  /** Distance falloff: 100 % until 8 m, 50 % at 18 m, 25 % from 28 m. */
  falloff: { fullUntil: 8, halfAt: 18, quarterFrom: 28 },
  /** Imposed rule: at least one pellet in the head = one shot. */
  headshotOneShot: true,
  /**
   * OPTIONAL range cap of the head one-shot rule (m). null = no cap (the
   * rule as specified). Tuning knob only — see the integration report.
   */
  headshotOneShotMaxRange: null as number | null,
  /**
   * Authored timelines (seconds) — MUST match
   * src/assets/potato/WeaponProfile_PopcornShotgun.json → actions
   * (asserted by scripts/test-popcorn-shotgun.mts). Duplicated here
   * because the backend cannot import frontend assets.
   */
  timeline: {
    fireReady: 0.58,
    fireLastReady: 0.3,
    reloadAmmoRefilled: 1.75,
    reloadReady: 2.06,
    reloadDuration: 2.2,
  },
  /**
   * Server tolerance on the cadence / reload gates (s): two messages sent
   * 0.58 s apart can ARRIVE closer because of network jitter.
   */
  netToleranceSeconds: 0.1,
};

const C = PopcornShotgunConfig;
const DEG = Math.PI / 180;

/** Deterministic PRNG (mulberry32): same seed → same pellets everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh 32-bit unsigned shot seed (sent with POPCORN_FIRE). */
export function randomPopcornSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Validate a raw network seed (non-integer / out of range → null). */
export function sanitizePopcornSeed(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 4294967295 || Math.floor(raw) !== raw) return null;
  return raw >>> 0;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * SHOOTER side: canonical aim direction of a shot — components rounded to
 * 3 decimals (EXACTLY what MultiplayerClient puts on the wire) then
 * normalized with the backend `normalize` formula, so the shooter's local
 * pellets are bit-identical to the server's. The server confirm carries
 * that normalized direction at full precision: REMOTE clients use the
 * received dx/dy/dz AS IS (never re-run this on it).
 */
export function popcornAimDirection(raw: PopcornVec3, out: PopcornVec3 = { x: 0, y: 0, z: 0 }): PopcornVec3 {
  const x = round3(raw.x);
  const y = round3(raw.y);
  const z = round3(raw.z);
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(len) || len < 1e-6) {
    out.x = 0;
    out.y = 0;
    out.z = -1;
    return out;
  }
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

/**
 * Roll-free pattern basis for a unit `forward`: right = forward × worldUp,
 * up = right × forward (written into `right` / `up`).
 */
export function popcornPatternBasis(forward: PopcornVec3, right: PopcornVec3, up: PopcornVec3): void {
  let rx = -forward.z;
  let rz = forward.x;
  let len = Math.sqrt(rx * rx + rz * rz);
  if (len < 1e-6) {
    // Straight up / down (the camera pitch is clamped short of it).
    rx = 1;
    rz = 0;
    len = 1;
  }
  right.x = rx / len;
  right.y = 0;
  right.z = rz / len;
  const ux = right.y * forward.z - right.z * forward.y;
  const uy = right.z * forward.x - right.x * forward.z;
  const uz = right.x * forward.y - right.y * forward.x;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  up.x = ux / ul;
  up.y = uy / ul;
  up.z = uz / ul;
}

const _right: PopcornVec3 = { x: 0, y: 0, z: 0 };
const _up: PopcornVec3 = { x: 0, y: 0, z: 0 };

/**
 * The pellet directions of one shot, written into `out` (must hold
 * `PopcornShotgunConfig.pellets` reusable objects — THREE.Vector3[] works;
 * no allocation). `forward` must be unit length. Same PRNG draw order as
 * the pack reference (spin, then x/y noise per pellet).
 */
export function popcornPelletDirections<T extends PopcornVec3>(
  forward: PopcornVec3,
  seed: number,
  out: T[],
  rings: readonly PopcornRing[] = C.rings,
): T[] {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  popcornPatternBasis(forward, _right, _up);
  const spin = rnd() * 360;
  let k = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.n; i++) {
      const a = (spin + ring.phaseDeg + (360 / ring.n) * i) * DEG;
      const tx = Math.tan((ring.deg * Math.cos(a) + C.jitterDeg * gauss()) * DEG);
      const ty = Math.tan((ring.deg * Math.sin(a) + C.jitterDeg * gauss()) * DEG);
      const dx = forward.x + _right.x * tx + _up.x * ty;
      const dy = forward.y + _right.y * tx + _up.y * ty;
      const dz = forward.z + _right.z * tx + _up.z * ty;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const o = out[k++];
      o.x = dx / l;
      o.y = dy / l;
      o.z = dz / l;
    }
  }
  return out;
}

/** Distance attenuation of ONE pellet (1 → 0.5 → 0.25). */
export function popcornPelletFalloff(distance: number): number {
  const f = C.falloff;
  if (distance <= f.fullUntil) return 1;
  if (distance <= f.halfAt) return 1 - (0.5 * (distance - f.fullUntil)) / (f.halfAt - f.fullUntil);
  if (distance <= f.quarterFrom) return 0.5 - (0.25 * (distance - f.halfAt)) / (f.quarterFrom - f.halfAt);
  return 0.25;
}

export interface PopcornPelletHit {
  distance: number;
  head: boolean;
}

/**
 * Damage of ONE shot on ONE target: all its pellets are summed and the
 * caller applies the total ONCE (one damage event, one hitmarker, clean
 * kill attribution). A head pellet raises it to at least the remaining HP.
 */
export function popcornShotDamage(hits: readonly PopcornPelletHit[], maxHp: number, currentHp: number): number {
  let dmg = 0;
  let head = false;
  const cap = C.headshotOneShotMaxRange;
  for (const h of hits) {
    dmg += maxHp * C.pelletDamageFraction * popcornPelletFalloff(h.distance);
    if (h.head && (cap === null || h.distance <= cap)) head = true;
  }
  if (head && C.headshotOneShot) dmg = Math.max(dmg, currentHp);
  return dmg;
}

/** True when at least one pellet of the list counts as a head hit. */
export function popcornShotIsHeadshot(hits: readonly PopcornPelletHit[]): boolean {
  const cap = C.headshotOneShotMaxRange;
  return hits.some((h) => h.head && (cap === null || h.distance <= cap));
}

/**
 * Ray vs the SHARED player hit volumes (head sphere + vertical body
 * capsule, head priority — the shapes of backend HitDetection.hitscan).
 * `center` = capsule centre. Client use: stop the COSMETIC popcorns on
 * remote avatars (the server decides the real hits).
 */
export function popcornRayVsPlayer(
  o: PopcornVec3,
  d: PopcornVec3,
  center: PopcornVec3,
  maxDist: number,
): { t: number; head: boolean } | null {
  const headT = raySphere(o, d, center.x, center.y + PLAYER_HEAD_OFFSET, center.z, PLAYER_HEAD_RADIUS);
  const bodyT = rayVerticalCapsule(o, d, center, PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_CAPSULE_RADIUS);
  let t: number | null = null;
  let head = false;
  // Same rule as backend HitDetection.hitscan: a ray through the head
  // sphere is a HEAD hit (a headshot never degrades into a body shot).
  if (headT !== null) {
    t = bodyT !== null ? Math.min(headT, bodyT) : headT;
    head = true;
  } else if (bodyT !== null) {
    t = bodyT;
  }
  if (t === null || t > maxDist) return null;
  return { t, head };
}

function raySphere(o: PopcornVec3, d: PopcornVec3, cx: number, cy: number, cz: number, r: number): number | null {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t = -b - sq;
  if (t >= 0) return t;
  const t2 = -b + sq;
  return t2 >= 0 ? t2 : null;
}

function rayVerticalCapsule(o: PopcornVec3, d: PopcornVec3, center: PopcornVec3, halfHeight: number, radius: number): number | null {
  let best: number | null = null;
  const ox = o.x - center.x;
  const oz = o.z - center.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / a, (-b + sq) / a]) {
        if (t < 0) continue;
        const y = o.y + d.y * t;
        if (Math.abs(y - center.y) <= halfHeight && (best === null || t < best)) best = t;
      }
    }
  }
  for (const capY of [center.y + halfHeight, center.y - halfHeight]) {
    const t = raySphere(o, d, center.x, capY, center.z, radius);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

