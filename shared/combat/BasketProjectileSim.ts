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
  /** World bounces still allowed before the ball comes to REST on the next world contact. */
  bouncesLeft: number;
  /** Bounces already performed (event numbering, dedup). */
  bounceCount: number;
  /**
   * True once the ball stopped on the world (rolled out of speed /
   * degenerate corner): it stays where it is, INERT (no more contacts, no
   * damage), until the lifetime expires.
   */
  resting: boolean;
  /**
   * True while the ball ROLLS on a floor-like surface (bounce budget spent
   * or rebound too weak to bounce): the normal component of every floor
   * contact is killed, the tangential speed is kept and decays with
   * `rollingDeceleration`. Cleared by a real reflection (wall bounce).
   */
  rolling: boolean;
  /**
   * Gravity-FREE flight distance still available (m). While > 0 the ball
   * flies dead straight along its velocity (hit-tag: the crosshair is the
   * impact point). Spent by the travelled distance and ZEROED at the first
   * world bounce — after that the ball falls and bounces like any
   * basketball. Levels without a straight budget start at 0.
   */
  straightLeft: number;
}

export type BasketStepEvent =
  | { type: "bounce"; index: number; pos: BasketVec3; vel: BasketVec3; normal: BasketVec3 }
  | { type: "hit"; targetId: string; point: BasketVec3 }
  /** The ball came to rest on the world (NOT terminal: it stays until expiry). */
  | { type: "rest"; point: BasketVec3; normal: BasketVec3 }
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
    resting: false,
    rolling: false,
    straightLeft: cfg.throws[level - 1].straightFlightMeters,
  };
}

function normalizeOrZero(v: BasketVec3): BasketVec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 0 };
}

/**
 * Aim-frame basis for the launch: `right` = aim × worldUp (flat), `down` =
 * −worldUp. A near-vertical aim falls back to a stable right vector so the
 * hand offset never collapses.
 */
function launchBasis(dir: BasketVec3): { fwd: BasketVec3; right: BasketVec3 } {
  const fwd = normalizeOrZero(dir);
  // fwd × up (Y-up, right-handed) = (−fz, 0, fx): looking down −Z → right = +X.
  let right = { x: -fwd.z, y: 0, z: fwd.x };
  const len = Math.hypot(right.x, right.z);
  right = len > 1e-4 ? { x: right.x / len, y: 0, z: right.z / len } : { x: 1, y: 0, z: 0 };
  return { fwd, right };
}

/**
 * WORLD launch point of the ball for a shooter eye `eye` aiming along
 * `dir`: the RIGHT HAND (eye + right / down / forward offsets in the aim
 * frame) — the ball never pops out of the head. Shared by the shooter's
 * prediction and the server so both create the ball at the same point.
 */
export function basketLaunchOrigin(eye: BasketVec3, dir: BasketVec3): BasketVec3 {
  const o = NetworkWeaponConfig.goofyBasket.launchOffset;
  const { fwd, right } = launchBasis(dir);
  return {
    x: eye.x + right.x * o.right + fwd.x * o.forward,
    y: eye.y - o.down + fwd.y * o.forward,
    z: eye.z + right.z * o.right + fwd.z * o.forward,
  };
}

/**
 * Initial velocity of the ball (m/s), SHARED rule:
 *   1. direction = from the hand launch point toward the eye aim line at
 *      the level's `convergeDistance` (the ball rejoins the crosshair, no
 *      lift) — the max charge converges far out so it stays on the
 *      crosshair at sniper range;
 *   2. magnitude = level speed + the shooter's momentum along that line
 *      (forward factor; never negative — a backpedalling shooter throws at
 *      the plain level speed) — "the faster the player, the faster the ball";
 *   3. plus the perpendicular shooter velocity × lateral factor (readable
 *      from a strafing / sliding player).
 * `shooterVel` may be omitted (standing shooter / legacy callers).
 */
