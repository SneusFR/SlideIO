import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../../physics/PhysicsWorld";
import { Bot } from "../../bots/Bot";
import { TrainingTarget } from "../../targets/TrainingTarget";
import { HexSniperConfig as cfg } from "./HexSniperConfig";
import { distanceToBoxExit } from "./HexSniperAttacks";
import type {
  HexSniperWorldApi,
  HexSniperSweepHit,
  HexSniperBiteHit,
  HexSniperMoveResult,
} from "./HexSniperAttacks";

/**
 * The five HexSniperAttacks callbacks implemented on the game's REAL
 * physics (Rapier) — replaces the kit's DemoWorld. World-space meters,
 * synchronous queries, run on the local simulation authority (solo/bots).
 *
 * Collision-group filters (see PhysicsWorld.CollisionGroups):
 *  - TONGUE sweep hits static world (bit 0) + character capsules (bit 2),
 *    and NEVER ragdoll parts (bit 1) — corpses don't block, exactly like
 *    the shared castBeam convention.
 *  - BITE / occlusion rays test the STATIC world only (bit 0): a wall
 *    always occludes, another character never does.
 */

/** Member of everything; collides with WORLD (bit 0) + CHARACTER (bit 2). */
const TONGUE_SWEEP_GROUPS = (0xffff << 16) | 0x0005;
/** Member of everything; collides with the WORLD bit only (occlusion). */
const STATIC_ONLY_GROUPS = (0xffff << 16) | 0x0001;

export class HexSniperWorldAdapter implements HexSniperWorldApi {
  /** Physics-step duration, refreshed by the weapon before attacks.update. */
  private stepDt = 1 / 60;

  private readonly mapBox = new THREE.Box3(
    new THREE.Vector3(cfg.mapBounds.min.x, cfg.mapBounds.min.y, cfg.mapBounds.min.z),
    new THREE.Vector3(cfg.mapBounds.max.x, cfg.mapBounds.max.y, cfg.mapBounds.max.z),
  );

  // Scratch (no per-query allocations)
  private readonly segment = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly targetPos = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly closest = new THREE.Vector3();
  private readonly rayDir = { x: 0, y: 0, z: 0 };
  private readonly rayOrigin = { x: 0, y: 0, z: 0 };
  private readonly shapeVel = { x: 0, y: 0, z: 0 };
  private readonly identityRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly tongueBall = new RAPIER.Ball(cfg.tongueRadius);
  /** Reused result array — consumed synchronously by HexSniperAttacks. */
  private readonly biteHits: HexSniperBiteHit[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    /** Local player's collider/body — the tongue always ignores its owner. */
    private readonly ownerCollider: RAPIER.Collider,
    private readonly ownerBody: RAPIER.RigidBody,
    /** Live rosters (deferred: the bot manager is built after the weapons). */
    private readonly getBots: () => readonly Bot[],
    private readonly getTargets: () => readonly TrainingTarget[],
  ) {}

  /** Called by the weapon right before every attacks.update(dt). */
  setStepDt(dt: number): void {
    if (dt > 1e-6) this.stepDt = dt;
  }

  /** Raw result of the LAST sweepTongue call (the kit's 'tongue-world'
   *  event only carries the point — the weapon reads the struck training
   *  target / bot from here, synchronously after the event). */
  lastSweepHit: HexSniperSweepHit | null = null;

  /** Resolve a grabbed player id to its live Combatant (Bot). */
  getCombatant(id: number | string): Bot | null {
    return this.botById(id);
  }

  // ---- 1. distanceToMapExit --------------------------------------------
  distanceToMapExit(point: THREE.Vector3, direction: THREE.Vector3, radius: number): number {
    return distanceToBoxExit(point, direction, this.mapBox, radius);
  }

  // ---- 2. sweepTongue -----------------------------------------------------
  sweepTongue(
    from: THREE.Vector3,
    to: THREE.Vector3,
    options: { ownerId: number | string; radius: number },
  ): HexSniperSweepHit | null {
    this.segment.subVectors(to, from);
    const length = this.segment.length();
    this.lastSweepHit = null;
    if (length < 1e-7) return null;

    // Shape cast: a ball swept along the FULL segment in one time unit —
    // hit point = from + segment * toi, always ON the segment (kit contract).
    this.shapeVel.x = this.segment.x;
    this.shapeVel.y = this.segment.y;
    this.shapeVel.z = this.segment.z;
    this.rayOrigin.x = from.x;
    this.rayOrigin.y = from.y;
    this.rayOrigin.z = from.z;
    const ball =
      options.radius === cfg.tongueRadius ? this.tongueBall : new RAPIER.Ball(options.radius);
    const hit = this.physics.world.castShape(
      this.rayOrigin,
      this.identityRot,
      this.shapeVel,
      ball,
      0, // targetDistance: report the exact contact
      1, // maxToi: the whole segment
      true, // stopAtPenetration: starting inside something is a hit at 0
      undefined,
      TONGUE_SWEEP_GROUPS,
      this.ownerCollider,
      this.ownerBody,
    );
    let bestT = hit ? hit.time_of_impact : Infinity;
    let bestBot: Bot | null = hit ? this.botFromCollider(hit.collider.handle) : null;
    let bestTarget: TrainingTarget | null = null;

    // Training targets are raycast-only visuals (no physics collider):
    // sphere-vs-segment, competing for the FIRST contact with the world hit.
    const sphereRadius = cfg.targetHitRadius + options.radius;
    for (const target of this.getTargets()) {
      if (target.dead) continue;
      target.group.getWorldPosition(this.targetPos);
      const t = this.segmentSphereT(from, this.segment, length, this.targetPos, sphereRadius);
      if (t !== null && t < bestT) {
        bestT = t;
        bestTarget = target;
        bestBot = null;
      }
    }

    if (!Number.isFinite(bestT)) return null;
    this.hitPoint.copy(from).addScaledVector(this.segment, bestT);
    if (bestBot && bestBot.health.alive) {
      // A dead capsule should never grab — alive check is the safety net.
      this.lastSweepHit = { point: this.hitPoint, kind: "player", playerId: bestBot.id };
    } else {
      this.lastSweepHit = {
        point: this.hitPoint,
        kind: bestTarget ? "target" : "world",
        playerId: null,
        trainingTarget: bestTarget,
      };
    }
    return this.lastSweepHit;
  }

