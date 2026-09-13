import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PhysicsWorld, RAPIER } from "../../physics/PhysicsWorld";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import {
  NetworkWeaponConfig,
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_HEAD_OFFSET,
  PLAYER_HEAD_RADIUS,
} from "../../../shared/combat/NetworkWeapons";
import {
  type BasketProjectileState,
  type BasketSweepCaster,
  type BasketSweepHit,
  type BasketVec3,
  createBasketProjectileState,
  stepBasketProjectile,
  sweepSphereSphere,
  sweepSphereVerticalCapsule,
} from "../../../shared/combat/BasketProjectileSim";
import { GOOFY_BALL } from "./GoofyBasketProfile";
import { instantiateGoofyBasket, loadGoofyBasketGltf } from "./GoofyBasketModel";

const B = NetworkWeaponConfig.goofyBasket;
/** Member of everything; collides with the STATIC world bit only (never characters / ragdolls). */
const WORLD_ONLY_GROUPS = (0xffff << 16) | 0x0001;

/** A combatant the ball can hit, seen as the SHARED server capsule. */
export interface BasketTargetSource {
  /** Every alive combatant except the owner: key + capsule center + resolver. */
  forEach(cb: (key: string, center: THREE.Vector3, combatant: Combatant | null) => void): void;
}

interface FlyingBall {
  root: THREE.Object3D;
  state: BasketProjectileState;
  /** Local prediction id (negative) or server id (positive once reconciled). */
  id: number;
  ownerKey: string | null;
  /** Visual spin axis (cosmetic: seams rotate with the flight). */
  spinAxis: THREE.Vector3;
  /** Remote replay: server-driven — bounces / end come from confirms only. */
  remote: boolean;
  /** Reconciliation blend: displayed offset (predicted − server) decaying to zero. */
  offset: THREE.Vector3;
}

/**
 * Stand-alone GOOFY BASKET balls flying through the world (local shooter
 * prediction / solo authority AND remote replay). Every ball is the REAL
 * GLB cloned (shared geometry + 3 materials, no texture) at
 * `projectileRootScale` directly under the world scene (never under a
 * normalized character). Motion uses the SHARED integration rule
 * (BasketProjectileSim) with this client's collision queries:
 *   - static world: Rapier `castShape(Ball)` on the world bit only;
 *   - combatants: analytic swept sphere vs the SHARED server capsule / head
 *     sphere (bots, local player proxy, remote avatars).
 * SOLO: the first player hit applies the flat 25 damage through Health.
 * MULTIPLAYER: `networkAuthority` → NO damage, the server confirms; the
 * predicted ball is reconciled on its server id.
 */
export class GoofyBasketProjectileSystem {
  owner: Combatant | null = null;
  feedback: HitFeedbackManager | null = null;
  /** True in multiplayer: flight is visual only, hits come from the server. */
  networkAuthority = false;
  /** World bounce observer (audio / dust, both local and remote). */
  onBounce: ((pos: THREE.Vector3, normal: THREE.Vector3, remote: boolean) => void) | null = null;
  /** Ball ended (any cause) — cosmetic hook. */
  onEnd: ((pos: THREE.Vector3, remote: boolean) => void) | null = null;

  private readonly balls: FlyingBall[] = [];
  private gltf: GLTF | null = null;
  private targets: BasketTargetSource | null = null;
  private nextLocalId = -1;
  private readonly ballShape = new RAPIER.Ball(B.projectileRadius);
  private readonly identityRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly caster: BasketSweepCaster;