export function basketLaunchVelocity(
  dir: BasketVec3,
  level: 1 | 2 | 3,
  shooterVel: BasketVec3 | null = null,
  eye: BasketVec3 | null = null,
): BasketVec3 {
  const cfg = NetworkWeaponConfig.goofyBasket;
  const def = cfg.throws[level - 1];
  const speed = def.speed;
  const fwd = normalizeOrZero(dir);
  let d = fwd;
  if (eye) {
    // Converge from the hand toward the point the eye aims at.
    const origin = basketLaunchOrigin(eye, fwd);
    const target = {
      x: eye.x + fwd.x * def.convergeDistance,
      y: eye.y + fwd.y * def.convergeDistance,
      z: eye.z + fwd.z * def.convergeDistance,
    };
    const conv = normalizeOrZero({ x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z });
    if (conv.x !== 0 || conv.y !== 0 || conv.z !== 0) d = conv;
  }
  let v = { x: d.x * speed, y: d.y * speed, z: d.z * speed };
  if (shooterVel) {
    let sv = { x: shooterVel.x, y: shooterVel.y, z: shooterVel.z };
    const sLen = Math.hypot(sv.x, sv.y, sv.z);
    if (!Number.isFinite(sLen)) sv = { x: 0, y: 0, z: 0 };
    else if (sLen > cfg.maxShooterSpeed) {
      const k = cfg.maxShooterSpeed / sLen;
      sv = { x: sv.x * k, y: sv.y * k, z: sv.z * k };
    }
    // Signed projection on the aim: the perpendicular part is what remains
    // once the WHOLE along-aim component is removed (so a backpedalling
    // shooter's backward velocity never leaks into the lateral carry);
    // only a POSITIVE along-aim component speeds the ball up.
    const alongSigned = sv.x * d.x + sv.y * d.y + sv.z * d.z;
    const perp = { x: sv.x - d.x * alongSigned, y: sv.y - d.y * alongSigned, z: sv.z - d.z * alongSigned };
    // Only the horizontal part of the perpendicular velocity is carried: a
    // jumping shooter must not lob the ball into the sky.
    perp.y = 0;
    const fwdGain = Math.max(0, alongSigned) * cfg.shooterMomentumForwardFactor;
    v = {
      x: v.x + d.x * fwdGain + perp.x * cfg.shooterMomentumLateralFactor,
      y: v.y + d.y * fwdGain,
      z: v.z + d.z * fwdGain + perp.z * cfg.shooterMomentumLateralFactor,
    };
  }
  return v;
}

/**
 * Nearest world hit distance along a ray, or null — injected by each side
 * (server: shared AABB list; client: Rapier world). Used only to keep the
 * hand launch point out of geometry.
 */
export type BasketWorldRaycast = (from: BasketVec3, dir: BasketVec3, maxDist: number) => number | null;

/**
 * SHARED launch resolution (server + shooter prediction): the ball starts
 * at the RIGHT HAND point unless the eye → hand segment (plus one ball
 * radius of margin) crosses geometry — then it starts at the eye pushed
 * forward by its radius (or at the eye itself when even that is blocked).
 * The velocity always converges toward the eye aim line and inherits the
 * shooter's momentum.
 */