  // ---- 3. getPlayerPosition ---------------------------------------------
  getPlayerPosition(id: number | string, out: THREE.Vector3): boolean {
    const bot = this.botById(id);
    if (!bot || !bot.health.alive) return false;
    bot.getPosition(out);
    return true;
  }

  // ---- 4. movePlayerToward ----------------------------------------------
  movePlayerToward(
    id: number | string,
    destination: THREE.Vector3,
    options: { maxDistance: number; stopDistance: number; ownerId: number | string },
  ): HexSniperMoveResult {
    const bot = this.botById(id);
    if (!bot || !bot.health.alive) return { valid: false };
    return bot.pullToward(
      destination,
      options.maxDistance,
      options.stopDistance,
      this.stepDt,
      cfg.pullBlockedRatio,
    );
  }

  // ---- 5. queryBite -------------------------------------------------------
  queryBite(query: {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    range: number;
    radius: number;
    ownerId: number | string;
    attackId: number;
    pulse: number;
  }): HexSniperBiteHit[] {
    this.biteHits.length = 0;

    for (const bot of this.getBots()) {
      if (!bot.health.alive) continue;
      bot.getPosition(this.targetPos);
      if (
        this.insideBiteVolume(query, this.targetPos, query.radius + cfg.biteTargetRadius) &&
        !this.occluded(query.origin, this.targetPos)
      ) {
        this.biteHits.push({ id: bot.id, kind: "player", playerId: bot.id, combatant: bot });
      }
    }

    const targets = this.getTargets();
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target.dead) continue;
      target.group.getWorldPosition(this.targetPos);
      if (
        this.insideBiteVolume(query, this.targetPos, query.radius + cfg.targetHitRadius) &&
        !this.occluded(query.origin, this.targetPos)
      ) {
        this.biteHits.push({ id: `target-${i}`, kind: "target", trainingTarget: target });
      }
    }

    return this.biteHits;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private botById(id: number | string): Bot | null {
    for (const bot of this.getBots()) if (bot.id === id) return bot;
    return null;
  }

  private botFromCollider(handle: number): Bot | null {
    for (const bot of this.getBots()) if (bot.colliderHandle === handle) return bot;
    return null;
  }

  /** Center within `radius` of the short capsule in front of the mouth? */
  private insideBiteVolume(
    query: { origin: THREE.Vector3; direction: THREE.Vector3; range: number },
    center: THREE.Vector3,
    radius: number,
  ): boolean {
    this.toTarget.subVectors(center, query.origin);
    const along = THREE.MathUtils.clamp(this.toTarget.dot(query.direction), 0, query.range);
    this.closest.copy(query.origin).addScaledVector(query.direction, along);
    return this.closest.distanceToSquared(center) <= radius * radius;
  }

  /** True when a STATIC wall stands between the mouth and the target. */
  private occluded(origin: THREE.Vector3, center: THREE.Vector3): boolean {
    this.toTarget.subVectors(center, origin);
    const dist = this.toTarget.length();
    if (dist < 1e-6) return false;
    this.rayOrigin.x = origin.x;
    this.rayOrigin.y = origin.y;
    this.rayOrigin.z = origin.z;
    this.rayDir.x = this.toTarget.x / dist;
    this.rayDir.y = this.toTarget.y / dist;
    this.rayDir.z = this.toTarget.z / dist;
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(this.rayOrigin, this.rayDir),
      dist,
      true,
      undefined,
      STATIC_ONLY_GROUPS,
      this.ownerCollider,
      this.ownerBody,
    );
    return hit !== null;
  }

  /**
   * First intersection parameter t ∈ [0,1] of segment `from + seg*t` with a
   * sphere (center, radius) — null when the segment misses the sphere.
   */
  private segmentSphereT(
    from: THREE.Vector3,
    seg: THREE.Vector3,
    length: number,
    center: THREE.Vector3,
    radius: number,
  ): number | null {
    this.toTarget.subVectors(from, center);
    const a = length * length;
    const b = 2 * seg.dot(this.toTarget);
    const c = this.toTarget.lengthSq() - radius * radius;
    if (c <= 0) return 0; // starts inside the sphere
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a < 1e-12) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : null;
  }
}
