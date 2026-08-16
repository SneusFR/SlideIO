import { NetworkPlayer } from "../schemas/NetworkPlayer";

/**
 * Spawn points mirrored from the frontend map (src/combat/SpawnManager.ts).
 * The SERVER assigns every spawn — clients only read it. Positions are
 * capsule-center coordinates on valid ground of the existing TDM map.
 */
export const MULTIPLAYER_SPAWN_POINTS: SpawnPoint[] = [
  { x: 0, y: 1.2, z: 41, yaw: 0 }, // blue yard (south)
  { x: 0, y: 1.2, z: -41, yaw: Math.PI }, // red yard (north)
  { x: -38, y: 1.2, z: 24, yaw: 0 }, // west lane
  { x: 39.5, y: 1.2, z: -25, yaw: Math.PI }, // east lane
  { x: -8, y: 1.2, z: 40, yaw: 0 },
  { x: 8, y: 1.2, z: -40, yaw: Math.PI },
  { x: 39.5, y: 1.2, z: 25, yaw: 0 },
  { x: -39.5, y: 1.2, z: -24, yaw: Math.PI },
];

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Minimal timer interface (matches the Colyseus room clock). */
interface RoomClock {
  setTimeout(callback: () => void, ms: number): { clear(): void };
}

/**
 * Server-driven respawns (Phase 4): owns the delay timers and the spawn
 * selection. The FRONTEND never decides when or where a respawn happens.
 *
 * Spawn selection: prefer the point FARTHEST from any alive player (with a
 * small random pick among the best candidates) so respawns never stack a
 * player inside another one when better options exist.
 */
export class RespawnManager {
  /** Pending respawn timers per victim (cleared on disconnect/dispose). */
  private readonly timers = new Map<string, { clear(): void }>();

  constructor(
    private readonly clock: RoomClock,
    private readonly spawnPoints: SpawnPoint[] = MULTIPLAYER_SPAWN_POINTS,
  ) {}

  /** Schedule a respawn; any previous timer for this player is replaced. */
  schedule(playerId: string, delaySeconds: number, callback: () => void): void {
    this.cancel(playerId);
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(playerId);
      callback();
    }, delaySeconds * 1000);
    this.timers.set(playerId, handle);
  }

  /** Cancel a pending respawn (player disconnected mid-death). */
  cancel(playerId: string): void {
    this.timers.get(playerId)?.clear();
    this.timers.delete(playerId);
  }

  cancelAll(): void {
    this.timers.forEach((handle) => handle.clear());
    this.timers.clear();
  }

  /**
   * Pick a respawn point away from every ALIVE player (the respawning
   * player itself is ignored). Among the top half of candidates (sorted by
   * distance to the closest enemy) one is chosen at random, so consecutive
   * respawns don't always reuse the same pad.
   */
  pickSpawn(players: Iterable<NetworkPlayer>, respawningId: string): SpawnPoint {
    const alive: NetworkPlayer[] = [];
    for (const p of players) {
      if (p.id !== respawningId && p.isAlive) alive.push(p);
    }

    if (alive.length === 0) {
      return this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
    }

    // Score = squared distance to the CLOSEST alive player (bigger = safer).
    const scored = this.spawnPoints.map((spawn) => {
      let minDistSq = Infinity;
      for (const p of alive) {
        const dx = p.x - spawn.x;
        const dz = p.z - spawn.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < minDistSq) minDistSq = distSq;
      }
      return { spawn, score: minDistSq };
    });
    scored.sort((a, b) => b.score - a.score);

    const topCount = Math.max(1, Math.ceil(scored.length / 2));
    return scored[Math.floor(Math.random() * topCount)].spawn;
  }
}