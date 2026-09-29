/**
 * WATER FAMAS — SHARED gameplay rules (pure TypeScript, no Three.js).
 *
 * Imported by the frontend (local prediction + remote visuals) AND by the
 * backend (authoritative hitscan + damage). One trigger pull = a BURST of 3
 * water jets (0 / 0.075 / 0.15 s). EVERY jet is its own instant raycast from
 * the game camera, done when the jet leaves the barrel — so a burst dragged
 * across a target can hit three different points. One WATER_FAMAS_FIRE
 * message per jet: `pi` = jet index in the burst (0..2), `pc` = 1 when the
 * burst was started aiming, `sd` = jet seed (uint32), dx/dy/dz = camera aim.
 *
 * Reference: src/weapons/waterfamas/WaterFamasGameplay.ts (pack). The spread
 * cones, PRNG and draw order are identical; deliberate differences:
 *   - the cone's "up" axis is derived from forward + world Y (no camera
 *     roll), like the Popcorn Shotgun / Paintball Rifle: the server only
 *     receives the forward direction, a rolled axis would break parity;
 *   - damage is SlideIO-tuned (players have 200 HP): 23 body / 34.5 head;
 *   - NO maximum range (the pack used 28 m): a jet flies until the first
 *     wall / player / the map bounds, like the Paintball Rifle.
 *
 * DAMAGE (SlideIO tuning, players have 200 HP): 23 per jet on the body, x1.5 on
 * the head (34.5), NO distance falloff, NO range limit. A full burst = 69 body,
 * a full tank (9 jets) = 207 = one kill only if every jet lands on the body
 * (with a head jet, 8 jets are enough). Tune `bodyDamage` only: nothing in the
 * animations depends on it.
 */

export interface WaterFamasVec3 {
  x: number;
  y: number;
  z: number;
}

export const WaterFamasConfig = {
  /** Jets in a full tank (3 bursts). */
  capacity: 9,
  jetsPerBurst: 3,
  /** Seconds from the trigger pull at which each jet leaves (authored in FP_Fire / TP_Fire). */
  jetTimes: [0, 0.075, 0.15] as readonly number[],
  /** Minimum seconds between the START of two bursts (one burst per pull). */
  burstInterval: 0.45,
  /**
   * NO weapon range by design: the first wall / player / the map bounds stop
   * the jet. This is only the ray length (m), longer than the diagonal of
   * every map (same value as the Paintball Rifle / Hex Sniper tongue). A jet
   * that hits nothing (sky) vanishes at this distance.
   */
  maxRange: 400,
  /** Visible jet cruise speed (m/s): x4 of the pack's 30 m/s (doubled twice on request). */
  jetSpeed: 120,
  /** Flat damage of one BODY jet (no distance falloff). */
  bodyDamage: 23,
  /** Head multiplier (-> 34.5). */
  headMultiplier: 1.5,
  /** Spread cone (degrees) of jet k: tight first jet, the burst opens a little. */
  spreadDeg: [0.35, 0.8, 1.25] as readonly number[],
  /** ADS multiplier of the cone. */
  aimSpreadFactor: 0.55,
  /**
   * Authored timelines (seconds) — MUST match
   * src/assets/potato/WeaponProfile_WaterFamas.json → actions
   * (asserted by scripts/test-water-famas.mts). Duplicated here because the
   * backend cannot import frontend assets.
   */
  timeline: {
    reloadAmmoRefilled: 1.98,
    reloadReady: 2.95,
    reloadDuration: 3.3,
  },
  /** Server tolerance on the cadence / reload gates (s) — network jitter. */
  netToleranceSeconds: 0.1,
  /** A jet message of a running burst is accepted until this long after the burst start (s). */
  burstWindowSeconds: 0.6,
};

const C = WaterFamasConfig;
const DEG = Math.PI / 180;

/** Damage of ONE jet (hitscan, applied at the jet time). */
export function waterFamasJetDamage(headshot: boolean): number {
  return headshot ? C.bodyDamage * C.headMultiplier : C.bodyDamage;
}

/** Deterministic PRNG (mulberry32 — same as the pack): same seed → same jet everywhere. */
export function waterFamasMulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh 32-bit unsigned burst seed. */
export function randomWaterFamasSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Seed of jet k of a burst (uint32): one burst seed → 3 different jets, same everywhere. */
export function waterFamasJetSeed(burstSeed: number, k: number): number {
  return (burstSeed + Math.imul(k, 0x9e3779b1)) >>> 0;
}

/** Validate a raw network seed (non-integer / out of range → null). */
export function sanitizeWaterFamasSeed(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 4294967295 || Math.floor(raw) !== raw) return null;
  return raw;
}

/** Validate a raw jet index (0..jetsPerBurst-1, anything else → null). */
export function sanitizeWaterFamasJetIndex(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  return raw >= 0 && raw < C.jetsPerBurst ? raw : null;
}

/** Cone (degrees) of jet k. */
export function waterFamasSpreadDeg(k: number, aiming: boolean): number {
  const base = C.spreadDeg[Math.min(Math.max(0, k | 0), C.spreadDeg.length - 1)];
  return base * (aiming ? C.aimSpreadFactor : 1);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * SHOOTER side: canonical aim of a jet — components rounded to 3 decimals
 * (EXACTLY what MultiplayerClient puts on the wire) then normalized with the
 * backend `normalize` formula. REMOTE clients use the confirm's dx/dy/dz AS IS.
 */
export function waterFamasAimDirection(raw: WaterFamasVec3, out: WaterFamasVec3 = { x: 0, y: 0, z: 0 }): WaterFamasVec3 {
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
 * Direction of jet `k` (0..2): uniform in its cone around the unit `forward`
 * (roll-free basis: right = forward x worldUp, up = right x forward). Same
 * PRNG draw order as the pack (angle, then radius). No allocation.
 */
export function waterFamasJetDirection<T extends WaterFamasVec3>(
  forward: WaterFamasVec3,
  k: number,
  aiming: boolean,
  seed: number,
  out: T,
): T {
  const rnd = waterFamasMulberry32(seed);
  let rx = -forward.z;
  let rz = forward.x;
  let rl = Math.sqrt(rx * rx + rz * rz);
  if (rl < 1e-6) {
    rx = 1;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  let ux = -rz * forward.y;
  let uy = rz * forward.x - rx * forward.z;
  let uz = rx * forward.y;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(rnd()) * waterFamasSpreadDeg(k, aiming) * DEG;
  const t = Math.tan(r);
  const ca = Math.cos(a) * t;
  const sa = Math.sin(a) * t;
  const dx = forward.x + rx * ca + ux * sa;
  const dy = forward.y + uy * sa;
  const dz = forward.z + rz * ca + uz * sa;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  out.x = dx / l;
  out.y = dy / l;
  out.z = dz / l;
  return out;
}

