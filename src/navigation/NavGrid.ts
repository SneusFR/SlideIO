import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";

/**
 * Grid-based navigation built automatically from the physics world at
 * startup: each cell is tested with a capsule overlap + ground raycast.
 * Robust against any box layout (doors, lanes, interiors) with zero manual
 * waypoint authoring. A* + LOS smoothing produce clean paths.
 *
 * IMPORTANT: build BEFORE creating character capsules (player/bots), so
 * only static geometry blocks cells.
 */
export class NavGrid {
  private static readonly CELL = 1.5;
  // Ancient Jungle City playable area (perimeter walls at ±60).
  private static readonly MIN_X = -58;
  private static readonly MAX_X = 58;
  private static readonly MIN_Z = -58;
  private static readonly MAX_Z = 58;
  /** Highest walkable floor (Sun Gate / East Ridge = +3 m). */
  private static readonly MAX_FLOOR_Y = 3.6;
  /** Lowest walkable floor (Lower Court = −1.5 m). */
  private static readonly MIN_FLOOR_Y = -2.0;
  /** Max ground-height difference between adjacent cells (ramps ≈ 0.38 m
   *  per cell at 14°; autostep 0.25 m — anything bigger is a ledge). */
  private static readonly MAX_STEP_Y = 0.8;

  private readonly nx: number;
  private readonly nz: number;
  private readonly walkable: Uint8Array;
  /** Ground height (m) per walkable cell — floors span −1.5 … +3 m. */
  private readonly groundY: Float32Array;

  // A* scratch buffers (persistent — no per-call allocation of big arrays)
  private readonly gScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly state: Uint8Array; // 0 untouched, 1 open, 2 closed
  private readonly open: number[] = [];

  constructor(private physics: PhysicsWorld) {
    this.nx = Math.floor((NavGrid.MAX_X - NavGrid.MIN_X) / NavGrid.CELL) + 1;
    this.nz = Math.floor((NavGrid.MAX_Z - NavGrid.MIN_Z) / NavGrid.CELL) + 1;
    const n = this.nx * this.nz;
    this.walkable = new Uint8Array(n);
    this.groundY = new Float32Array(n);
    this.gScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.state = new Uint8Array(n);
    this.build();
  }