export function resolveBasketLaunch(
  eye: BasketVec3,
  dir: BasketVec3,
  level: 1 | 2 | 3,
  shooterVel: BasketVec3 | null,
  raycast: BasketWorldRaycast,
): { start: BasketVec3; vel: BasketVec3 } {
  const r = NetworkWeaponConfig.goofyBasket.projectileRadius;
  const fwd = normalizeOrZero(dir);
  const hand = basketLaunchOrigin(eye, fwd);
  const toHand = { x: hand.x - eye.x, y: hand.y - eye.y, z: hand.z - eye.z };
  const handDist = Math.hypot(toHand.x, toHand.y, toHand.z);
  const handDir = normalizeOrZero(toHand);
  const handBlocked = handDist > 1e-6 && raycast(eye, handDir, handDist + r) !== null;
  let start: BasketVec3;
  let velEye: BasketVec3 | null;
  if (!handBlocked) {
    start = hand;
    velEye = eye; // converge from the hand toward the crosshair
  } else {
    const exitBlocked = raycast(eye, fwd, r * 1.5) !== null;
    start = exitBlocked ? { ...eye } : { x: eye.x + fwd.x * r, y: eye.y + fwd.y * r, z: eye.z + fwd.z * r };
    velEye = null; // already on the aim line: straight along it
  }
  return { start, vel: basketLaunchVelocity(fwd, level, shooterVel, velEye) };
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
 * further contact in the same step puts the ball to rest (safety against
 * a degenerate corner).
 *
 * A FLOOR contact with no bounce budget left (or a rebound too weak to
 * bounce) does NOT stop the ball: it starts ROLLING — the normal velocity
 * component is killed, the tangential speed is kept and decays with
 * `rollingDeceleration` every step. Wall contacts keep reflecting a rolling
 * ball (it never stops dead against a wall). The ball only comes to REST
 * (`rest` event, velocity zeroed, inert until expiry) once its rolling
 * speed really drops under `minBounceSpeed` — or on a degenerate corner
 * (contact cap). It stays visible until `maxLifetimeSeconds` — the only
 * terminal events are a player `hit` and the lifetime `expired`.
 *
 * STRAIGHT FLIGHT (max charge): while `straightLeft` > 0 the step is flown
 * WITHOUT gravity along the current velocity (hit-tag: the ball goes where
 * the crosshair points, at sniper speed). The budget is spent by the
 * travelled distance and ends at the FIRST world bounce; the rest of the
 * step — and every later one — is the normal ballistic basketball. Every
 * bounce also clamps the outgoing speed to `maxSpeedAfterBounce` so a
 * 200 m/s arrival never becomes a 150 m/s ricochet.
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
  if (p.resting) return events; // inert until expiry

  const rest = (n: BasketVec3, contactPoint: BasketVec3): BasketStepEvent[] => {
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.resting = true;
    // Sit on the surface (never inside it) — same clearance as a bounce.
    p.pos.x += n.x * cfg.surfaceClearance;
    p.pos.y += n.y * cfg.surfaceClearance;
    p.pos.z += n.z * cfg.surfaceClearance;
    events.push({ type: "rest", point: contactPoint, normal: { ...n } });
    return events;
  };

  // ---- Phase 1: STRAIGHT flight (max charge "sniper ball") ----
  // Gravity is SUSPENDED while the straight-flight budget lasts: the ball
  // flies dead straight along its velocity (hit-tag — the crosshair is the
  // impact point) until the budget is spent by distance or the ball
  // bounces ONCE on the world. A step that crosses the budget end is
  // split: straight part first, the leftover time under gravity below.
  let remaining = dt;
  const contacts = { n: 0 };
  if (p.straightLeft > 0) {
    const speed0 = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (speed0 > 1e-6) {
      const straightTime = Math.min(remaining, p.straightLeft / speed0);
      if (straightTime <= 1e-7) {
        p.straightLeft = 0; // floating-point crumbs: the budget is spent
      } else {
        const leftover = sweepAndBounce(p, straightTime, caster, ownerId, radius, cfg, events, rest, contacts);
        if (leftover < 0) return events; // terminal (player hit / rest)
        remaining = remaining - straightTime + leftover;
        if (remaining <= 1e-7) return events; // the whole step flew straight
      }
    }
  }

  // ---- Phase 2: ballistic (semi-implicit gravity on the time actually
  // spent under it, then the swept displacement) ----
  if (p.rolling) {
    // Rolling friction on the horizontal speed only (gravity keeps the ball
    // glued to the floor through the next contact). Once the roll is spent
    // the ball comes to rest right where it is — never before.
    const h = Math.hypot(p.vel.x, p.vel.z);
    const next = Math.max(0, h - cfg.rollingDeceleration * remaining);
    if (next < cfg.minBounceSpeed) {
      rest({ x: 0, y: 1, z: 0 }, { x: p.pos.x, y: p.pos.y - radius, z: p.pos.z });
      return events;
    }
    const k = next / h;
    p.vel.x *= k;
    p.vel.z *= k;
  }
  p.vel.y -= cfg.gravity * remaining;
  sweepAndBounce(p, remaining, caster, ownerId, radius, cfg, events, rest, contacts);
  return events;
}

/**
 * Resolve up to `time` seconds of swept motion at the CURRENT velocity (no
 * gravity applied here — the caller owns it). Returns:
 *   -1  → terminal outcome (player hit / rest): stop the step;
 *   ≥0  → time NOT consumed. 0 when the whole time was flown; > 0 when the
 *         straight-flight budget ENDED inside this call (first world
 *         bounce) so the caller finishes the step under gravity.
 * `contacts` is shared across the two phases of one step (corner cap).
 */
