/**
 * SHARED Frisbee flight simulation — pure TypeScript, no Three, no Rapier, no
 * Colyseus. One disc = one SharedFrisbeeSim advanced by FIXED steps of 1/120 s:
 * the server (authoritative) and every client (prediction / replay) integrate
 * the SAME rule, so a disc follows the same arc and the same bounces everywhere.
 *
 * Port of the pack's FrisbeeSim (src/weapons/frisbee/FrisbeeProjectiles.ts,
 * three.js vectors) to plain numbers — the maths, the constants and the order
 * of operations are IDENTICAL (asserted by scripts/test-frisbee-launcher.mts).
 *
 * The collision query is injected (`FrisbeeCast`): the server sweeps the
 * shared AABB list + player capsules, the client sweeps its Rapier world +
 * the combatant volumes.
 */
import { FrisbeeLauncherConfig, type FrisbeeTuning, type FrisbeeVec3 } from "./FrisbeeLauncherRules";
import {
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_HEAD_OFFSET,
  PLAYER_HEAD_RADIUS,
} from "./NetworkWeapons";
import { sweepSphereSphere, sweepSphereVerticalCapsule } from "./BasketProjectileSim";

const STEP = FrisbeeLauncherConfig.simStep;

/** Nearest contact of a swept sphere. `target` = a player (touch), otherwise scenery (bounce). */
export interface FrisbeeCastHit {
  /** Distance travelled by the sphere CENTER before the contact. */
  distance: number;
  point: FrisbeeVec3;
  /** Contact normal (pointing away from the surface). */
  normal: FrisbeeVec3;
  target?: string | null;
  headshot?: boolean;
}

/** Sphere of `radius` swept from `from` along the unit `dir` for `maxDist`. `ignore` = the shooter. */
export type FrisbeeCast = (
  from: FrisbeeVec3,
  dir: FrisbeeVec3,
  maxDist: number,
  radius: number,
  ignore: string | null,
) => FrisbeeCastHit | null;

export interface FrisbeeHitEvent {
  id: number;
  owner: string | null;
  target: string;
  damage: number;
  headshot: boolean;
  /** m/s, world: added to the victim's velocity. */
  impulse: FrisbeeVec3;
  point: FrisbeeVec3;
  bounces: number;
}

export interface FrisbeeSimEvents {
  onHit?: (e: FrisbeeHitEvent) => void;
  onBounce?: (id: number, point: FrisbeeVec3, normal: FrisbeeVec3, speed: number) => void;
  onRest?: (id: number, pos: FrisbeeVec3) => void;
  onExpire?: (id: number) => void;
}

/** One disc (pure simulation, no rendering). */
export class SharedFrisbeeSim {
  pos: FrisbeeVec3;
  vel: FrisbeeVec3;
  age = 0;
  bounces = 0;
  canDamage = true;
  resting = false;
  restAge = 0;
  alive = true;