  private build(): void {
    const capsule = new RAPIER.Capsule(0.5, 0.3);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const down = { x: 0, y: -1, z: 0 };
    // Ray origin above the highest walkable floor; long enough to reach
    // the Lower Court (−1.5 m).
    const rayOriginY = NavGrid.MAX_FLOOR_Y + 3;
    const rayLength = rayOriginY - NavGrid.MIN_FLOOR_Y + 0.5;

    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = NavGrid.MIN_X + i * NavGrid.CELL;
        const z = NavGrid.MIN_Z + j * NavGrid.CELL;

        // Must have ground below (first surface from above)…
        const ground = this.physics.world.castRay(
          new RAPIER.Ray({ x, y: rayOriginY, z }, down),
          rayLength,
          true,
        );
        if (!ground) continue;
        const gy = rayOriginY - ground.timeOfImpact;
        // …at a real FLOOR height (tops of walls/covers are not walkable)…
        if (gy > NavGrid.MAX_FLOOR_Y || gy < NavGrid.MIN_FLOOR_Y) continue;

        // …and room for a (slightly slim) standing capsule above it.
        const blocked = this.physics.world.intersectionWithShape(
          { x, y: gy + 0.98, z },
          rot,
          capsule,
        );
        if (!blocked) {
          const id = j * this.nx + i;
          this.walkable[id] = 1;
          this.groundY[id] = gy;
        }
      }
    }
  }

  private idx(i: number, j: number): number {
    return j * this.nx + i;
  }

  private cellX(i: number): number {
    return NavGrid.MIN_X + i * NavGrid.CELL;
  }

  private cellZ(j: number): number {
    return NavGrid.MIN_Z + j * NavGrid.CELL;
  }

  /** Nearest walkable cell index for a world position, or -1. */
  private nearestCell(x: number, z: number): number {
    const ci = Math.round((x - NavGrid.MIN_X) / NavGrid.CELL);
    const cj = Math.round((z - NavGrid.MIN_Z) / NavGrid.CELL);
    for (let r = 0; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
          if (this.walkable[this.idx(i, j)]) return this.idx(i, j);
        }
      }
    }
    return -1;
  }

  /** Random walkable point in the main arena, at least `minDist` from `from`. */
  pickRoamGoal(from: THREE.Vector3, minDist: number, out: THREE.Vector3): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const i = Math.floor(Math.random() * this.nx);
      const j = Math.floor(Math.random() * this.nz);
      const id = this.idx(i, j);
      if (!this.walkable[id]) continue;
      const x = this.cellX(i);
      const z = this.cellZ(j);
      if (Math.hypot(x - from.x, z - from.z) < minDist) continue;
      out.set(x, this.groundY[id] + 1, z);
      return true;
    }
    return false;
  }

  /**
   * A* from `from` to `to`. Fills `outPath` (reusing its Vector3s) and
   * returns the number of waypoints (0 = no path).
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, outPath: THREE.Vector3[]): number {
    const start = this.nearestCell(from.x, from.z);
    const goal = this.nearestCell(to.x, to.z);
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      if (!outPath[0]) outPath[0] = new THREE.Vector3();
      outPath[0].set(to.x, this.groundY[goal] + 1, to.z);
      return 1;
    }

    this.state.fill(0);
    this.gScore[start] = 0;
    this.cameFrom[start] = -1;
    this.state[start] = 1;
    this.open.length = 0;
    this.open.push(start);

    const gi = goal % this.nx;
    const gj = Math.floor(goal / this.nx);
    let found = false;
    let iterations = 0;

    while (this.open.length > 0 && iterations < 20000) {
      iterations++;
      // Extract cheapest (linear scan is fine at this scale).
      let best = 0;
      let bestF = Infinity;
      for (let k = 0; k < this.open.length; k++) {
        const id = this.open[k];
        const ii = id % this.nx;
        const jj = Math.floor(id / this.nx);
        const f = this.gScore[id] + Math.hypot(ii - gi, jj - gj);
        if (f < bestF) {
          bestF = f;
          best = k;
        }
      }
      const current = this.open[best];
      this.open[best] = this.open[this.open.length - 1];
      this.open.pop();
      if (current === goal) {
        found = true;
        break;
      }
      this.state[current] = 2;

      const ci = current % this.nx;
      const cj = Math.floor(current / this.nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
          const nid = this.idx(ni, nj);
          if (!this.walkable[nid] || this.state[nid] === 2) continue;
          // Ledges: adjacent floors further apart than a ramp step are
          // NOT connected (e.g. East Ridge +3 m over Central Crossing 0 m).
          if (
            Math.abs(this.groundY[nid] - this.groundY[current]) >
            NavGrid.MAX_STEP_Y
          ) {
            continue;
          }
          // Diagonals need both orthogonal neighbors free (no corner cutting).
          if (di !== 0 && dj !== 0) {
            if (!this.walkable[this.idx(ci + di, cj)]) continue;
            if (!this.walkable[this.idx(ci, cj + dj)]) continue;
          }
          const cost = this.gScore[current] + (di !== 0 && dj !== 0 ? 1.4142 : 1);
          if (this.state[nid] === 1 && cost >= this.gScore[nid]) continue;
          this.gScore[nid] = cost;
          this.cameFrom[nid] = current;
          if (this.state[nid] !== 1) {
            this.state[nid] = 1;
            this.open.push(nid);
          }
        }
      }
    }

    if (!found) return 0;

    // Reconstruct (reversed), then write forward into outPath.
    const chain: number[] = [];
    let node = goal;
    while (node !== -1 && chain.length < 4000) {
      chain.push(node);
      node = this.cameFrom[node];
    }
    chain.reverse();

    // LOS smoothing: greedily jump to the furthest visible cell.
    let count = 0;
    let anchor = 0;
    this.setPathPoint(outPath, count++, chain[0]);
    while (anchor < chain.length - 1) {
      let next = anchor + 1;
      // Try to jump ahead (test every 2nd cell, capped raycasts).
      for (let probe = chain.length - 1; probe > anchor + 1; probe -= 2) {
        if (this.segmentClear(chain[anchor], chain[probe])) {
          next = probe;
          break;
        }
      }
      this.setPathPoint(outPath, count++, chain[next]);
      anchor = next;
      if (count >= 64) break; // safety cap
    }
    // Snap final waypoint to the exact requested destination.
    outPath[count - 1].set(to.x, this.groundY[goal] + 1, to.z);
    return count;
  }

  private chainX(id: number): number {
    return this.cellX(id % this.nx);
  }

  private chainZ(id: number): number {
    return this.cellZ(Math.floor(id / this.nx));
  }

  /** Waypoint at a cell: XZ center, Y = local ground + 1 (capsule-ish). */
  private setPathPoint(path: THREE.Vector3[], index: number, cellId: number): void {
    if (!path[index]) path[index] = new THREE.Vector3();
    path[index].set(this.chainX(cellId), this.groundY[cellId] + 1, this.chainZ(cellId));
  }

  /** Capsule-ish LOS between two cells (4 rays: low, high, lateral). */
  private segmentClear(a: number, b: number): boolean {
    // Never smooth across an elevation change: horizontal rays would skim
    // the ramp surface and produce false negatives/positives. The A* path
    // already walks ramps cell by cell.
    if (Math.abs(this.groundY[a] - this.groundY[b]) > 0.3) return false;
    const baseY = Math.max(this.groundY[a], this.groundY[b]);
    const ax = this.chainX(a);
    const az = this.chainZ(a);
    const bx = this.chainX(b);
    const bz = this.chainZ(b);
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.01) return true;
    const inv = 1 / dist;
    const dirx = dx * inv;
    const dirz = dz * inv;
    // Perpendicular offset for width clearance.
    const px = -dirz * 0.35;
    const pz = dirx * 0.35;

    return (
      this.rayClear(ax, baseY + 0.35, az, dirx, dirz, dist) &&
      this.rayClear(ax, baseY + 1.35, az, dirx, dirz, dist) &&
      this.rayClear(ax + px, baseY + 0.85, az + pz, dirx, dirz, dist) &&
      this.rayClear(ax - px, baseY + 0.85, az - pz, dirx, dirz, dist)
    );
  }

  private rayClear(
    x: number,
    y: number,
    z: number,
    dirx: number,
    dirz: number,
    dist: number,
  ): boolean {
    // Only static geometry blocks paths — character capsules (kinematic)
    // must not break LOS smoothing at runtime.
    const hit = this.physics.world.castRay(
      new RAPIER.Ray({ x, y, z }, { x: dirx, y: 0, z: dirz }),
      dist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    return hit === null;
  }
}