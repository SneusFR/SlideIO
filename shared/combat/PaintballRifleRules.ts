/**
 * PAINTBALL RIFLE — SHARED gameplay rules (pure TypeScript, no Three.js).
 *
 * Imported by the frontend (local prediction + remote visuals) AND by the
 * backend (authoritative hitscan + damage). One ball = one instant raycast
 * from the camera; the same seed + aim + spread give the same direction
 * everywhere: the shooter sends them with PAINTBALL_FIRE, the server
 * recomputes the ray, remote clients replay the visual ball + splat.
 *
 * Reference: src/weapons/paintball/PaintballSpread.ts (pack). Damage,
 * capacity, bloom and the PRNG / draw order of `ballDirection` are
 * IDENTICAL (checked by scripts/test-paintball-rifle.mts). Two deliberate
 * differences:
 *   - the cone's "up" axis is the camera up WITHOUT roll (derived from
 *     forward + world Y) — same as the Popcorn Shotgun: the server only
 *     receives the forward direction, a rolled up axis would break parity;
 *   - NO maximum range (the pack uses 45 m): a ball flies until the first
 *     wall / player / the map bounds, like the Hex Sniper tongue.
 */

export interface PaintballVec3 {
  x: number;
  y: number;
  z: number;
}

export const PaintballRifleConfig = {
  /** Balls per hopper. */
  capacity: 32,
  /** Minimum seconds between two balls (600 rpm — the authored fire loop). */
  fireInterval: 0.1,
  /**
   * NO weapon range by design: the first wall / player / the map bounds
   * stop the ball. This is only the ray length (m), longer than the
   * diagonal of every map (asserted by scripts/test-paintball-rifle.mts)
   * — same value as the Hex Sniper tongue. A ball that hits nothing (sky)
   * vanishes at this distance.
   */
  maxRange: 400,
  /** Flat damage of one BODY ball (no distance falloff). */
  bodyDamage: 12,
  /** Head multiplier (→ 18). */
  headMultiplier: 1.5,
  /** Spread cone (degrees): first ball, bloom per ball, cap, recovery. */
  spreadMinDeg: 0.35,
  spreadMaxDeg: 2.2,
  bloomPerShotDeg: 0.25,
  bloomRecoveryDegPerSecond: 4.0,
  /** ADS (tight hip aim) floor multiplier. */
  aimSpreadFactor: 0.6,
  /**
   * Authored timelines (seconds) — MUST match
   * src/assets/potato/WeaponProfile_PaintballRifle.json → actions
   * (asserted by scripts/test-paintball-rifle.mts). Duplicated here
   * because the backend cannot import frontend assets.
   */
  timeline: {
    reloadAmmoRefilled: 1.52,
    reloadReady: 2.1,
    reloadDuration: 2.45,
  },
  /** Server tolerance on the reload gates (s) — network jitter. */
  netToleranceSeconds: 0.1,
  /**
   * Cadence: a single shot may arrive this much early (jitter), and a
   * sustained-rate budget (see the server state) keeps the AVERAGE at
   * 600 rpm — jitter never refuses a legit burst, spam never exceeds it.
   */
  cadenceToleranceSeconds: 0.04,
};

const C = PaintballRifleConfig;
const DEG = Math.PI / 180;

/** Damage of ONE ball (hitscan, applied at the shot time). */
export function paintballDamage(headshot: boolean): number {
  return headshot ? C.bodyDamage * C.headMultiplier : C.bodyDamage;
}

/** Deterministic PRNG (mulberry32 — same as the pack reference). */
export function paintballMulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh 32-bit unsigned ball seed (sent with PAINTBALL_FIRE). */
export function randomPaintballSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Validate a raw network seed (non-integer / out of range → null). */
export function sanitizePaintballSeed(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 4294967295 || Math.floor(raw) !== raw) return null;
  return raw >>> 0;
}

/** Validate a raw paint colour index (palette slot 0..7, anything else → 0). */
export function sanitizePaintballColor(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 8 ? raw : 0;
}

/** Smallest legal cone (ADS floor). */
export const PAINTBALL_MIN_SPREAD_DEG = C.spreadMinDeg * C.aimSpreadFactor;

/**
 * Spread angle on the wire: degrees rounded to 1/1000 (MultiplayerClient
 * rounds px to 3 decimals), clamped to the legal cone. The shooter uses
 * the quantized value locally too, so its ray is bit-identical to the
 * server's. Invalid → the minimum cone.
 */
export function quantizePaintballSpread(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return Math.round(PAINTBALL_MIN_SPREAD_DEG * 1000) / 1000;
  const clamped = Math.min(C.spreadMaxDeg, Math.max(PAINTBALL_MIN_SPREAD_DEG, raw));
  return Math.round(clamped * 1000) / 1000;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * SHOOTER side: canonical aim of a shot — components rounded to 3
 * decimals (EXACTLY what MultiplayerClient puts on the wire) then
 * normalized with the backend `normalize` formula. REMOTE clients use the
 * confirm's dx/dy/dz AS IS (never re-run this on it).
 */
export function paintballAimDirection(raw: PaintballVec3, out: PaintballVec3 = { x: 0, y: 0, z: 0 }): PaintballVec3 {
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
 * Direction of one ball: uniform in a cone of `spreadDeg` around the unit
 * `forward` (roll-free basis: right = forward x worldUp, up = right x
 * forward). Same PRNG draw order as PaintballSpread.ballDirection (angle,
 * then radius). Written into `out`, no allocation.
 */
export function paintballBallDirection<T extends PaintballVec3>(
  forward: PaintballVec3,
  spreadDeg: number,
  seed: number,
  out: T,
): T {
  const rnd = paintballMulberry32(seed);
  // right = forward x (0,1,0)
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
  // up = right x forward (right.y = 0)
  let ux = -rz * forward.y;
  let uy = rz * forward.x - rx * forward.z;
  let uz = rx * forward.y;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(rnd()) * spreadDeg * DEG;
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

/** Bloom state of one shooter (pack PaintballBloom, shared constants). */
export class PaintballBloomState {
  spreadDeg = C.spreadMinDeg;
  /** Call once per shot (after computing its direction). */
  onShot(): void {
    this.spreadDeg = Math.min(C.spreadMaxDeg, this.spreadDeg + C.bloomPerShotDeg);
  }
  /** Call every frame. */
  update(dt: number, aiming: boolean): void {
    const floor = aiming ? PAINTBALL_MIN_SPREAD_DEG : C.spreadMinDeg;
    this.spreadDeg = Math.max(floor, this.spreadDeg - C.bloomRecoveryDegPerSecond * dt);
  }
  reset(): void {
    this.spreadDeg = C.spreadMinDeg;
  }
}