function sweepAndBounce(
  p: BasketProjectileState,
  time: number,
  caster: BasketSweepCaster,
  ownerId: string | null,
  radius: number,
  cfg: typeof NetworkWeaponConfig.goofyBasket,
  events: BasketStepEvent[],
  rest: (n: BasketVec3, contactPoint: BasketVec3) => BasketStepEvent[],
  contacts: { n: number },
): number {
  let remaining = time;
  while (remaining > 1e-7) {
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (speed < 1e-6) return 0;
    const dir = { x: p.vel.x / speed, y: p.vel.y / speed, z: p.vel.z / speed };
    const stepLen = speed * remaining;
    const hit = caster.sweep(p.pos, dir, stepLen, radius, ownerId);
    if (!hit || hit.distance > stepLen) {
      p.pos.x += dir.x * stepLen;
      p.pos.y += dir.y * stepLen;
      p.pos.z += dir.z * stepLen;
      if (p.straightLeft > 0) p.straightLeft = Math.max(0, p.straightLeft - stepLen);
      return 0;
    }

    const travelled = Math.max(0, hit.distance);
    p.pos.x += dir.x * travelled;
    p.pos.y += dir.y * travelled;
    p.pos.z += dir.z * travelled;
    remaining -= travelled / speed;
    const wasStraight = p.straightLeft > 0;
    if (wasStraight) p.straightLeft = Math.max(0, p.straightLeft - travelled);

    if (hit.kind === "player") {
      const point = {
        x: p.pos.x - hit.normal.x * radius,
        y: p.pos.y - hit.normal.y * radius,
        z: p.pos.z - hit.normal.z * radius,
      };
      events.push({ type: "hit", targetId: hit.targetId ?? "", point });
      return -1; // first accepted player contact consumes the ball
    }

    // ---- World contact ----
    const n = hit.normal;
    const contactPoint = {
      x: p.pos.x - n.x * radius,
      y: p.pos.y - n.y * radius,
      z: p.pos.z - n.z * radius,
    };
    contacts.n++;
    if (contacts.n > cfg.maxContactsPerStep) {
      rest(n, contactPoint); // degenerate corner — safety stop
      return -1;
    }
    const e = cfg.throws[p.level - 1].restitution;
    const vn = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
    // Normal rebound speed a reflection WOULD give (0 if moving away).
    const rebound = vn < 0 ? -vn * e : 0;
    const floorLike = n.y >= cfg.rollingSurfaceMinNormalY;
    let signal = true; // emit a bounce event (audio / network correction)

    if (floorLike && (p.bouncesLeft <= 0 || rebound < cfg.minBounceSpeed)) {
      // ---- ROLL: no budget left (or too weak to bounce) on a floor-like
      // surface → kill the normal component only, keep the tangential
      // speed. The ball keeps rolling; friction is applied per step in the
      // ballistic phase. It only rests once its rolling speed is spent.
      if (vn < 0) {
        p.vel.x -= vn * n.x;
        p.vel.y -= vn * n.y;
        p.vel.z -= vn * n.z;
      }
      if (Math.hypot(p.vel.x, p.vel.y, p.vel.z) < cfg.minBounceSpeed) {
        rest(n, contactPoint); // really out of speed — stops here
        return -1;
      }
      const wasRolling = p.rolling;
      p.rolling = true;
      // The first roll contact and any LANDING (rolled off a ledge, arrived
      // fast along the normal) are audible / correctable; the per-step
      // gravity nudge that keeps a flat roll glued to the floor is silent.
      signal = !wasRolling || -vn >= cfg.rollingLandingMinNormalSpeed;
    } else {
      // ---- BOUNCE: reflect v' = v − (1 + e)(v·n)n on the normal component
      // only, so the tangential slide keeps its full speed. A wall / ceiling
      // reflects even a budget-less rolling ball — it never stops dead
      // against a wall, it comes back and keeps rolling.
      if (vn < 0) {
        p.vel.x -= (1 + e) * vn * n.x;
        p.vel.y -= (1 + e) * vn * n.y;
        p.vel.z -= (1 + e) * vn * n.z;
      }
      if (floorLike) p.rolling = false; // real floor rebound: airborne again
      if (p.bouncesLeft > 0) p.bouncesLeft--;
    }
    // A sniper-speed ball dumps its excess energy on the wall: capped to a
    // readable basketball rebound (direction preserved, magnitude clamped).
    const outSpeed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (outSpeed > cfg.maxSpeedAfterBounce) {
      const k = cfg.maxSpeedAfterBounce / outSpeed;
      p.vel.x *= k;
      p.vel.y *= k;
      p.vel.z *= k;
    }
    // Small clearance off the surface: the next sweep never starts inside it.
    p.pos.x += n.x * cfg.surfaceClearance;
    p.pos.y += n.y * cfg.surfaceClearance;
    p.pos.z += n.z * cfg.surfaceClearance;
    if (signal) {
      p.bounceCount++;
      events.push({
        type: "bounce",
        index: p.bounceCount,
        pos: { ...p.pos },
        vel: { ...p.vel },
        normal: { ...n },
      });
    }
    if (Math.hypot(p.vel.x, p.vel.y, p.vel.z) < cfg.minBounceSpeed) {
      rest(n, contactPoint);
      return -1;
    }
    if (wasStraight) {
      // The FIRST world bounce ends the straight flight: the ball is a
      // plain basketball from here on. Hand the unspent time back so the
      // caller finishes this step under gravity.
      p.straightLeft = 0;
      return Math.max(0, remaining);
    }
  }
  return 0;
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

