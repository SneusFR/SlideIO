import * as THREE from "three";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import { PhysicsWorld, RAPIER, CollisionGroups } from "../physics/PhysicsWorld";
import { MovementConfig as cfg } from "./MovementConfig";

/**
 * Owns the player's physical representation:
 * kinematic rigid body + capsule collider + Rapier character controller.
 * All velocity/state logic lives in PlayerMovement.
 */
export class PlayerController {
  readonly body: RAPIER_API.RigidBody;
  readonly collider: RAPIER_API.Collider;
  readonly controller: RAPIER_API.KinematicCharacterController;

  /** True while the capsule uses the reduced slide height. */
  crouched = false;

  readonly physics: PhysicsWorld;
  /** PERF: Rapier targets (no vector allocated per call) — read at once, never kept. */
  private readonly rPos = { x: 0, y: 0, z: 0 };
  private readonly rMove = { x: 0, y: 0, z: 0 };
  private readonly rNext = { x: 0, y: 0, z: 0 };

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
    const world = physics.world;

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      cfg.spawnPosition.x,
      cfg.spawnPosition.y,
      cfg.spawnPosition.z,
    );
    this.body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.capsule(cfg.standHalfHeight, cfg.capsuleRadius)
      .setFriction(0)
      .setRestitution(0)
      // CHARACTER group: ragdolls/corpses explicitly ignore capsules —
      // dead bodies never block the player, and vice versa.
      .setCollisionGroups(CollisionGroups.CHARACTER);
    this.collider = world.createCollider(colliderDesc, this.body);

    this.controller = world.createCharacterController(0.06);
    this.controller.enableAutostep(0.45, 0.25, true);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((80 * Math.PI) / 180);
    this.controller.setSlideEnabled(true);
  }

  getPosition(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation(this.rPos);
    return out.set(t.x, t.y, t.z);
  }

  setPosition(x: number, y: number, z: number): void {
    this.body.setTranslation({ x, y, z }, true);
  }

  /**
   * Teleport applied on the next physics step (phase dash traversal).
   * Must be used instead of setPosition when called after move() in the
   * same frame — otherwise the pending kinematic translation wins.
   */
  setNextPosition(x: number, y: number, z: number): void {
    this.body.setNextKinematicTranslation({ x, y, z });
  }

  /**
   * Move by `delta`, resolved against the world by the character controller.
   * Returns the corrected movement actually applied.
   */
  move(delta: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.controller.computeColliderMovement(this.collider, delta);
    const corrected = this.controller.computedMovement(this.rMove);
    const t = this.body.translation(this.rPos);
    const next = this.rNext;
    next.x = t.x + corrected.x;
    next.y = t.y + corrected.y;
    next.z = t.z + corrected.z;
    this.body.setNextKinematicTranslation(next);
    return out.set(corrected.x, corrected.y, corrected.z);
  }

  isGrounded(): boolean {
    return this.controller.computedGrounded();
  }

  /** Swap the capsule between standing and sliding heights. */
  setCrouched(crouched: boolean): void {
    if (crouched === this.crouched) return;
    const diff = cfg.standHalfHeight - cfg.slideHalfHeight;
    if (crouched) {
      // Shrink around the center; gravity + ground snap settle it down.
      this.collider.setShape(new RAPIER.Capsule(cfg.slideHalfHeight, cfg.capsuleRadius));
    } else {
      // Grow back and lift the center so the feet stay planted.
      this.collider.setShape(new RAPIER.Capsule(cfg.standHalfHeight, cfg.capsuleRadius));
      const t = this.body.translation();
      this.body.setTranslation({ x: t.x, y: t.y + diff, z: t.z }, true);
    }
    this.crouched = crouched;
  }

  /** True if there is room above to stand back up from a slide. */
  canStandUp(): boolean {
    if (!this.crouched) return true;
    const t = this.body.translation();
    const diff = cfg.standHalfHeight - cfg.slideHalfHeight;
    const shape = new RAPIER.Capsule(cfg.standHalfHeight, cfg.capsuleRadius - 0.02);
    const hit = this.physics.world.intersectionWithShape(
      { x: t.x, y: t.y + diff, z: t.z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      undefined,
      undefined,
      this.collider,
      this.body,
    );
    return hit === null;
  }

  respawn(pos?: { x: number; y: number; z: number }): void {
    this.setCrouched(false);
    const p = pos ?? cfg.spawnPosition;
    this.setPosition(p.x, p.y, p.z);
  }
}