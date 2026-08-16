import { MAP_COLLIDER_BOXES } from "../../../shared/map/MapColliders";
import {
  NetworkHitZone,
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_HEAD_OFFSET,
  PLAYER_HEAD_RADIUS,
} from "../../../shared/combat/NetworkWeapons";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A player target for the server-side hit query (network transform). */
export interface HitTarget {
  id: string;
  /** Capsule CENTER position (NetworkPlayer x/y/z). */
  x: number;
  y: number;
  z: number;
}

export interface HitscanResult {
  kind: "player" | "wall";
  targetId: string | null;
  zone: NetworkHitZone;
  point: Vec3;
  distance: number;
}

/**
 * Pure server-side hit detection (Phase 5).
 * The world is the SHARED box list (see shared/map/MapColliders.ts) +
 * simplified player hitboxes: HEAD sphere + BODY vertical capsule.
 * No Rapier, no meshes — deterministic and unit-testable.
 */

/** Ray vs AABB (slab method). Returns entry distance or null. */
function rayVsAabb(
  o: Vec3,
  d: Vec3,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  maxDist: number,
): number | null {
  let tMin = 0;
  let tMax = maxDist;
  const oArr = [o.x, o.y, o.z];
  const dArr = [d.x, d.y, d.z];
  const cArr = [cx, cy, cz];
  const hArr = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    const lo = cArr[i] - hArr[i];
    const hi = cArr[i] + hArr[i];
    if (Math.abs(dArr[i]) < 1e-9) {
      if (oArr[i] < lo || oArr[i] > hi) return null;
      continue;
    }
    let t1 = (lo - oArr[i]) / dArr[i];
    let t2 = (hi - oArr[i]) / dArr[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Nearest map-geometry hit distance along the ray, or null. */
export function raycastMap(o: Vec3, d: Vec3, maxDist: number): number | null {
  let best: number | null = null;
  for (const b of MAP_COLLIDER_BOXES) {
    const t = rayVsAabb(o, d, b[0], b[1], b[2], b[3] / 2, b[4] / 2, b[5] / 2, maxDist);
    if (t !== null && t >= 0 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Ray vs sphere → nearest positive t, or null. */
function rayVsSphere(o: Vec3, d: Vec3, c: Vec3, r: number): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t = -b - sq;
  if (t >= 0) return t;
  const t2 = -b + sq;
  return t2 >= 0 ? t2 : null; // origin inside the sphere
}

/**
 * Ray vs vertical capsule (axis = Y). Cylinder part solved on XZ, then
 * clamped in Y; both end-cap spheres tested too.
 */
function rayVsVerticalCapsule(
  o: Vec3,
  d: Vec3,
  center: Vec3,
  halfHeight: number,
  radius: number,
): number | null {
  let best: number | null = null;
  // Infinite cylinder on XZ
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
        if (Math.abs(y - center.y) <= halfHeight) {
          if (best === null || t < best) best = t;
        }
      }
    }
  }
  // End caps
  for (const capY of [center.y + halfHeight, center.y - halfHeight]) {
    const t = rayVsSphere(o, d, { x: center.x, y: capY, z: center.z }, radius);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Full hitscan: nearest of (map geometry, every target's head/body).
 * Head sphere is tested with priority when both zones overlap at the
 * same target — a headshot never degrades into a body shot.
 */
export function hitscan(
  origin: Vec3,
  dir: Vec3,
  maxRange: number,
  targets: Iterable<HitTarget>,
  excludeId: string | null,
): HitscanResult | null {
  const wallT = raycastMap(origin, dir, maxRange);

  let bestT: number | null = null;
  let bestId: string | null = null;
  let bestZone = NetworkHitZone.BODY;

  for (const target of targets) {
    if (excludeId !== null && target.id === excludeId) continue;
    const center = { x: target.x, y: target.y, z: target.z };
    const headCenter = { x: target.x, y: target.y + PLAYER_HEAD_OFFSET, z: target.z };

    const headT = rayVsSphere(origin, dir, headCenter, PLAYER_HEAD_RADIUS);
    const bodyT = rayVsVerticalCapsule(
      origin,
      dir,
      center,
      PLAYER_CAPSULE_HALF_HEIGHT,
      PLAYER_CAPSULE_RADIUS,
    );

    // The head sphere overlaps the capsule top: any ray that passes
    // through the head volume is a HEAD hit (it can only be this player
    // anyway) — a headshot never degrades into a body shot.
    let t: number | null = null;
    let zone = NetworkHitZone.BODY;
    if (headT !== null) {
      t = bodyT !== null ? Math.min(headT, bodyT) : headT;
      zone = NetworkHitZone.HEAD;
    } else if (bodyT !== null) {
      t = bodyT;
    }
    if (t === null || t > maxRange) continue;
    if (bestT === null || t < bestT) {
      bestT = t;
      bestId = target.id;
      bestZone = zone;
    }
  }

  // Wall first → player behind the wall is NOT hit.
  if (bestT !== null && (wallT === null || bestT <= wallT)) {
    return {
      kind: "player",
      targetId: bestId,
      zone: bestZone,
      point: pointAt(origin, dir, bestT),
      distance: bestT,
    };
  }
  if (wallT !== null) {
    return {
      kind: "wall",
      targetId: null,
      zone: NetworkHitZone.BODY,
      point: pointAt(origin, dir, wallT),
      distance: wallT,
    };
  }
  return null;
}

/** True when no map geometry blocks the segment a → b. */
export function hasLineOfSight(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const t = raycastMap(a, dir, len);
  return t === null || t >= len - 1e-3;
}

export function pointAt(o: Vec3, d: Vec3, t: number): Vec3 {
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}

export function normalize(v: Vec3): Vec3 | null {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}