import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { Combatant } from "./Combatant";
import { CombatConfig as cc } from "./CombatConfig";

export interface SpawnPoint {
  pos: THREE.Vector3;
  yaw: number;
}

/**
 * FFA spawn points spread across the whole map + simple scoring:
 * prefer spawns far from other combatants and out of immediate line of
 * sight, then pick semi-randomly among the best candidates.
 */
export class SpawnManager {
  private readonly spawns: SpawnPoint[] = [];
  private readonly scored: { spawn: SpawnPoint; score: number }[] = [];
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(private physics: PhysicsWorld) {
    const add = (x: number, z: number, yaw: number) => {
      this.spawns.push({ pos: new THREE.Vector3(x, 1.2, z), yaw });
    };

    // Blue yard (south)
    add(0, 41, 0);
    add(-8, 40, 0);
    add(8, 41, 0);
    // Red yard (north)
    add(0, -41, Math.PI);
    add(-8, -41, Math.PI);
    add(8, -40, Math.PI);
    // West lane
    add(-38, 24, 0);
    add(-39.5, 8, 0);
    add(-39.5, -24, Math.PI);
    // East lane
    add(39.5, 25, 0);
    add(39.5, 8, Math.PI);
    add(39, -25, Math.PI);
    // Interiors
    add(-18, 32, 0); // blue house
    add(18, -32, Math.PI); // red house
    add(-31, -2.5, -Math.PI / 2); // mid shop
    add(17.5, 31, 0); // blue garage
    add(-17.5, -31, Math.PI); // red garage
    // Street / center
    add(2, 14, 0);
    add(-2, -14, Math.PI);
    add(32, 5.5, Math.PI / 2); // near container
  }

  /**
   * Pick a good spawn for `self`: far from everyone alive, ideally out of
   * line of sight, semi-random among the top candidates.
   */
  pickSpawn(combatants: Combatant[], self: Combatant | null): SpawnPoint {
    this.scored.length = 0;

    for (const spawn of this.spawns) {
      let minDist = Infinity;
      let nearest: Combatant | null = null;

      for (const c of combatants) {
        if (c === self || !c.health.alive) continue;
        c.getPosition(this.tmpA);
        const d = this.tmpA.distanceTo(spawn.pos);
        if (d < minDist) {
          minDist = d;
          nearest = c;
        }
      }

      let score = Math.min(minDist, 45) + Math.random() * 4;
      if (minDist < cc.spawnMinComfortDistance) score *= 0.1;
      // LOS check only against the nearest enemy (cheap, once per respawn).
      if (nearest && minDist < 40 && this.hasLineOfSight(spawn, nearest)) {
        score *= cc.spawnLosPenalty;
      }
      this.scored.push({ spawn, score });
    }

    this.scored.sort((a, b) => b.score - a.score);
    const top = Math.min(cc.spawnTopChoices, this.scored.length);
    return this.scored[Math.floor(Math.random() * top)].spawn;
  }

  private hasLineOfSight(spawn: SpawnPoint, enemy: Combatant): boolean {
    const eyeY = spawn.pos.y + 0.6;
    enemy.getEyePosition(this.tmpB);
    const dx = this.tmpB.x - spawn.pos.x;
    const dy = this.tmpB.y - eyeY;
    const dz = this.tmpB.z - spawn.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.001) return true;
    const inv = 1 / dist;
    // Walls only: character capsules (kinematic) never block spawn LOS.
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(
        { x: spawn.pos.x, y: eyeY, z: spawn.pos.z },
        { x: dx * inv, y: dy * inv, z: dz * inv },
      ),
      Math.max(dist - 0.9, 0.1),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    return hit === null; // no wall in between → visible
  }
}