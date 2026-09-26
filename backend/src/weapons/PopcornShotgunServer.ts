import {
  PopcornShotgunConfig as P,
  popcornPelletDirections,
  popcornShotDamage,
  popcornShotIsHeadshot,
  type PopcornPelletHit,
} from "../../../shared/combat/PopcornShotgunRules";
import type { ColliderBox } from "../../../shared/map/MapColliders";
import { NetworkHitZone } from "../../../shared/combat/NetworkWeapons";
import { HitTarget, Vec3, hitscan, pointAt } from "./HitDetection";

/**
 * POPCORN SHOTGUN — server authority (ammo, cadence, reload, pellets).
 * Pure logic, no Colyseus / no host: WeaponManager feeds it the clock, the
 * rewound targets and the map, then applies the returned per-victim totals
 * through its normal dealDamage path (one damage event per victim).
 */
export class PopcornShotgunState {
  ammo = P.shots;
  /** Server ms before which a new shot is refused (readyToFire). */
  nextFireAt = 0;
  /** Server ms of the running reload start (0 = no reload). */
  reloadStartedAt = 0;

  reset(): void {
    this.ammo = P.shots;
    this.nextFireAt = 0;
    this.reloadStartedAt = 0;
  }

  /**
   * Advance the reload: the ammo counts once the refill point (1.75 s) is
   * reached; the reload itself ends at 2.2 s. A cancel before the refill
   * point therefore keeps the pre-reload ammo.
   */
  settle(now: number): void {
    if (this.reloadStartedAt === 0) return;
    const elapsed = (now - this.reloadStartedAt) / 1000;
    if (elapsed >= P.timeline.reloadAmmoRefilled) this.ammo = P.shots;
    if (elapsed >= P.timeline.reloadDuration) this.reloadStartedAt = 0;
  }
}

export interface PopcornVictimTotal {
  targetId: string;
  amount: number;
  headshot: boolean;
  /** Nearest pellet impact on this victim (hit feedback anchor). */
  point: Vec3;
}

export interface PopcornFireResult {
  accepted: boolean;
  /** Ammo AFTER the shot (confirm `am`). */
  ammoLeft: number;
  /** Per-victim summed damage (apply each ONCE). */
  victims: PopcornVictimTotal[];
  /** Centre pellet end point (confirm hx/hy/hz — VFX anchor only). */
  centerPoint: Vec3;
}

const REFUSED: PopcornFireResult = { accepted: false, ammoLeft: 0, victims: [], centerPoint: { x: 0, y: 0, z: 0 } };
const pelletDirs: Vec3[] = Array.from({ length: P.pellets }, () => ({ x: 0, y: 0, z: 0 }));

/**
 * Validate + resolve one POPCORN_FIRE. `dir` is the validated (normalized)
 * aim, `seed` the sanitized pellet seed, `health(id)` returns the victim's
 * [maxHealth, health] for the head one-shot rule.
 */
export function resolvePopcornFire(
  st: PopcornShotgunState,
  now: number,
  origin: Vec3,
  dir: Vec3,
  seed: number,
  targets: HitTarget[],
  shooterId: string,
  mapBoxes: ColliderBox[],
  health: (id: string) => [number, number] | null,
): PopcornFireResult {
  st.settle(now);
  const tolMs = P.netToleranceSeconds * 1000;
  if (st.reloadStartedAt !== 0) {
    // Firing is legal again from readyToFire (2.06 s) — the pump rack of
    // the reload is then interrupted by the shot (local parity).
    const elapsed = now - st.reloadStartedAt;
    if (elapsed < P.timeline.reloadReady * 1000 - tolMs) return REFUSED;
    st.ammo = P.shots; // readyToFire is past the refill point (jitter-tolerant)
    st.reloadStartedAt = 0;
  }
  if (st.ammo <= 0) return REFUSED;
  if (now < st.nextFireAt - tolMs) return REFUSED;

  st.ammo--;
  const ready = st.ammo === 0 ? P.timeline.fireLastReady : P.timeline.fireReady;
  st.nextFireAt = now + ready * 1000;

  popcornPelletDirections(dir, seed, pelletDirs);
  const perVictim = new Map<string, { hits: PopcornPelletHit[]; point: Vec3; best: number }>();
  let centerPoint = pointAt(origin, dir, P.maxRange);
  for (let i = 0; i < pelletDirs.length; i++) {
    const d = pelletDirs[i];
    const hit = hitscan(origin, d, P.maxRange, targets, shooterId, mapBoxes);
    if (i === 0) centerPoint = hit ? hit.point : pointAt(origin, d, P.maxRange);
    if (!hit || hit.kind !== "player" || !hit.targetId) continue;
    let v = perVictim.get(hit.targetId);
    if (!v) {
      v = { hits: [], point: hit.point, best: hit.distance };
      perVictim.set(hit.targetId, v);
    }
    v.hits.push({ distance: hit.distance, head: hit.zone === NetworkHitZone.HEAD });
    if (hit.distance < v.best) {
      v.best = hit.distance;
      v.point = hit.point;
    }
  }

  const victims: PopcornVictimTotal[] = [];
  for (const [targetId, v] of perVictim) {
    const hp = health(targetId);
    if (!hp) continue;
    const amount = popcornShotDamage(v.hits, hp[0], hp[1]);
    if (amount <= 0) continue;
    victims.push({ targetId, amount, headshot: popcornShotIsHeadshot(v.hits), point: v.point });
  }
  return { accepted: true, ammoLeft: st.ammo, victims, centerPoint };
}

/** POPCORN_RELOAD: refused while full or already reloading. */
export function startPopcornReload(st: PopcornShotgunState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt !== 0 || st.ammo >= P.shots) return false;
  st.reloadStartedAt = now;
  return true;
}

/** POPCORN_RELOAD_CANCEL: before the refill point the ammo is unchanged. */
export function cancelPopcornReload(st: PopcornShotgunState, now: number): boolean {
  st.settle(now);
  if (st.reloadStartedAt === 0) return false;
  st.reloadStartedAt = 0;
  return true;
}
