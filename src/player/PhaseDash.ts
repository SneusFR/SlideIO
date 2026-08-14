import * as THREE from "three";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { PlayerController } from "./PlayerController";
import { MovementConfig as cfg } from "./MovementConfig";

/** Result of a validated phase traversal (all checks passed). */
export interface PhaseResult {
  /** Where the player capsule center should be placed after the traversal. */
  exitPos: THREE.Vector3;
  /** World-space point where the player entered the wall (entry face). */
  entryPoint: THREE.Vector3;
  /** World-space point where the player exits the wall (far face). */
  exitPoint: THREE.Vector3;
  /** Horizontal travel direction through the wall (normalized). */
  travelDir: THREE.Vector3;
  /** Measured wall thickness along the travel direction (m). */
  thickness: number;
}

/** Debug snapshot of the latest phase attempt (for the dev HUD). */
export interface PhaseAttemptDebug {
  wallPhaseable: boolean;
  exitClear: boolean;
  wallThickness: number;
}

/**
 * Phase Dash traversal validation.
 *
 * Given a wall contact that happened during a dash (or its grace window),
 * this decides whether the player may pass through and computes a safe
 * exit position on the far side.
 *
 * IMPORTANT: player speed is NEVER part of the decision. Authorization
 * depends only on: dash state (checked by the caller), the wall being
 * explicitly marked `phaseable`, and a valid, clear exit point.
 */
export class PhaseDash {
  /** Debug info about the most recent attempt (consumed by the HUD). */
  readonly lastAttempt: PhaseAttemptDebug = {
    wallPhaseable: false,
    exitClear: false,
    wallThickness: 0,
  };

  private readonly result: PhaseResult = {
    exitPos: new THREE.Vector3(),
    entryPoint: new THREE.Vector3(),
    exitPoint: new THREE.Vector3(),
    travelDir: new THREE.Vector3(),
    thickness: 0,
  };

  private readonly dir = new THREE.Vector3();

  constructor(
    private physics: PhysicsWorld,
    private player: PlayerController,
  ) {}

  /**
   * Validate a traversal through `wallCollider`.
   * `wallNormal` points from the wall toward the player (already
   * horizontal-normalized by the caller and confirmed near-vertical).
   * Returns a PhaseResult when every safety check passes, else null.
   */
  tryPhase(
    wallCollider: RAPIER_API.Collider,
    playerPos: THREE.Vector3,
    wallNormal: THREE.Vector3,
  ): PhaseResult | null {
    this.lastAttempt.wallPhaseable = false;
    this.lastAttempt.exitClear = false;
    this.lastAttempt.wallThickness = 0;

    if (!cfg.phaseTraversalEnabled) return null;

    // 1) The wall must be explicitly marked as phaseable — outer map
    //    borders and regular geometry stay fully solid, even mid-dash.
    if (!this.physics.isPhaseable(wallCollider)) return null;
    this.lastAttempt.wallPhaseable = true;

    // Travel direction: straight through the wall, horizontal only.
    const d = this.dir.copy(wallNormal).negate();
    d.y = 0;
    if (d.lengthSq() < 0.0001) return null;
    d.normalize();

    const maxT = cfg.maxPhaseWallThickness;

    // 2) Entry face: ray from the player's center toward the wall.
    const entryRay = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: d.x, y: d.y, z: d.z },
    );
    const tEntry = wallCollider.castRay(entryRay, cfg.capsuleRadius + maxT + 1, true);
    if (tEntry < 0) return null;
    this.result.entryPoint
      .copy(playerPos)
      .addScaledVector(d, tEntry);

    // 3) Far face: ray cast back toward the wall from beyond the max
    //    allowed thickness. If that origin is *inside* the wall, the ray
    //    reports toi = 0 → measured thickness exceeds the max → solid.
    const probe = maxT + 0.02;
    const backOrigin = {
      x: this.result.entryPoint.x + d.x * probe,
      y: this.result.entryPoint.y + d.y * probe,
      z: this.result.entryPoint.z + d.z * probe,
    };
    const backRay = new RAPIER.Ray(backOrigin, { x: -d.x, y: -d.y, z: -d.z });
    const tBack = wallCollider.castRay(backRay, probe + 0.02, true);
    if (tBack < 0) return null;

    const thickness = probe - tBack;
    this.lastAttempt.wallThickness = thickness;
    if (thickness <= 0 || thickness > maxT) return null;

    this.result.exitPoint
      .copy(this.result.entryPoint)
      .addScaledVector(d, thickness);

    // 4) Candidate exit position: capsule center just past the far face,
    //    same height as the player (position changes, velocity does not).
    this.result.exitPos
      .copy(this.result.exitPoint)
      .addScaledVector(d, cfg.capsuleRadius + cfg.phaseExitOffset);
    this.result.exitPos.y = playerPos.y;

    // 5) The full capsule must fit at the exit: reject exits inside other
    //    colliders, solid geometry or too-tight gaps.
    const halfHeight = this.player.crouched ? cfg.slideHalfHeight : cfg.standHalfHeight;
    const shape = new RAPIER.Capsule(halfHeight, cfg.capsuleRadius - 0.02);
    const blocked = this.physics.world.intersectionWithShape(
      { x: this.result.exitPos.x, y: this.result.exitPos.y, z: this.result.exitPos.z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
    );
    if (blocked !== null) return null;

    // 6) Never phase out of the map / into the void: there must be some
    //    geometry underneath the exit point (any distance down to 100 m).
    const downRay = new RAPIER.Ray(
      { x: this.result.exitPos.x, y: this.result.exitPos.y, z: this.result.exitPos.z },
      { x: 0, y: -1, z: 0 },
    );
    const groundBelow = this.physics.world.castRay(
      downRay,
      100,
      true,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
    );
    if (groundBelow === null) return null;

    this.lastAttempt.exitClear = true;
    this.result.travelDir.copy(d);
    this.result.thickness = thickness;
    return this.result;
  }
}