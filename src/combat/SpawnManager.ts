import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { Combatant } from "./Combatant";
import { CombatConfig as cc } from "./CombatConfig";
import { MAP_SPAWN_POINTS, type MapSpawnPoint } from "../../shared/map/MapSpawns";

export interface SpawnPoint {
  pos: THREE.Vector3;
  yaw: number;
}

/**
 * FFA spawn points (the 8 validated spawns of the CURRENT map, shared
 * with the backend via shared/map/*Spawns.ts) + simple scoring:
 * prefer spawns far from other combatants and out of immediate line of
 * sight, then pick semi-randomly among the best candidates.
 */
export class SpawnManager {
  private readonly spawns: SpawnPoint[] = [];
  private readonly scored: { spawn: SpawnPoint; score: number }[] = [];
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(
    private physics: PhysicsWorld,
    spawnPoints: MapSpawnPoint[] = MAP_SPAWN_POINTS,
  ) {
    // Capsule-center positions verified against the map export — the
    // small extra Y margin lets the ground snap settle the capsule.
    for (const s of spawnPoints) {
      this.spawns.push({ pos: new THREE.Vector3(s.x, s.y + 0.3, s.z), yaw: s.yaw });
    }
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