import {
  PaintballRifleConfig as P,
  paintballBallDirection,
  paintballDamage,
} from "../../../shared/combat/PaintballRifleRules";
import type { ColliderBox } from "../../../shared/map/MapColliders";
import { NetworkHitZone } from "../../../shared/combat/NetworkWeapons";
import { HitTarget, Vec3, hitscan, pointAt } from "./HitDetection";

/**
 * PAINTBALL RIFLE — server authority (ammo, cadence, hopper swap, hitscan).
 * Pure logic, no Colyseus / no host: WeaponManager feeds it the clock, the
 * rewound targets and the map, then applies the returned hit through its
 * normal dealDamage path (one damage event per ball — hitscan, immediate).
 */
export class PaintballRifleState {
  ammo = P.capacity;
  /** Server ms of the last accepted ball (0 = none yet). */
  lastShotAt = 0;
  /**
   * Cadence debt (ms, ≤ 0): a ball that arrives a bit early (network
   * jitter) borrows up to `cadenceToleranceSeconds`, repaid by the next
   * later ball; spam exceeds the debt and gets refused — the AVERAGE
   * cadence can never exceed 600 rpm.
   */
  cadenceCredit = 0;
  /** Server ms of the running hopper swap start (0 = no reload). */
  reloadStartedAt = 0;

  reset(): void {
    this.ammo = P.capacity;
    this.lastShotAt = 0;
    this.cadenceCredit = 0;
    this.reloadStartedAt = 0;
  }

  /**
   * Advance the swap: the ammo counts once the new hopper clicks in
   * (1.52 s); the swap itself ends at 2.45 s. A cancel before the click
   * keeps the pre-reload ammo.
   */
  settle(now: number): void {
    if (this.reloadStartedAt === 0) return;
    const elapsed = (now - this.reloadStartedAt) / 1000;
    if (elapsed >= P.timeline.reloadAmmoRefilled) this.ammo = P.capacity;
    if (elapsed >= P.timeline.reloadDuration) this.reloadStartedAt = 0;
  }
}

export interface PaintballFireResult {
  accepted: boolean;
  /** Ammo AFTER the shot (confirm `am`). */
  ammoLeft: number;
  /** Ball ray end: impact point, or the max-range point (confirm hx/hy/hz). */
  endPoint: Vec3;
  /** Player hit (null = wall / nothing). */
  victim: { targetId: string; amount: number; headshot: boolean; point: Vec3 } | null;
}

const REFUSED: PaintballFireResult = { accepted: false, ammoLeft: 0, endPoint: { x: 0, y: 0, z: 0 }, victim: null };
const ballDir: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Validate + resolve one PAINTBALL_FIRE. `dir` is the validated
 * (normalized) aim, `seed` the sanitized ball seed, `spreadDeg` the
 * quantized cone. The same shared rule rebuilds the ball direction the
 * shooter used; ONE hitscan decides wall / player / nothing.
 */
export function resolvePaintballFire(
  st: PaintballRifleState,
  now: number,
  origin: Vec3,
  dir: Vec3,
  seed: number,
  spreadDeg: number,
  targets: HitTarget[],
  shooterId: string,
  mapBoxes: ColliderBox[],
): PaintballFireResult {
  st.settle(now);
  if (st.reloadStartedAt !== 0) {
    // Firing is legal again from readyToFire (2.10 s) — the end of the swap
    // clip is then cut by the shot (local parity).
    const elapsed = now - st.reloadStartedAt;
    if (elapsed < P.timeline.reloadReady * 1000 - P.netToleranceSeconds * 1000) return REFUSED;
    st.ammo = P.capacity; // readyToFire is past the click (jitter-tolerant)
    st.reloadStartedAt = 0;
  }
  if (st.ammo <= 0) return REFUSED;

  // Cadence: ≥ 0.1 s between two balls, with a small per-ball jitter
  // tolerance and a sustained budget (never above 600 rpm on average).
  const intervalMs = P.fireInterval * 1000;
  if (st.lastShotAt !== 0) {
    const gap = now - st.lastShotAt;
    if (gap < intervalMs - P.cadenceToleranceSeconds * 1000) return REFUSED;
    // Debt only (never a positive credit): a pause never buys a faster burst.
    const credit = Math.min(0, st.cadenceCredit + gap - intervalMs);
    if (credit < -P.cadenceToleranceSeconds * 1000) return REFUSED;
    st.cadenceCredit = credit;
  }
  st.lastShotAt = now;
  st.ammo--;

  paintballBallDirection(dir, spreadDeg, seed, ballDir);
  const hit = hitscan(origin, ballDir, P.maxRange, targets, shooterId, mapBoxes);
  const endPoint = hit ? hit.point : pointAt(origin, ballDir, P.maxRange);
  let victim: PaintballFireResult["victim"] = null;
  if (hit && hit.kind === "player" && hit.targetId) {
    const headshot = hit.zone === NetworkHitZone.HEAD;
    victim = { targetId: hit.targetId, amount: paintballDamage(headshot), headshot, point: hit.point };
  }
  return { accepted: true, ammoLeft: st.ammo, endPoint, victim };
}

/** PAINTBALL_RELOAD: refused while full or already swapping. */
export function startPaintballReload(st: PaintballRifleState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt !== 0 || st.ammo >= P.capacity) return false;
  st.reloadStartedAt = now;
  return true;
}

/** PAINTBALL_RELOAD_CANCEL: before the click the ammo is unchanged. */
export function cancelPaintballReload(st: PaintballRifleState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt === 0) return false;
  st.reloadStartedAt = 0;
  return true;
}
