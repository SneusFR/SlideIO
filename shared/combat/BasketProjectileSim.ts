/**
 * SHARED GoofyBasket projectile integration — pure TypeScript, no Three,
 * no Rapier, no Colyseus. Used by the server (authoritative) and by the
 * client prediction / remote replay so a ball follows the SAME arc and
 * bounces everywhere.
 *
 * The world/target collision queries are injected (`BasketSweepCaster`):
 * the server sweeps the shared AABB list + player capsules, the client
 * sweeps its Rapier world + combatant meshes. This module only owns the
 * integration rule: gravity, swept sphere along the step, reflection with
 * restitution, remaining-time continuation, surface clearance, bounce
 * budget, contact cap per step, lifetime.
 */
import { NetworkWeaponConfig } from "./NetworkWeapons";

export interface BasketVec3 {
  x: number;
  y: number;
  z: number;
}

/** Nearest contact along a swept sphere (center path `from` → `from + dir·maxDist`). */
export interface BasketSweepHit {
  /** Distance travelled by the CENTER before the contact. */
  distance: number;
  /** Contact normal (unit, pointing away from the surface). */
  normal: BasketVec3;
  /** "world" = static geometry (bounce budget); "player" = consumed. */
  kind: "world" | "player";
  /** Player id / combatant key for a "player" contact. */
  targetId?: string;
}

/** Collision query provider for one projectile radius. */
export interface BasketSweepCaster {
  /**
   * Nearest contact of a sphere of `radius` swept from `from` along the
   * unit `dir` for `maxDist`, or null. `excludeId` = owner (never hit).
   */
  sweep(
    from: BasketVec3,
    dir: BasketVec3,
    maxDist: number,
    radius: number,
    excludeId: string | null,
  ): BasketSweepHit | null;
}

export interface BasketProjectileState {
  pos: BasketVec3;
  vel: BasketVec3;
  age: number;
  level: 1 | 2 | 3;
  /** World bounces still allowed before the next world contact ends it. */
  bouncesLeft: number;
  /** Bounces already performed (event numbering, dedup). */
  bounceCount: number;
}

export type BasketStepEvent =
  | { type: "bounce"; index: number; pos: BasketVec3; vel: BasketVec3; normal: BasketVec3 }
  | { type: "hit"; targetId: string; point: BasketVec3 }
  | { type: "world-end"; point: BasketVec3; normal: BasketVec3 }
  | { type: "expired"; point: BasketVec3 };

export function createBasketProjectileState(
  pos: BasketVec3,
  vel: BasketVec3,
  level: 1 | 2 | 3,
): BasketProjectileState {
  const cfg = NetworkWeaponConfig.goofyBasket;
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: vel.x, y: vel.y, z: vel.z },
    age: 0,
    level,
    bouncesLeft: cfg.throws[level - 1].maxWorldBounces,
    bounceCount: 0,
  };
}

/** Initial velocity = validated aim direction × level speed (NO added lift). */
export function basketLaunchVelocity(dir: BasketVec3, level: 1 | 2 | 3): BasketVec3 {
  const speed = NetworkWeaponConfig.goofyBasket.throws[level - 1].speed;
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return { x: (dir.x / len) * speed, y: (dir.y / len) * speed, z: (dir.z / len) * speed };
}

/**
 * Advance the projectile by `dt`. Returns every event produced this step
 * (0..n bounces, then optionally ONE terminal event). After a terminal
 * event the state must be discarded by the caller.
 *
 * The step is resolved as a chain of swept segments: each contact
 * consumes the travelled distance, reflects the velocity, pushes the
 * center off the surface by `surfaceClearance`, and continues the
 * REMAINING time along the new direction (never "move then test the
 * final point"). At most `maxContactsPerStep` contacts are resolved; a
 * further contact in the same step ends the ball (safety against a
 * degenerate corner).
 */
