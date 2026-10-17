import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";

/**
 * Grid-based navigation built automatically from the physics world at
 * startup: each cell is tested with a capsule overlap + ground raycast.
 * Robust against any box layout (doors, lanes, interiors) with zero manual
 * waypoint authoring. A* + LOS smoothing produce clean paths.
 *
 * PERFORMANCE (8 bots must never stall a frame):
 *  - connected REGIONS are labelled once at build time with the exact A*
 *    neighbour rules: a request whose start and goal live in different
 *    regions (rooftops, closed pockets: 6-7 % of the walkable cells) is
 *    answered INSTANTLY instead of flooding the whole map (was 80-180 ms);
 *  - the open set is a binary heap (was a full linear scan per expansion);
 *  - per-call buffers are reset with a generation stamp (no `fill`);
 *  - LOS smoothing probes a bounded window ahead of the anchor.
 *
 * IMPORTANT: build BEFORE creating character capsules (player/bots), so
 * only static geometry blocks cells.
 */
export interface NavGridBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Highest walkable floor (tops of walls/covers are not walkable). */
  maxFloorY: number;
  /** Lowest walkable floor. */
  minFloorY: number;
}

/** Ancient Jungle City playable area (perimeter walls at ±60,
 *  Sun Gate / East Ridge +3 m, Lower Court −1.5 m). */
export const JUNGLE_NAV_BOUNDS: NavGridBounds = {
  minX: -58,
  maxX: 58,
  minZ: -58,
  maxZ: 58,
  maxFloorY: 3.6,
  minFloorY: -2.0,
};

/** YARD 01 main arena (retaining walls at ±56, upper slabs +4.8 m).
 *  The west acid wing (x < −57) is deliberately EXCLUDED: bots never
 *  roam the parkour route or the pool. */
export const YARD_NAV_BOUNDS: NavGridBounds = {
  minX: -54,
  maxX: 54,
  minZ: -58,
  maxZ: 106,
  maxFloorY: 5.4,
  minFloorY: -0.5,
};

/** GIVRE 01 (280 × 220 m: X ∈ [−140, 140], Z ∈ [−140, 80], perimeter
 *  buildings on the border, North gallery at +6 m). maxFloorY 6.05 keeps
 *  the gallery (6.0 m) walkable but excludes the roof of the covered south
 *  link (6.1 m); the low roofs P1/Q1 (4 m) are excluded by their player
 *  clips (the ground ray starts inside them). */
export const GIVRE_NAV_BOUNDS: NavGridBounds = {
  minX: -138,
  maxX: 138,
  minZ: -138,
  maxZ: 78,
  maxFloorY: 6.05,
  minFloorY: -0.5,
};

export class NavGrid {
  private static readonly CELL = 1.5;
  /** Max ground-height difference between adjacent cells (Jungle ramps
   *  ≈ 0.38 m/cell at 14°, Yard ramps ≈ 0.56 m/cell at 20.6°; autostep
   *  0.25 m — anything bigger is a ledge). */
  private static readonly MAX_STEP_Y = 0.8;
  /** Hard cap on A* expansions (a pathological request can never run away). */
  private static readonly MAX_EXPANSIONS = 20000;
  /** LOS smoothing looks at most this many chain cells ahead of the anchor. */
  private static readonly SMOOTH_WINDOW = 24;
  /** Max waypoints written per path (safety cap). */
  private static readonly MAX_WAYPOINTS = 64;

  private readonly bounds: NavGridBounds;
  private readonly nx: number;
  private readonly nz: number;
  private readonly walkable: Uint8Array;
  /** Ground height (m) per walkable cell — floors span −1.5 … +3 m. */
  private readonly groundY: Float32Array;

