import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";

/**
 * Enclosed low-poly movement arena.
 *
 * Layout (top view, +Z is south toward spawn):
 *   - South: long speed corridor (spawn, slide hopping lane)
 *   - Center: open arena (strafing, bhop, central block + ramps, pillars)
 *   - East: ramp zone (ramp up → high platform → jump back into arena)
 *   - West: wall-run canyon (two tall parallel walls, ascending platforms)
 *   - North: stairs, low slide obstacles, practice platforms
 *   - Far north (through the doorway at z = -49): shooting range with
 *     moving training targets at close / medium / long distance.
 * Everything is ringed by tall outer walls; a kill plane catches escapees.
 */
export class TestMap {
  readonly group = new THREE.Group();

  private physics: PhysicsWorld;

  // Zone palette
  private static COLORS = {
    floor: 0x2b3340,
    outerWall: 0x39434f,
    innerWall: 0x46525f,
    corridor: 0x3d4a53,
    arena: 0x2f8f83,
    east: 0xc9763b,
    west: 0x4a6fa5,
    north: 0x8a63b8,
    obstacle: 0xd8b13c,
    rangeAccent: 0x9d5cff,
  };

  constructor(physics: PhysicsWorld) {
    this.physics = physics;

    this.buildLighting();
    this.buildFloorAndShell();
    this.buildSouthCorridor();
    this.buildArena();
    this.buildEastRampZone();
    this.buildWestWallZone();
    this.buildNorthZone();
    this.buildShootingRange();
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Axis-aligned (or rotated) box: visual mesh + static collider. */
  private box(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: number,
    rotX = 0,
    rotZ = 0,
  ): void {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.set(rotX, 0, rotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    const q = mesh.quaternion;
    this.physics.addStaticBox(x, y, z, sx, sy, sz, {
      x: q.x,
      y: q.y,
      z: q.z,
      w: q.w,
    });
  }

  /** Ramp along Z: slope from (z0, h0) to (z1, h1), top surface exact. */
  private rampZ(
    x: number,
    width: number,
    z0: number,
    h0: number,
    z1: number,
    h1: number,
    color: number,
  ): void {
    const t = 0.8; // slab thickness
    const dz = z1 - z0;
    const dh = h1 - h0;
    const len = Math.hypot(dz, dh) + 0.6;
    const angle = Math.atan2(-dh, dz);
    // Plane normal after rotX(angle): (0, cos, sin)
    const cy = (h0 + h1) / 2 - Math.cos(angle) * (t / 2);
    const cz = (z0 + z1) / 2 - Math.sin(angle) * (t / 2);
    this.box(x, cy, cz, width, t, len, color, angle, 0);
  }

  /** Visual-only emissive strip (no collider) — floor markers, accents. */
  private glowStrip(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: number,
  ): void {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.set(x, y, z);
    this.group.add(mesh);
  }

  /** Ramp along X: slope from (x0, h0) to (x1, h1). */
  private rampX(
    z: number,
    width: number,
    x0: number,
    h0: number,
    x1: number,
    h1: number,
    color: number,
  ): void {
    const t = 0.8;
    const dx = x1 - x0;
    const dh = h1 - h0;
    const len = Math.hypot(dx, dh) + 0.6;
    const angle = Math.atan2(dh, dx);
    // Plane normal after rotZ(angle): (-sin, cos, 0)
    const cx = (x0 + x1) / 2 + Math.sin(angle) * (t / 2);
    const cy = (h0 + h1) / 2 - Math.cos(angle) * (t / 2);
    // Rotated around Z: length along X ⇒ box sized (len, t, width)
    this.box(cx, cy, z, len, t, width, color, 0, angle);
  }

  // ------------------------------------------------------------------
  // Zones
  // ------------------------------------------------------------------

  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x3a3f4a, 1.0);
    this.group.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
    sun.position.set(35, 70, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -110;
    sun.shadow.camera.right = 110;
    sun.shadow.camera.top = 110;
    sun.shadow.camera.bottom = -110;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0005;
    this.group.add(sun);
  }

  private buildFloorAndShell(): void {
    const C = TestMap.COLORS;

    // Main floor (top surface at y = 0)
    this.box(0, -0.5, 0, 98, 1, 98, C.floor);

    // Subtle grid for optic flow / speed perception
    const grid = new THREE.GridHelper(96, 48, 0x55606e, 0x3a4450);
    grid.position.y = 0.02;
    this.group.add(grid);

    // Outer shell: 4 walls, 16 m high.
    // The north wall has a wide doorway (x -14..14) into the shooting range.
    const h = 16;
    this.box(-32, h / 2, -49, 36, h, 2, C.outerWall); // north, west of doorway
    this.box(32, h / 2, -49, 36, h, 2, C.outerWall); // north, east of doorway
    this.box(0, (6 + h) / 2, -49, 28, h - 6, 2, C.outerWall); // lintel above doorway
    this.box(0, h / 2, 49, 100, h, 2, C.outerWall); // south
    this.box(-49, h / 2, 0, 2, h, 100, C.outerWall); // west
    this.box(49, h / 2, 0, 2, h, 100, C.outerWall); // east
  }

  /** South speed lane (z 30..48): long, flat, ideal for slide hopping. */
  private buildSouthCorridor(): void {
    const C = TestMap.COLORS;

    // Corridor / arena divider at z = 30 with two openings:
    //   x in [-10,-4]  → low-bar opening (slide under)
    //   x in [4,10]    → clean opening
    const h = 7;
    this.box(-29, h / 2, 30, 38, h, 1.5, C.innerWall); // x -48..-10
    this.box(0, h / 2, 30, 8, h, 1.5, C.innerWall); // x -4..4
    this.box(29, h / 2, 30, 38, h, 1.5, C.innerWall); // x 10..48

    // Low bar above the west opening: gap of 1.3 m → must slide through
    this.box(-7, (1.3 + h) / 2, 30, 6, h - 1.3, 1.5, C.obstacle);

    // Corridor accents: lane markers to feel the speed
    for (let x = -40; x <= 40; x += 10) {
      this.box(x, 0.05, 39, 0.6, 0.1, 6, C.corridor);
    }
  }

  /** Central arena: open space, central block + ramps, pillars, side platform. */
  private buildArena(): void {
    const C = TestMap.COLORS;

    // Central raised block, reachable by ramps or a slide hop
    this.box(0, 0.6, 0, 10, 1.2, 10, C.arena);
    this.rampX(0, 6, -11, 0, -5, 1.2, C.arena);
    this.rampX(0, 6, 11, 0, 5, 1.2, C.arena);

    // Pillars for weaving between at speed
    const pillars: Array<[number, number]> = [
      [-14, -14],
      [14, -14],
      [-14, 14],
      [14, 14],
    ];
    for (const [px, pz] of pillars) {
      this.box(px, 4, pz, 2.4, 8, 2.4, C.innerWall);
    }

    // Side platform with a jump gap toward the central block
    this.box(-18, 1.2, 0, 5, 2.4, 8, C.arena);
  }

  /**
   * East ramp zone (x 24..48): entrance in the divider, long ramp up,
   * high platform, then an open gap to leap back into the arena at height.
   */
  private buildEastRampZone(): void {
    const C = TestMap.COLORS;
    const h = 8;

    // Divider wall at x = 24. Openings:
    //   z in [8,16]   → ground entrance
    //   z in [-16,-6] → fully open gap (platform jump-off into the arena)
    this.box(24, h / 2, -32, 1.5, h, 32, C.innerWall); // z -48..-16
    this.box(24, h / 2, 1, 1.5, h, 14, C.innerWall); // z -6..8
    this.box(24, h / 2, 23, 1.5, h, 14, C.innerWall); // z 16..30

    // Ramp up toward the north (z 12 → -4, height 0 → 3.6)
    this.rampZ(34, 8, 12, 0, -4, 3.6, C.east);

    // High platform against the open gap (top at y = 3.9)
    this.box(32, 3.5, -11, 14, 0.8, 10, C.east);

    // Descending ramp off the platform's north edge, back to the ground
    this.rampZ(34, 6, -16, 3.9, -30, 0, C.east);

    // A low obstacle in the middle of the zone: slide under it at speed
    this.box(38, (1.3 + 5) / 2, 22, 8, 5 - 1.3, 1.5, C.obstacle);
  }

  /**
   * West wall-run canyon (x -48..-24): two tall parallel walls with a 6 m gap,
   * ascending platforms — designed for jump → wall slide → wall jump chains.
   */
  private buildWestWallZone(): void {
    const C = TestMap.COLORS;
    const h = 8;

    // Divider wall at x = -24. Openings:
    //   z in [6,14]    → ground entrance (south)
    //   z in [-32,-24] → exit toward the north zone
    this.box(-24, h / 2, -40, 1.5, h, 16, C.innerWall); // z -48..-32
    this.box(-24, h / 2, -9, 1.5, h, 30, C.innerWall); // z -24..6
    this.box(-24, h / 2, 22, 1.5, h, 16, C.innerWall); // z 14..30

    // The canyon: two tall walls, inner faces 6 m apart
    this.box(-31, 4.5, 0, 1.2, 9, 40, C.west); // east wall of canyon
    this.box(-38, 4.5, 0, 1.2, 9, 40, C.west); // west wall of canyon

    // Ascending platforms inside the canyon (chain wall jumps to climb)
    this.box(-34.5, 1.9, 8, 3.2, 0.6, 4, C.west); // top 2.2
    this.box(-34.5, 3.3, -2, 3.2, 0.6, 4, C.west); // top 3.6
    this.box(-34.5, 4.7, -12, 3.2, 0.6, 4, C.west); // top 5.0

    // High ledge at the north end of the canyon (top 6.0)
    this.box(-34.5, 5.7, -22, 12, 0.6, 4, C.west);
  }

  /** North zone (z -48..-30): stairs, slide bars, practice platforms. */
  private buildNorthZone(): void {
    const C = TestMap.COLORS;
    const h = 7;

    // Divider wall at z = -30 with a wide central opening (x -8..8)
    this.box(-16, h / 2, -30, 16, h, 1.5, C.innerWall); // x -24..-8
    this.box(16, h / 2, -30, 16, h, 1.5, C.innerWall); // x 8..24

    // Staircase (0.3 m steps — tests autostep) up to a platform
    for (let i = 0; i < 8; i++) {
      const stepH = 0.3 * (i + 1);
      this.box(-10, stepH / 2, -34 - i, 8, stepH, 1, C.north);
    }
    this.box(-10, 2.1, -44.5, 8, 0.6, 5, C.north); // top at 2.4

    // Double slide bars: a fast crouch-slide gauntlet
    this.box(8, (1.3 + 4) / 2, -36, 8, 4 - 1.3, 1.2, C.obstacle);
    this.box(8, (1.3 + 4) / 2, -41, 8, 4 - 1.3, 1.2, C.obstacle);
    // Side rails funneling the player under the bars
    this.box(3.5, 1.5, -38.5, 1, 3, 8, C.north);
    this.box(12.5, 1.5, -38.5, 1, 3, 8, C.north);

    // Free-standing practice platforms
    this.box(18, 0.8, -40, 5, 1.6, 5, C.north); // top 1.6
    this.box(0, 1.5, -44, 5, 3, 5, C.north); // top 3.0
  }

  /**
   * Shooting range (z -49..-115, x -36..36), reached through the doorway
   * in the north outer wall. Wide open space for tracking practice with
   * close / medium / long distance markers, an elevated firing deck,
   * a wall-slide panel and a few jump blocks so every movement mechanic
   * can be combined with shooting. Targets are spawned by TargetManager.
   */
  private buildShootingRange(): void {
    const C = TestMap.COLORS;
    const h = 16;

    // Floor (top surface at y = 0) + optic-flow grid
    this.box(0, -0.5, -82.5, 74, 1, 67, C.floor);
    const grid = new THREE.GridHelper(64, 32, 0x55606e, 0x3a4450);
    grid.position.set(0, 0.02, -82.5);
    this.group.add(grid);

    // Enclosing walls (west, east, back)
    this.box(-36, h / 2, -82.5, 2, h, 67, C.outerWall);
    this.box(36, h / 2, -82.5, 2, h, 67, C.outerWall);
    this.box(0, h / 2, -115, 74, h, 2, C.outerWall);

    // Doorway accents: glowing violet frame strips
    this.glowStrip(-14.4, 3, -49, 0.5, 6, 2.2, C.rangeAccent);
    this.glowStrip(14.4, 3, -49, 0.5, 6, 2.2, C.rangeAccent);

    // Firing line marker just inside the range
    this.glowStrip(0, 0.03, -53, 60, 0.06, 0.5, C.rangeAccent);

    // Distance markers across the floor: CLOSE / MEDIUM / LONG
    this.glowStrip(0, 0.03, -63, 66, 0.06, 0.35, 0x6d28d9);
    this.glowStrip(0, 0.03, -82, 66, 0.06, 0.35, 0x6d28d9);
    this.glowStrip(0, 0.03, -103, 66, 0.06, 0.35, 0x6d28d9);

    // Elevated firing deck (east side) + access ramp — shoot from height
    this.box(27, 1.4, -60, 12, 2.8, 10, C.east); // top 2.8
    this.rampX(-60, 8, 15, 0, 21, 2.8, C.east);

    // Wall-slide panel (west side, parallel to the firing direction):
    // jump onto it and track targets while wall sliding
    this.box(-27, 4.5, -75, 1.2, 9, 28, C.west);

    // Low slide bar on the west lane: slide under it while keeping the beam on
    this.box(-16, (1.3 + 4) / 2, -70, 8, 4 - 1.3, 1.2, C.obstacle);

    // Jump blocks scattered mid-range for aerial shots and slide hops
    this.box(12, 0.7, -70, 4, 1.4, 4, C.north); // top 1.4
    this.box(18, 1.2, -78, 4, 2.4, 4, C.north); // top 2.4
    this.box(-8, 0.9, -90, 5, 1.8, 5, C.north); // top 1.8
  }
}