export function stepBasketProjectile(
  p: BasketProjectileState,
  dt: number,
  caster: BasketSweepCaster,
  ownerId: string | null,
  radius = NetworkWeaponConfig.goofyBasket.projectileRadius,
): BasketStepEvent[] {
  const cfg = NetworkWeaponConfig.goofyBasket;
  const events: BasketStepEvent[] = [];
  if (dt <= 0) return events;

  p.age += dt;
  if (p.age >= cfg.maxLifetimeSeconds) {
    events.push({ type: "expired", point: { ...p.pos } });
    return events;
  }

  // Semi-implicit gravity (velocity first, then the swept displacement).
  p.vel.y -= cfg.gravity * dt;

  let remaining = dt;
  let contacts = 0;
  while (remaining > 1e-7) {
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (speed < 1e-6) break;
    const dir = { x: p.vel.x / speed, y: p.vel.y / speed, z: p.vel.z / speed };
    const stepLen = speed * remaining;
    const hit = caster.sweep(p.pos, dir, stepLen, radius, ownerId);
    if (!hit || hit.distance > stepLen) {
      p.pos.x += dir.x * stepLen;
      p.pos.y += dir.y * stepLen;
      p.pos.z += dir.z * stepLen;
      break;
    }

    const travelled = Math.max(0, hit.distance);
    p.pos.x += dir.x * travelled;
    p.pos.y += dir.y * travelled;
    p.pos.z += dir.z * travelled;
    remaining -= travelled / speed;

    if (hit.kind === "player") {
      const point = {
        x: p.pos.x - hit.normal.x * radius,
        y: p.pos.y - hit.normal.y * radius,
        z: p.pos.z - hit.normal.z * radius,
      };
      events.push({ type: "hit", targetId: hit.targetId ?? "", point });
      return events; // first accepted player contact consumes the ball
    }

    // ---- World contact ----
    const n = hit.normal;
    const contactPoint = {
      x: p.pos.x - n.x * radius,
      y: p.pos.y - n.y * radius,
      z: p.pos.z - n.z * radius,
    };
    contacts++;
    if (p.bouncesLeft <= 0 || contacts > cfg.maxContactsPerStep) {
      events.push({ type: "world-end", point: contactPoint, normal: { ...n } });
      return events;
    }
    // Reflect: v' = v − (1 + e)(v·n)n on the normal component only, so the
    // tangential slide keeps its full speed (rolling feel on shallow hits).
    const e = cfg.throws[p.level - 1].restitution;
    const vn = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
    if (vn < 0) {
      p.vel.x -= (1 + e) * vn * n.x;
      p.vel.y -= (1 + e) * vn * n.y;
      p.vel.z -= (1 + e) * vn * n.z;
    }
    // Small clearance off the surface: the next sweep never starts inside it.
    p.pos.x += n.x * cfg.surfaceClearance;
    p.pos.y += n.y * cfg.surfaceClearance;
    p.pos.z += n.z * cfg.surfaceClearance;
    p.bouncesLeft--;
    p.bounceCount++;
    events.push({
      type: "bounce",
      index: p.bounceCount,
      pos: { ...p.pos },
      vel: { ...p.vel },
      normal: { ...n },
    });
    if (Math.hypot(p.vel.x, p.vel.y, p.vel.z) < cfg.minBounceSpeed) {
      events.push({ type: "world-end", point: contactPoint, normal: { ...n } });
      return events;
    }
  }
  return events;
}


// ---------------------------------------------------------------------
// Analytic swept-sphere primitives (server + tests; the client may use
// its physics engine instead).
// ---------------------------------------------------------------------

/**
 * Swept sphere vs axis-aligned box (center + half extents). Equivalent to
 * a ray against the Minkowski-inflated box: faces inflated by `r`; the
 * rounded edges/corners are approximated by the inflated box (a
 * conservative, stable choice for gameplay bounces). Returns the entry
 * distance and the face normal, or null.
 */
export function sweepSphereAabb(
  o: BasketVec3,
  d: BasketVec3,
  r: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  maxDist: number,
): { distance: number; normal: BasketVec3 } | null {
  const oArr = [o.x, o.y, o.z];
  const dArr = [d.x, d.y, d.z];
  const cArr = [cx, cy, cz];
  const hArr = [hx + r, hy + r, hz + r];
  let tMin = 0;
  let tMax = maxDist;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const lo = cArr[i] - hArr[i];
    const hi = cArr[i] + hArr[i];
    if (Math.abs(dArr[i]) < 1e-9) {
      if (oArr[i] < lo || oArr[i] > hi) return null;
      continue;
    }
    const inv = 1 / dArr[i];
    let t1 = (lo - oArr[i]) * inv;
    let t2 = (hi - oArr[i]) * inv;
    let s = -1; // entering through the low face → normal points to −axis
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (axis < 0) {
    // Started inside the inflated box: push out along the least penetrated face.
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const pen = hArr[i] - Math.abs(oArr[i] - cArr[i]);
      if (pen < best) {
        best = pen;
        axis = i;
        sign = oArr[i] >= cArr[i] ? 1 : -1;
      }
    }
    tMin = 0;
  }
  const normal = { x: 0, y: 0, z: 0 };
  if (axis === 0) normal.x = sign;
  else if (axis === 1) normal.y = sign;
  else normal.z = sign;
  return { distance: tMin, normal };
}

/** Swept sphere (radius r) vs sphere (center c, radius R): nearest t ≥ 0 or null. */
export function sweepSphereSphere(
  o: BasketVec3,
  d: BasketVec3,
  r: number,
  c: BasketVec3,
  R: number,
): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const rr = r + R;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - rr * rr;
  if (cc <= 0) return 0; // already overlapping
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/**
 * Swept sphere vs vertical capsule (axis Y): cylinder on XZ inflated by
 * r + caps. Returns the nearest t ≥ 0 or null.
 */
export function sweepSphereVerticalCapsule(
  o: BasketVec3,
  d: BasketVec3,
  r: number,
  center: BasketVec3,
  halfHeight: number,
  radius: number,
): number | null {
  let best: number | null = null;
  const rr = radius + r;
  const ox = o.x - center.x;
  const oz = o.z - center.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - rr * rr;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / a, (-b + sq) / a]) {
        if (t < 0) continue;
        const y = o.y + d.y * t;
        if (Math.abs(y - center.y) <= halfHeight && (best === null || t < best)) best = t;
      }
    }
  } else if (ox * ox + oz * oz <= rr * rr && Math.abs(o.y - center.y) <= halfHeight) {
    best = 0;
  }
  for (const capY of [center.y + halfHeight, center.y - halfHeight]) {
    const t = sweepSphereSphere(o, d, r, { x: center.x, y: capY, z: center.z }, radius);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