  // Scratch
  private readonly origin = { x: 0, y: 0, z: 0 };
  private readonly vel = { x: 0, y: 0, z: 0 };
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly nrm = new THREE.Vector3();
  private readonly targetCenter = { x: 0, y: 0, z: 0 };
  private readonly hitCombatants = new Map<string, Combatant | null>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
  ) {
    void loadGoofyBasketGltf().then((g) => (this.gltf = g));
    this.caster = { sweep: (from, dir, maxDist, radius, excludeId) => this.sweep(from, dir, maxDist, radius, excludeId) };
  }

  /** Register the combatant roster (bots + player proxy / remote avatars). */
  setTargets(targets: BasketTargetSource | null): void {
    this.targets = targets;
  }

  get count(): number {
    return this.balls.length;
  }

  /**
   * Launch a ball (local prediction or solo authority). Origin/velocity are
   * WORLD; returns the id to link a later server LAUNCH (reconciliation).
   */
  launch(origin: THREE.Vector3, velocity: THREE.Vector3, level: 1 | 2 | 3, ownerKey: string | null, serverId: number | null): number | null {
    const id = serverId ?? this.nextLocalId--;
    return this.spawn(origin, velocity, level, ownerKey, id, false) ? id : null;
  }

  /** Remote replay: the server LAUNCH of another player's ball. */
  launchRemote(origin: THREE.Vector3, velocity: THREE.Vector3, level: 1 | 2 | 3, serverId: number): void {
    this.removeById(serverId);
    this.spawn(origin, velocity, level, null, serverId, true);
  }

  private spawn(origin: THREE.Vector3, velocity: THREE.Vector3, level: 1 | 2 | 3, ownerKey: string | null, id: number, remote: boolean): boolean {
    if (!this.gltf) return false;
    const root = instantiateGoofyBasket(this.gltf, GOOFY_BALL.projectileRootScale);
    root.position.copy(origin);
    this.scene.add(root);
    this.balls.push({
      root,
      state: createBasketProjectileState(origin, velocity, level),
      id,
      ownerKey,
      spinAxis: new THREE.Vector3(1, 0, 0),
      remote,
      offset: new THREE.Vector3(),
    });
    return true;
  }

  /**
   * Server LAUNCH for OUR predicted ball: adopt the server id and snap the
   * simulation to the authoritative start (displayed offset decays).
   */
  reconcileLocal(predictedId: number, serverId: number, origin: THREE.Vector3, velocity: THREE.Vector3): void {
    const ball = this.balls.find((b) => b.id === predictedId) ?? this.balls.find((b) => b.id === serverId);
    if (!ball) return;
    ball.id = serverId;
    ball.offset.copy(ball.root.position).sub(origin);
    this.snap(ball, origin, velocity);
  }

  /** Server BOUNCE #`index` of `serverId`: snap the state after the bounce (dedup by count). */
  applyServerBounce(serverId: number, index: number, pos: THREE.Vector3, vel: THREE.Vector3, normal: THREE.Vector3): void {
    const ball = this.balls.find((b) => b.id === serverId);
    if (!ball || index <= ball.state.bounceCount) return; // duplicate / already predicted
    ball.offset.copy(ball.root.position).sub(pos);
    this.snap(ball, pos, vel);
    ball.state.bounceCount = index;
    ball.state.bouncesLeft = B.throws[ball.state.level - 1].maxWorldBounces - index;
    this.onBounce?.(pos, normal, ball.remote);
  }

  /** Server END of `serverId`: remove (duplicates are no-ops). */
  applyServerEnd(serverId: number, point: THREE.Vector3): void {
    const i = this.balls.findIndex((b) => b.id === serverId);
    if (i < 0) return;
    this.onEnd?.(point, this.balls[i].remote);
    this.remove(i);
  }

  /** True while a ball with this id (predicted or server) is displayed. */
  has(id: number): boolean {
    return this.balls.some((b) => b.id === id);
  }

  private snap(ball: FlyingBall, pos: THREE.Vector3, vel: THREE.Vector3): void {
    ball.state.pos.x = pos.x;
    ball.state.pos.y = pos.y;
    ball.state.pos.z = pos.z;
    ball.state.vel.x = vel.x;
    ball.state.vel.y = vel.y;
    ball.state.vel.z = vel.z;
  }

  private removeById(id: number): void {
    const i = this.balls.findIndex((b) => b.id === id);
    if (i >= 0) this.remove(i);
  }

  /** Drop every ball silently (death cleanup / loadout swap). */
  clear(): void {
    for (const b of this.balls) this.scene.remove(b.root);
    this.balls.length = 0;
  }

  update(dt: number): void {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      this.hitCombatants.clear();
      const events = stepBasketProjectile(ball.state, dt, this.caster, ball.ownerKey, B.projectileRadius);
      let ended = false;
      for (const ev of events) {
        if (ev.type === "bounce") {
          if (!ball.remote) {
            this.tmp.set(ev.pos.x, ev.pos.y, ev.pos.z);
            this.nrm.set(ev.normal.x, ev.normal.y, ev.normal.z);
            this.onBounce?.(this.tmp, this.nrm, false);
          }
          continue;
        }
        // Terminal event.
        if (ball.remote || this.networkAuthority) {
          // The SERVER decides the end (END confirm removes the ball): the
          // predicted ball simply stops at the contact — never a phantom
          // flight, never a local damage call.
          ball.state.vel.x = ball.state.vel.y = ball.state.vel.z = 0;
          break;
        }
        ended = true;
        if (ev.type === "hit") this.resolveLocalHit(ball, ev.targetId, ev.point);
        this.tmp.set(ev.point.x, ev.point.y, ev.point.z);
        this.onEnd?.(this.tmp, false);
        break;
      }
      if (ended) {
        this.remove(i);
        continue;
      }
      // Display: simulated position + decaying reconciliation offset; the
      // seams roll at the contact rate (cosmetic spin about the side axis).
      ball.offset.multiplyScalar(Math.exp(-12 * dt));
      ball.root.position.set(ball.state.pos.x, ball.state.pos.y, ball.state.pos.z).add(ball.offset);
      const speed = Math.hypot(ball.state.vel.x, ball.state.vel.y, ball.state.vel.z);
      if (speed > 1e-3) {
        this.tmp2.set(ball.state.vel.x, ball.state.vel.y, ball.state.vel.z);
        this.tmp.set(0, 1, 0).cross(this.tmp2);
        if (this.tmp.lengthSq() > 1e-8) ball.spinAxis.copy(this.tmp).normalize();
        ball.root.rotateOnWorldAxis(ball.spinAxis, (speed / B.projectileRadius) * dt);
      }
    }
  }

  // ------------------------------------------------------------------

  /** SOLO authority only: flat damage on the resolved combatant. */
  private resolveLocalHit(ball: FlyingBall, targetKey: string, point: BasketVec3): void {
    const target = this.hitCombatants.get(targetKey) ?? null;
    if (!target || !target.health.alive) return;
    this.tmp.set(point.x, point.y, point.z);
    const applied = target.health.applyDamage(B.damage, this.owner, KillMethod.GOOFY_BASKET, HitZone.BODY);
    if (!applied) return;
    target.registerImpact?.(
      this.tmp2.set(ball.state.vel.x, ball.state.vel.y, ball.state.vel.z).normalize().multiplyScalar(4),
      this.tmp,
    );
    this.feedback?.registerHit({
      attacker: this.owner,
      target,
      hitZone: HitZone.BODY,
      damage: B.damage,
      position: this.tmp,
      weapon: KillMethod.GOOFY_BASKET,
      isKill: !target.health.alive,
    });
  }


  /** Client-side BasketSweepCaster: Rapier world sweep + analytic combatant capsules. */
  private sweep(from: BasketVec3, dir: BasketVec3, maxDist: number, radius: number, excludeId: string | null): BasketSweepHit | null {
    let best: BasketSweepHit | null = null;
    this.origin.x = from.x;
    this.origin.y = from.y;
    this.origin.z = from.z;
    this.vel.x = dir.x * maxDist;
    this.vel.y = dir.y * maxDist;
    this.vel.z = dir.z * maxDist;
    const shape = radius === B.projectileRadius ? this.ballShape : new RAPIER.Ball(radius);
    const hit = this.physics.world.castShape(
      this.origin,
      this.identityRot,
      this.vel,
      shape,
      0, // exact contact
      1, // whole segment
      true, // starting inside → contact at 0 (pushed out by the sim clearance)
      undefined,
      WORLD_ONLY_GROUPS,
    );
    if (hit) {
      const n = hit.normal1;
      best = { distance: hit.time_of_impact * maxDist, normal: { x: n.x, y: n.y, z: n.z }, kind: "world" };
    }
    if (!this.targets) return best;
    this.targets.forEach((key, center, combatant) => {
      if (key === excludeId) return;
      if (combatant && (!combatant.health.alive || combatant.targetable === false)) return;
      const c = this.targetCenter;
      c.x = center.x;
      c.y = center.y;
      c.z = center.z;
      const headT = sweepSphereSphere(from, dir, radius, { x: c.x, y: c.y + PLAYER_HEAD_OFFSET, z: c.z }, PLAYER_HEAD_RADIUS);
      const bodyT = sweepSphereVerticalCapsule(from, dir, radius, c, PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_CAPSULE_RADIUS);
      let t: number | null = null;
      if (headT !== null) t = bodyT !== null ? Math.min(headT, bodyT) : headT;
      else if (bodyT !== null) t = bodyT;
      if (t === null || t > maxDist || (best !== null && t >= best.distance)) return;
      const px = from.x + dir.x * t;
      const py = from.y + dir.y * t;
      const pz = from.z + dir.z * t;
      const cy = Math.max(c.y - PLAYER_CAPSULE_HALF_HEIGHT, Math.min(c.y + PLAYER_CAPSULE_HALF_HEIGHT, py));
      const nx = px - c.x;
      const ny = py - cy;
      const nz = pz - c.z;
      const len = Math.hypot(nx, ny, nz) || 1;
      best = { distance: t, normal: { x: nx / len, y: ny / len, z: nz / len }, kind: "player", targetId: key };
      this.hitCombatants.set(key, combatant);
    });
    return best;
  }

  private remove(index: number): void {
    // Geometry / materials are shared with the cached GLB — never disposed.
    this.scene.remove(this.balls[index].root);
    this.balls.splice(index, 1);
  }
}