  constructor(
    readonly id: number,
    origin: FrisbeeVec3,
    direction: FrisbeeVec3,
    readonly owner: string | null,
    readonly tuning: FrisbeeTuning = FrisbeeLauncherConfig.tuning,
  ) {
    this.pos = { x: origin.x, y: origin.y, z: origin.z };
    const l = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z) || 1;
    const k = tuning.speed / l;
    this.vel = { x: direction.x * k, y: direction.y * k, z: direction.z * k };
  }

  /** Advance one fixed step (hit / bounce / rest / expire events go to `ev`). */
  step(cast: FrisbeeCast, ev: FrisbeeSimEvents): void {
    const T = this.tuning;
    if (!this.alive) return;
    this.age += STEP;
    if (this.resting) {
      this.restAge += STEP;
      if (this.restAge > 0.6) {
        this.alive = false;
        ev.onExpire?.(this.id);
      }
      return;
    }
    if (this.age > T.lifetime) {
      this.alive = false;
      ev.onExpire?.(this.id);
      return;
    }
    const v = this.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const lift = T.lift * Math.min(1, speed / T.speed) * (this.bounces > 0 ? 0.35 : 1);
    v.y -= T.gravity * (1 - lift) * STEP;
    const damp = Math.exp(-T.drag * STEP);
    v.x *= damp;
    v.y *= damp;
    v.z *= damp;
    let dx = v.x * STEP;
    let dy = v.y * STEP;
    let dz = v.z * STEP;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= 1e-6) return;
    dx /= len;
    dy /= len;
    dz /= len;
    const hit = cast(this.pos, { x: dx, y: dy, z: dz }, len, T.radius, this.owner);
    if (!hit) {
      this.pos.x += dx * len;
      this.pos.y += dy * len;
      this.pos.z += dz * len;
      return;
    }
    const adv = Math.max(0, hit.distance - 1e-3);
    this.pos.x += dx * adv;
    this.pos.y += dy * adv;
    this.pos.z += dz * adv;
    let nx = hit.normal.x;
    let ny = hit.normal.y;
    let nz = hit.normal.z;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    this.pos.x += nx * 2e-3;
    this.pos.y += ny * 2e-3;
    this.pos.z += nz * 2e-3;
    const vn = v.x * nx + v.y * ny + v.z * nz;
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (hit.target != null) {
      if (this.canDamage && sp >= T.minDamageSpeed) {
        this.canDamage = false;
        const dmg = Math.round(
          T.damageBody * (hit.headshot ? T.headshotMultiplier : 1) * (this.bounces > 0 ? T.bouncedDamageScale : 1),
        );
        let ix = v.x;
        let iz = v.z;
        const il = Math.sqrt(ix * ix + iz * iz);
        if (il * il > 1e-8) {
          ix = (ix / il) * T.knockback;
          iz = (iz / il) * T.knockback;
        }
        ev.onHit?.({
          id: this.id,
          owner: this.owner,
          target: hit.target,
          damage: dmg,
          headshot: !!hit.headshot,
          impulse: { x: ix, y: T.knockbackUp, z: iz },
          point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          bounces: this.bounces,
        });
      }
      // bounce off the player (soft)
      if (vn < 0) {
        const k = -vn * (1 + T.playerRestitution);
        v.x += nx * k;
        v.y += ny * k;
        v.z += nz * k;
      }
      v.x *= 0.6;
      v.y *= 0.6;
      v.z *= 0.6;
    } else {
      this.bounces++;
      if (this.bounces > T.maxBounces) this.canDamage = false;
      if (vn < 0) {
        // v = vt * friction - vn * restitution
        const px = nx * vn;
        const py = ny * vn;
        const pz = nz * vn;
        v.x = (v.x - px) * T.friction + px * -T.restitution;
        v.y = (v.y - py) * T.friction + py * -T.restitution;
        v.z = (v.z - pz) * T.friction + pz * -T.restitution;
      }
      const restNow = ny > 0.7 && Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) < T.restSpeed;
      ev.onBounce?.(this.id, { x: hit.point.x, y: hit.point.y, z: hit.point.z }, { x: nx, y: ny, z: nz }, sp);
      if (restNow) {
        v.x = 0;
        v.y = 0;
        v.z = 0;
        this.resting = true;
        this.canDamage = false;
        ev.onRest?.(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
    }
    // remaining displacement of the step with the new velocity (finished next step, like the pack)
  }
}
/** First contact of a swept disc with one player volume (head sphere + body capsule, shared with the server hit volumes). */
export interface FrisbeePlayerContact {
  /** Distance travelled by the disc CENTER before the contact. */
  t: number;
  normal: FrisbeeVec3;
  /** True when the FIRST contact is the head sphere. */
  head: boolean;
}

/**
 * Swept sphere (`radius`) from `o` along the unit `d` for `maxDist` against a player whose CAPSULE CENTER is
 * `center` (network y). Same volumes as backend HitDetection.sweepBasketSphere; adds the head flag. Used by the
 * server AND by the client prediction so both classify head / body identically.
 */
export function sweepFrisbeePlayer(
  o: FrisbeeVec3,
  d: FrisbeeVec3,
  radius: number,
  center: FrisbeeVec3,
  maxDist: number,
): FrisbeePlayerContact | null {
  const headT = sweepSphereSphere(o, d, radius, { x: center.x, y: center.y + PLAYER_HEAD_OFFSET, z: center.z }, PLAYER_HEAD_RADIUS);
  const bodyT = sweepSphereVerticalCapsule(o, d, radius, center, PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_CAPSULE_RADIUS);
  let t: number | null = null;
  if (headT !== null) t = bodyT !== null ? Math.min(headT, bodyT) : headT;
  else if (bodyT !== null) t = bodyT;
  if (t === null || t > maxDist) return null;
  const px = o.x + d.x * t;
  const py = o.y + d.y * t;
  const pz = o.z + d.z * t;
  const cy = Math.max(center.y - PLAYER_CAPSULE_HALF_HEIGHT, Math.min(center.y + PLAYER_CAPSULE_HALF_HEIGHT, py));
  const nx = px - center.x;
  const ny = py - cy;
  const nz = pz - center.z;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const normal = len > 1e-6 ? { x: nx / len, y: ny / len, z: nz / len } : { x: -d.x, y: -d.y, z: -d.z };
  return { t, normal, head: headT !== null && (bodyT === null || headT <= bodyT) };
}