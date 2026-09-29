import {
  WaterFamasConfig as W,
  waterFamasJetDamage,
  waterFamasJetDirection,
} from "../../../shared/combat/WaterFamasRules";
import type { ColliderBox } from "../../../shared/map/MapColliders";
import { NetworkHitZone } from "../../../shared/combat/NetworkWeapons";
import { HitTarget, Vec3, hitscan, pointAt } from "./HitDetection";

/**
 * WATER FAMAS — server authority (ammo, burst cadence, refill clock, hitscan).
 * Pure logic, no Colyseus / no host: WeaponManager feeds it the clock, the
 * rewound targets and the map, then applies the returned hit through its
 * normal dealDamage path. One WATER_FAMAS_FIRE message = ONE jet = one
 * instant raycast (a burst = 3 messages 0 / 0.075 / 0.15 s apart).
 */
export class WaterFamasState {
  ammo = W.capacity;
  /** Server ms at which the current / last burst started (0 = none yet). */
  burstStartedAt = 0;
  /** Index of the next jet the running burst expects (>= jetsPerBurst = burst over). */
  nextJet: number = W.jetsPerBurst;
  /** Server ms of the running refill start (0 = no reload). */
  reloadStartedAt = 0;

  reset(): void {
    this.ammo = W.capacity;
    this.burstStartedAt = 0;
    this.nextJet = W.jetsPerBurst;
    this.reloadStartedAt = 0;
  }

  /**
   * Advance the refill: the ammo counts at the END OF THE POUR (1.98 s); the
   * refill clip itself ends at 3.3 s. A cancel before the pour ends keeps the
   * pre-reload ammo.
   */
  settle(now: number): void {
    if (this.reloadStartedAt === 0) return;
    const elapsed = (now - this.reloadStartedAt) / 1000;
    if (elapsed >= W.timeline.reloadAmmoRefilled) this.ammo = W.capacity;
    if (elapsed >= W.timeline.reloadDuration) this.reloadStartedAt = 0;
  }
}

export interface WaterFamasFireResult {
  accepted: boolean;
  /** Ammo AFTER the jet (confirm `am`). */
  ammoLeft: number;
  /** FINAL jet direction (after the seeded spread) — remotes replay it AS IS. */
  jetDir: Vec3;
  /** Jet ray end: impact point, or the max-range point (confirm hx/hy/hz). */
  endPoint: Vec3;
  /** Player hit (null = wall / nothing). */
  victim: { targetId: string; amount: number; headshot: boolean; point: Vec3 } | null;
}

const REFUSED: WaterFamasFireResult = {
  accepted: false,
  ammoLeft: 0,
  jetDir: { x: 0, y: 0, z: 0 },
  endPoint: { x: 0, y: 0, z: 0 },
  victim: null,
};
const jetDirScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Validate + resolve one WATER_FAMAS_FIRE (one jet). `dir` is the validated
 * (normalized) camera aim, `seed` the sanitized jet seed, `k` the jet index
 * (0 = burst start), `aiming` the burst's ADS flag. The same shared rule
 * rebuilds the direction the shooter used; ONE hitscan decides wall / player
 * / nothing and the damage is applied at once (never at the visible jet's
 * arrival).
 */
export function resolveWaterFamasFire(
  st: WaterFamasState,
  now: number,
  origin: Vec3,
  dir: Vec3,
  seed: number,
  k: number,
  aiming: boolean,
  targets: HitTarget[],
  shooterId: string,
  mapBoxes: ColliderBox[],
): WaterFamasFireResult {
  st.settle(now);
  if (st.reloadStartedAt !== 0) {
    // Firing is legal again from readyToFire (2.95 s) — the end of the refill
    // clip is then cut by the burst (local parity).
    const elapsed = now - st.reloadStartedAt;
    if (elapsed < W.timeline.reloadReady * 1000 - W.netToleranceSeconds * 1000) return REFUSED;
    st.ammo = W.capacity; // readyToFire is past the end of the pour (jitter-tolerant)
    st.reloadStartedAt = 0;
  }
  if (st.ammo <= 0) return REFUSED;

  const tolMs = W.netToleranceSeconds * 1000;
  if (k === 0) {
    // A new burst: >= 0.45 s after the previous burst START (jitter-tolerant).
    if (st.burstStartedAt !== 0 && now - st.burstStartedAt < W.burstInterval * 1000 - tolMs) return REFUSED;
    st.burstStartedAt = now;
    st.nextJet = 1;
  } else {
    // Jets 1 / 2 belong to a running burst, in order, at their authored time.
    if (st.burstStartedAt === 0 || k !== st.nextJet) return REFUSED;
    const elapsed = now - st.burstStartedAt;
    if (elapsed < W.jetTimes[k] * 1000 - tolMs || elapsed > W.burstWindowSeconds * 1000) return REFUSED;
    st.nextJet = k + 1;
  }
  st.ammo--;

  waterFamasJetDirection(dir, k, aiming, seed, jetDirScratch);
  const jetDir: Vec3 = { x: jetDirScratch.x, y: jetDirScratch.y, z: jetDirScratch.z };
  const hit = hitscan(origin, jetDir, W.maxRange, targets, shooterId, mapBoxes);
  const endPoint = hit ? hit.point : pointAt(origin, jetDir, W.maxRange);
  let victim: WaterFamasFireResult["victim"] = null;
  if (hit && hit.kind === "player" && hit.targetId) {
    const headshot = hit.zone === NetworkHitZone.HEAD;
    victim = { targetId: hit.targetId, amount: waterFamasJetDamage(headshot), headshot, point: hit.point };
  }
  return { accepted: true, ammoLeft: st.ammo, jetDir, endPoint, victim };
}

/** WATER_FAMAS_RELOAD: refused while full or already refilling. */
export function startWaterFamasReload(st: WaterFamasState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt !== 0 || st.ammo >= W.capacity) return false;
  st.reloadStartedAt = now;
  st.nextJet = W.jetsPerBurst; // a running burst is over
  return true;
}

/** WATER_FAMAS_RELOAD_CANCEL: before the end of the pour the ammo is unchanged. */
export function cancelWaterFamasReload(st: WaterFamasState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt === 0) return false;
  st.reloadStartedAt = 0;
  return true;
}
