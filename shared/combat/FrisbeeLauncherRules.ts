/**
 * FRISBEE LAUNCHER — SHARED gameplay rules (pure TypeScript, no Three.js).
 *
 * Imported by the frontend (local prediction + remote replay) AND by the
 * backend (authoritative ammo / cadence / flight / damage). The Frisbee
 * Launcher throws ONE real projectile per trigger pull (not a hitscan): the
 * shooter sends its seed (`sd`) + aim, the server rebuilds the SAME direction
 * (`frisbeeDirection`) and simulates the disc with the SHARED fixed-step
 * SharedFrisbeeSim (shared/combat/FrisbeeSim.ts), every client replays the same disc.
 *
 * Reference: src/weapons/frisbee/FrisbeeLauncherGameplay.ts +
 * FrisbeeProjectiles.ts (pack). The PRNG, the draw order and the numbers are
 * IDENTICAL (asserted by scripts/test-frisbee-launcher.mts); one deliberate
 * difference: the cone's "up" axis is derived from forward + world Y (no camera
 * roll), like the Popcorn Shotgun / Paintball Rifle / Water FAMAS — the server
 * only receives the forward direction, a rolled axis would break parity.
 *
 * DAMAGE (set by the project owner, players have 100 HP):
 * 75 body, 100 head (x100/75), x0.6 after at least one bounce on the scenery
 * (45 / 60). No damage under 8 m/s or after the bounce budget is spent. One
 * hit per disc. Knockback on the victim: 2.5 m/s horizontal along the disc +
 * 0.8 m/s up.
 *
 * RELOAD SPEED: the authored `timeline` below is in CLIP time. A cage swap runs
 * `reloadSpeed` times faster than the clip (x1.5 on request): the server, the
 * controller clock and the FP / TP clips all apply the SAME factor, so a swap
 * lasts `timeline.reload.* / reloadSpeed` real seconds. Shots / re-cock after a
 * shot are NOT sped up.
 */

export interface FrisbeeVec3 {
  x: number;
  y: number;
  z: number;
}

/** Flight / damage tuning of one disc (pack FRISBEE_TUNING). */
export interface FrisbeeTuning {
  speed: number;
  radius: number;
  lift: number;
  drag: number;
  gravity: number;
  restitution: number;
  friction: number;
  maxBounces: number;
  lifetime: number;
  restSpeed: number;
  playerRestitution: number;
  damageBody: number;
  headshotMultiplier: number;
  bouncedDamageScale: number;
  minDamageSpeed: number;
  knockback: number;
  knockbackUp: number;
}

export const FrisbeeLauncherConfig = {
  /** Discs in a full cage. */
  cageCapacity: 5,
  /** Deck (1) + cage (5). */
  capacity: 6,
  /** Fixed simulation step (s) — the SAME on the server and on every client. */
  simStep: 1 / 120,
  /** Aim spread (degrees): the disc is accurate. */
  spreadHipDeg: 0.6,
  spreadAimDeg: 0.15,
  /**
   * Playback / gameplay rate of the cage swaps (`reload` and `reloadEmpty`), x1.5 on request.
   * Real duration of a swap = authored timeline / reloadSpeed (1.40 s -> 0.93 s, 2.48 s -> 1.65 s).
   */
  reloadSpeed: 1.5,
  tuning: {
    // Launch speed (m/s), x3 of the pack's 34 on request (the player's top speed outran the disc). Server AND clients
    // read it; the lift / trail / spin scale with speed / this value, so the flight keeps its look at any speed.
    speed: 102,
    // Radius (m) of the disc: collision sphere on the server AND on every client, and the visible size of
    // the flying disc (FrisbeeLauncherWeapon reads it) -> the hitbox always matches what is drawn.
    // Pack value 0.12 -> 0.4 on request (the disc on the weapon model is far bigger than the pack's projectile).
    radius: 0.4,
    lift: 0.8,
    drag: 0.18,
    gravity: 9.81,
    restitution: 0.55,
    friction: 0.8,
    maxBounces: 3,
    lifetime: 3.5,
    restSpeed: 1.2,
    playerRestitution: 0.35,
    // 75 body / 100 head (100 / 75 -> exactly 100 after rounding), x0.6 after a bounce -> 45 / 60. Head = one-shot kill at 100 HP.
    damageBody: 75,
    headshotMultiplier: 100 / 75,
    bouncedDamageScale: 0.6,
    minDamageSpeed: 8,
    knockback: 2.5,
    knockbackUp: 0.8,
  } as FrisbeeTuning,
  /**
   * Authored timelines (seconds) — MUST match
   * src/assets/potato/WeaponProfile_FrisbeeLauncher.json → actions
   * (asserted by scripts/test-frisbee-launcher.mts). Duplicated here because
   * the backend cannot import frontend assets.
   */
  timeline: {
    fire: { duration: 1.58, discTaken: 0.95, discSeated: 1.29, readyToFire: 1.5 },
    fireLast: { duration: 0.5, readyToReload: 0.25 },
    reload: { duration: 1.4, cageSwap: 0.71, cageIn: 1.1, readyToFire: 1.3 },
    reloadEmpty: {
      duration: 2.48,
      cageSwap: 0.71,
      cageIn: 1.1,
      discTaken: 1.85,
      discSeated: 2.19,
      readyToFire: 2.4,
    },
  },
  /** Server tolerance on the cadence / reload gates (s) — network jitter. */
  netToleranceSeconds: 0.1,
  /** Discs in flight for the whole room (server) / the whole game (client). */
  maxDiscs: 24,
};

const C = FrisbeeLauncherConfig;
const DEG = Math.PI / 180;

/** Damage of one disc touch (rounded like the pack: 75 / 100 / 45 / 60). */
export function frisbeeDamage(headshot: boolean, bounced: boolean, tuning: FrisbeeTuning = C.tuning): number {
  return Math.round(
    tuning.damageBody * (headshot ? tuning.headshotMultiplier : 1) * (bounced ? tuning.bouncedDamageScale : 1),
  );
}

/** Deterministic PRNG (mulberry32 — same as the pack): same seed → same shot everywhere. */
export function frisbeeMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh 32-bit unsigned shot seed. */
export function randomFrisbeeSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Validate a raw network seed (non-integer / out of range → null). */
export function sanitizeFrisbeeSeed(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 4294967295 || Math.floor(raw) !== raw) return null;
  return raw;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Coordinate as it travels on the wire (3 decimals) — the shooter simulates from THIS origin. */
export function frisbeeWireCoord(v: number): number {
  return round3(v);
}

/**
 * SHOOTER side: canonical aim — components rounded to 3 decimals (EXACTLY what
 * MultiplayerClient puts on the wire) then normalized with the backend
 * `normalize` formula. REMOTE clients use the confirm's dx/dy/dz AS IS.
 */
export function frisbeeAimDirection(raw: FrisbeeVec3, out: FrisbeeVec3 = { x: 0, y: 0, z: 0 }): FrisbeeVec3 {
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
 * Launch direction: uniform in the (tiny) cone around the unit `forward`
 * (roll-free basis: right = forward x worldUp, up = right x forward). Same PRNG
 * draw order as the pack (angle, then radius). No allocation.
 */
export function frisbeeDirection<T extends FrisbeeVec3>(forward: FrisbeeVec3, aiming: boolean, seed: number, out: T): T {
  const rnd = frisbeeMulberry32(seed);
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
  const r = Math.sqrt(rnd()) * (aiming ? C.spreadAimDeg : C.spreadHipDeg) * DEG;
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