  // A* scratch buffers (persistent — no per-call allocation of big arrays)
  private readonly gScore: Float32Array;
  private readonly cameFrom: Int32Array;
  /** Generation stamp per cell: a cell is "touched" only when it matches `gen`. */
  private readonly stamp: Uint32Array;
  /** Closed flag, valid only while `stamp[id] === gen`. */
  private readonly closed: Uint8Array;
  private gen = 0;
  /** Binary min-heap of cell ids keyed by fScore (lazy deletion). */
  private readonly heap: Int32Array;
  private readonly heapF: Float32Array;
  private heapSize = 0;
  /** Reversed A* chain scratch (cell ids). */
  private readonly chain: Int32Array;
  /** Connected-region id per walkable cell (-1 = not walkable). */
  private readonly region: Int32Array;
  /** Reused query ray (castRay is synchronous). */
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });

  constructor(
    private physics: PhysicsWorld,
    bounds: NavGridBounds = JUNGLE_NAV_BOUNDS,
  ) {
    this.bounds = bounds;
    this.nx = Math.floor((bounds.maxX - bounds.minX) / NavGrid.CELL) + 1;
    this.nz = Math.floor((bounds.maxZ - bounds.minZ) / NavGrid.CELL) + 1;
    const n = this.nx * this.nz;
    this.walkable = new Uint8Array(n);
    this.groundY = new Float32Array(n);
    this.gScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint8Array(n);
    // Each cell enters the heap at most 8 times (once per improving neighbour).
    this.heap = new Int32Array(n * 8 + 8);
    this.heapF = new Float32Array(n * 8 + 8);
    this.chain = new Int32Array(n);
    this.region = new Int32Array(n).fill(-1);
    this.build();
    this.labelRegions();
  }

  private build(): void {
    const capsule = new RAPIER.Capsule(0.5, 0.3);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const down = { x: 0, y: -1, z: 0 };
    // Ray origin above the highest walkable floor; long enough to reach
    // the lowest one.
    const rayOriginY = this.bounds.maxFloorY + 3;
    const rayLength = rayOriginY - this.bounds.minFloorY + 0.5;

    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.bounds.minX + i * NavGrid.CELL;
        const z = this.bounds.minZ + j * NavGrid.CELL;

        // Must have ground below (first surface from above)…
        const ground = this.physics.world.castRay(
          new RAPIER.Ray({ x, y: rayOriginY, z }, down),
          rayLength,
          true,
        );
        if (!ground) continue;
        const gy = rayOriginY - ground.timeOfImpact;
        // …at a real FLOOR height (tops of walls/covers are not walkable)…
        if (gy > this.bounds.maxFloorY || gy < this.bounds.minFloorY) continue;

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

  /**
   * Flood-fill the walkable cells into connected regions using EXACTLY the
   * A* neighbour rules (step height + no corner cutting), so "same region"
   * means "A* can find a path" - never a false negative.
   */
  private labelRegions(): void {
    const n = this.nx * this.nz;
    const stack = new Int32Array(n);
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (!this.walkable[s] || this.region[s] >= 0) continue;
      const id = next++;
      let top = 0;
      stack[top++] = s;
      this.region[s] = id;
      while (top > 0) {
        const cur = stack[--top];
        const ci = cur % this.nx;
        const cj = (cur - ci) / this.nx;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const nid = this.neighbour(cur, ci, cj, di, dj);
            if (nid < 0 || this.region[nid] >= 0) continue;
            this.region[nid] = id;
            stack[top++] = nid;
          }
        }
      }
    }
  }

  /**
   * Neighbour cell reachable from `cur` in direction (di, dj), or -1: in
   * bounds, walkable, within the step height, and a diagonal never cuts a
   * corner (both orthogonal neighbours walkable). Shared by A* and the
   * region labelling so both always agree.
   */
  private neighbour(cur: number, ci: number, cj: number, di: number, dj: number): number {
    const ni = ci + di;
    const nj = cj + dj;
    if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) return -1;
    const nid = nj * this.nx + ni;
    if (!this.walkable[nid]) return -1;
    // Ledges: adjacent floors further apart than a ramp step are NOT
    // connected (e.g. East Ridge +3 m over Central Crossing 0 m).
    if (Math.abs(this.groundY[nid] - this.groundY[cur]) > NavGrid.MAX_STEP_Y) return -1;
    if (di !== 0 && dj !== 0) {
      if (!this.walkable[cj * this.nx + ni]) return -1;
      if (!this.walkable[nj * this.nx + ci]) return -1;
    }
    return nid;
  }

  private idx(i: number, j: number): number {
    return j * this.nx + i;
  }

  private cellX(i: number): number {
    return this.bounds.minX + i * NavGrid.CELL;
  }

  private cellZ(j: number): number {
    return this.bounds.minZ + j * NavGrid.CELL;
  }

  /** Nearest walkable cell index for a world position, or -1. */
  private nearestCell(x: number, z: number): number {
    const ci = Math.round((x - this.bounds.minX) / NavGrid.CELL);
    const cj = Math.round((z - this.bounds.minZ) / NavGrid.CELL);
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

  /**
   * Random walkable point at least `minDist` from `from`, guaranteed to be
   * REACHABLE (same connected region as `from`: never a closed pocket or a
   * rooftop the A* would have to flood the whole map to reject).
   */
  pickRoamGoal(from: THREE.Vector3, minDist: number, out: THREE.Vector3): boolean {
    const start = this.nearestCell(from.x, from.z);
    const startRegion = start >= 0 ? this.region[start] : -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const i = Math.floor(Math.random() * this.nx);
      const j = Math.floor(Math.random() * this.nz);
      const id = this.idx(i, j);
      if (!this.walkable[id]) continue;
      if (startRegion >= 0 && this.region[id] !== startRegion) continue;
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
    // Different connected regions: A* would flood the whole region for
    // nothing (80-180 ms measured) - answered in O(1) instead.
    if (this.region[start] !== this.region[goal]) return 0;
    if (start === goal) {
      if (!outPath[0]) outPath[0] = new THREE.Vector3();
      outPath[0].set(to.x, this.groundY[goal] + 1, to.z);
      return 1;
    }

    // New generation: every cell whose stamp differs is "untouched" - no
    // full-array reset per call.
    this.gen = (this.gen + 1) >>> 0;
    if (this.gen === 0) {
      this.stamp.fill(0); // wrap-around (once every 4 billion calls)
      this.gen = 1;
    }
    const gen = this.gen;
    const nx = this.nx;
    const gi = goal % nx;
    const gj = (goal - gi) / nx;
    const si = start % nx;

    this.stamp[start] = gen;
    this.closed[start] = 0;
    this.gScore[start] = 0;
    this.cameFrom[start] = -1;
    this.heapSize = 0;
    this.heapPush(start, octile(si - gi, (start - si) / nx - gj));

    let found = false;
    let expansions = 0;
    while (this.heapSize > 0 && expansions < NavGrid.MAX_EXPANSIONS) {
      const current = this.heapPop();
      if (this.closed[current]) continue; // stale heap entry (lazy deletion)
      if (current === goal) {
        found = true;
        break;
      }
      this.closed[current] = 1;
      expansions++;

      const ci = current % nx;
      const cj = (current - ci) / nx;
      const g = this.gScore[current];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const nid = this.neighbour(current, ci, cj, di, dj);
          if (nid < 0) continue;
          const fresh = this.stamp[nid] !== gen;
          if (!fresh && this.closed[nid]) continue;
          const cost = g + (di !== 0 && dj !== 0 ? 1.4142 : 1);
          if (!fresh && cost >= this.gScore[nid]) continue;
          if (fresh) {
            this.stamp[nid] = gen;
            this.closed[nid] = 0;
          }
          this.gScore[nid] = cost;
          this.cameFrom[nid] = current;
          this.heapPush(nid, cost + octile(ci + di - gi, cj + dj - gj));
        }
      }
    }

    if (!found) return 0;

    // Reconstruct into the scratch (goal first), then walk it forward.
    let len = 0;
    let node = goal;
    while (node !== -1 && len < this.chain.length) {
      this.chain[len++] = node;
      node = this.cameFrom[node];
    }
    const chain = this.chain;
    const at = (k: number): number => chain[len - 1 - k];

    // LOS smoothing: greedily jump to the furthest visible cell inside a
    // bounded window (constant raycast budget, even on the 280 m Givre map).
    let count = 0;
    let anchor = 0;
    this.setPathPoint(outPath, count++, at(0));
    while (anchor < len - 1) {
      let next = anchor + 1;
      const far = Math.min(len - 1, anchor + NavGrid.SMOOTH_WINDOW);
      for (let probe = far; probe > anchor + 1; probe -= 2) {
        if (this.segmentClear(at(anchor), at(probe))) {
          next = probe;
          break;
        }
      }
      this.setPathPoint(outPath, count++, at(next));
      anchor = next;
      if (count >= NavGrid.MAX_WAYPOINTS) break; // safety cap
    }
    // Snap final waypoint to the exact requested destination.
    outPath[count - 1].set(to.x, this.groundY[goal] + 1, to.z);
    return count;
  }

  /** True when `to` can be reached from `from` (same connected region) - O(1). */
  isReachable(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const a = this.nearestCell(from.x, from.z);
    const b = this.nearestCell(to.x, to.z);
    return a >= 0 && b >= 0 && this.region[a] === this.region[b];
  }

  private heapPush(id: number, f: number): void {
    const heap = this.heap;
    const hf = this.heapF;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      heap[i] = heap[p];
      hf[i] = hf[p];
      i = p;
    }
    heap[i] = id;
    hf[i] = f;
  }

  private heapPop(): number {
    const heap = this.heap;
    const hf = this.heapF;
    const top = heap[0];
    const n = --this.heapSize;
    if (n > 0) {
      const id = heap[n];
      const f = hf[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && hf[r] < hf[l] ? r : l;
        if (hf[c] >= f) break;
        heap[i] = heap[c];
        hf[i] = hf[c];
        i = c;
      }
      heap[i] = id;
      hf[i] = f;
    }
    return top;
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
    const ray = this.ray;
    ray.origin.x = x;
    ray.origin.y = y;
    ray.origin.z = z;
    ray.dir.x = dirx;
    ray.dir.y = 0;
    ray.dir.z = dirz;
    const hit = this.physics.world.castRay(
      ray,
      dist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    return hit === null;
  }
}

/** Octile distance: admissible + consistent for 8-connected 1 / 1.4142 costs. */
function octile(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  return ax > ay ? ax + 0.4142 * ay : ay + 0.4142 * ax;
}