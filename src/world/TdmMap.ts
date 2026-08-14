import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import vaultWallUrl from "../assets/vaultwall_opt.glb?url";

/** One perimeter wall segment, visualized with tiled vault GLB instances. */
interface WallSegment {
  x: number;
  baseY: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  /** Y rotation orienting the vault's decorated face toward the play area. */
  ry: number;
}

/**
 * "Block Party" — compact Red vs Blue TDM arena (Nuketown-like spirit).
 *
 * Top view (+Z = south = BLUE side, -Z = north = RED side):
 *
 *        ┌───────────── RED YARD (spawn feel) ─────────────┐
 *        │  [Red Garage]              [RED HOUSE + roof]   │
 *        │      phase→west lane            roof ramp→east  │
 *   west │                                                 │ east
 *   lane │  [Mid Shop]     STREET / TRUCK    [Container]   │ lane
 *        │   phase→north    center fight      phase tunnel │
 *        │                                                 │
 *        │  [BLUE HOUSE + roof]          [Blue Garage]     │
 *        │      roof ramp→west            phase→east lane  │
 *        └───────────── BLUE YARD (player spawn) ──────────┘
 *                          ↓ doorway
 *                    TRAINING RANGE annex
 *
 * Design goals:
 *  - Central street contested by both sides (truck = center cover).
 *  - Two flank lanes (west / east) with fences breaking sightlines.
 *  - Interiors: two houses, two garages, a mid shop, a container tunnel.
 *  - Moderate verticality: house roofs (ramps), garage/shop roofs (crates),
 *    container + truck tops — all reachable with the existing movement kit.
 *  - Exactly 4 phase walls, embedded in real architecture (garage side
 *    walls, shop rear wall, container side) — shortcuts, not decoration.
 *  - The old shooting range survives as a small annex behind the blue yard.
 */
export class TdmMap {
  readonly group = new THREE.Group();

  private physics: PhysicsWorld;
  private readonly vaultSegments: WallSegment[] = [];

  // Stylized daytime palette
  private static COLORS = {
    grass: 0x6da05b,
    asphalt: 0x3a3d42,
    plaza: 0x46494f,
    sidewalk: 0x9aa0a6,
    laneMark: 0xd8d8d8,
    boundary: 0x7f8b99,
    concrete: 0xb9b3a6,
    roof: 0x4a4f57,
    blueMain: 0x3b6fd4,
    blueDark: 0x2c54a3,
    blueAccent: 0x66a3ff,
    redMain: 0xd44a3b,
    redDark: 0xa33628,
    redAccent: 0xff8a75,
    cream: 0xd8d3c8,
    trim: 0x6b6f76,
    wood: 0xb08a54,
    fence: 0x8a7a5f,
    hedge: 0x50694a,
    container: 0x50707a,
    truckCab: 0xe8e8e8,
    truckBox: 0x777d85,
    dark: 0x2e3138,
    lampWarm: 0xfff1c9,
    phasePanel: 0x8b90a0,
    phaseGlow: 0xc084fc,
    rangeAccent: 0x9d5cff,
  };

  constructor(physics: PhysicsWorld) {
    this.physics = physics;

    this.buildLighting();
    this.buildGroundAndStreet();
    this.buildBoundary();
    this.buildBlueHouse();
    this.buildBlueGarage();
    this.buildBlueYard();
    this.buildRedHouse();
    this.buildRedGarage();
    this.buildRedYard();
    this.buildMidShop();
    this.buildContainerTunnel();
    this.buildCenterStreet();
    this.buildLanes();
    this.buildTrainingRange();
    this.loadVaultWalls();
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

  /** Visual-only box (no collider) — road paint, thin overlays, details. */
  private deco(
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
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /** Visual-only emissive strip (no collider) — markings, accents. */
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

  /**
   * Perimeter wall: invisible static collider (identical to the old boundary
   * boxes) + "Violet Vault" GLB visuals tiled along the wall once loaded.
   */
  private vaultWall(
    x: number,
    baseY: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    ry: number,
  ): void {
    this.physics.addStaticBox(x, baseY + sy / 2, z, sx, sy, sz);
    this.vaultSegments.push({ x, baseY, z, sx, sy, sz, ry });
  }

  /**
   * Loads the optimized vault GLB and instances it along every recorded
   * wall segment (InstancedMesh → one draw call per material, cheap).
   * Each segment is split into tiles whose aspect stays close to the
   * source model, then stretched to match the collider size exactly.
   */
  private loadVaultWalls(): void {
    const loader = new GLTFLoader();
    loader.load(vaultWallUrl, (gltf) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      // Bake meshes into normalized geometry: length along X, base at y = 0,
      // centered on x/z (the source vault already lies along X).
      const parts: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const geo = (obj.geometry as THREE.BufferGeometry).clone();
        geo.applyMatrix4(obj.matrixWorld);
        geo.translate(-center.x, -box.min.y, -center.z);
        parts.push({ geo, mat: obj.material });
      });
      if (parts.length === 0) return;

      // Split each segment into tiles with roughly the model's aspect ratio.
      const lenPerHeight = size.x / size.y;
      const tiles: { x: number; y: number; z: number; len: number; h: number; t: number; ry: number }[] = [];
      for (const s of this.vaultSegments) {
        const alongX = s.sx >= s.sz;
        const length = alongX ? s.sx : s.sz;
        const thick = alongX ? s.sz : s.sx;
        const n = Math.max(1, Math.round(length / (s.sy * lenPerHeight)));
        const tileLen = length / n;
        for (let i = 0; i < n; i++) {
          const off = -length / 2 + tileLen * (i + 0.5);
          tiles.push({
            x: alongX ? s.x + off : s.x,
            y: s.baseY,
            z: alongX ? s.z : s.z + off,
            len: tileLen,
            h: s.sy,
            t: thick,
            ry: s.ry,
          });
        }
      }

      const up = new THREE.Vector3(0, 1, 0);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const sc = new THREE.Vector3();

      for (const { geo, mat } of parts) {
        const inst = new THREE.InstancedMesh(geo, mat, tiles.length);
        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i];
          q.setFromAxisAngle(up, t.ry);
          sc.set(t.len / size.x, t.h / size.y, t.t / size.z);
          p.set(t.x, t.y, t.z);
          m.compose(p, q, sc);
          inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        this.group.add(inst);
      }
    });
  }

  /** Wooden crate (solid, climbable). */
  private crate(x: number, y: number, z: number, s: number): void {
    this.box(x, y, z, s, s, s, TdmMap.COLORS.wood);
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
    const t = 0.8;
    const dz = z1 - z0;
    const dh = h1 - h0;
    const len = Math.hypot(dz, dh) + 0.6;
    const angle = Math.atan2(-dh, dz);
    const cy = (h0 + h1) / 2 - Math.cos(angle) * (t / 2);
    const cz = (z0 + z1) / 2 - Math.sin(angle) * (t / 2);
    this.box(x, cy, cz, width, t, len, color, angle, 0);
  }

  /**
   * Phase-dashable wall panel. Looks like a slightly "tech" metal panel
   * embedded in the architecture, with a thin violet seam so players learn
   * to read it — collider is explicitly marked `phaseable`.
   */
  private phaseWall(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      new THREE.MeshLambertMaterial({
        color: TdmMap.COLORS.phasePanel,
        emissive: 0x5b21b6,
        emissiveIntensity: 0.28,
        transparent: true,
        opacity: 0.92,
      }),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // Thin glowing seams framing the panel — subtle but learnable.
    const g = TdmMap.COLORS.phaseGlow;
    if (sx >= sz) {
      this.glowStrip(x - sx / 2 + 0.06, y, z, 0.12, sy, sz + 0.05, g);
      this.glowStrip(x + sx / 2 - 0.06, y, z, 0.12, sy, sz + 0.05, g);
      this.glowStrip(x, y + sy / 2 - 0.05, z, sx, 0.1, sz + 0.05, g);
    } else {
      this.glowStrip(x, y, z - sz / 2 + 0.06, sx + 0.05, sy, 0.12, g);
      this.glowStrip(x, y, z + sz / 2 - 0.06, sx + 0.05, sy, 0.12, g);
      this.glowStrip(x, y + sy / 2 - 0.05, z, sx + 0.05, 0.1, sz, g);
    }

    this.physics.addStaticBox(x, y, z, sx, sy, sz, undefined, { phaseable: true });
  }

  /**
   * Text sign (canvas texture on a plane + dark backing).
   * `ry` rotates the group around Y (0 = facing +Z).
   */
  private sign(
    text: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    ry: number,
    bg: string,
    fg: string,
  ): void {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 14;
    ctx.strokeRect(14, 14, 484, 228);
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = text.split("\n");
    const size = lines.length > 1 ? 88 : 120;
    ctx.font = `900 ${size}px Arial, sans-serif`;
    const lineH = size * 1.1;
    const startY = 128 - ((lines.length - 1) * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 256, startY + i * lineH);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;

    const signGroup = new THREE.Group();
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.25, h + 0.25, 0.2),
      new THREE.MeshLambertMaterial({ color: TdmMap.COLORS.dark }),
    );
    back.castShadow = true;
    signGroup.add(back);

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    face.position.z = 0.12;
    signGroup.add(face);

    signGroup.position.set(x, y, z);
    signGroup.rotation.y = ry;
    this.group.add(signGroup);
  }

  // ------------------------------------------------------------------
  // Lighting / ground / boundary
  // ------------------------------------------------------------------

  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(0xd6e7ff, 0x64705a, 1.05);
    this.group.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2df, 1.45);
    sun.position.set(40, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.camera.far = 300;
    sun.shadow.bias = -0.0005;
    this.group.add(sun);
  }

  private buildGroundAndStreet(): void {
    const C = TdmMap.COLORS;

    // Grass base slab, top surface at y = 0 (x -44..44, z -48..48)
    this.box(0, -0.5, 0, 88, 1, 96, C.grass);

    // Central plaza / crossroads (visual overlay only)
    this.deco(0, 0.015, 0, 34, 0.03, 16, C.plaza);

    // North-south street + sidewalks (visual overlays)
    this.deco(0, 0.025, 0, 10, 0.03, 92, C.asphalt);
    this.deco(-6, 0.03, 0, 2, 0.03, 92, C.sidewalk);
    this.deco(6, 0.03, 0, 2, 0.03, 92, C.sidewalk);

    // Garage aprons
    this.deco(19, 0.02, 25, 8, 0.03, 4, C.plaza); // blue garage
    this.deco(-19, 0.02, -25, 8, 0.03, 4, C.plaza); // red garage

    // Center dashed lane markings
    for (let z = -42; z <= 42; z += 6) {
      this.deco(0, 0.05, z, 0.3, 0.02, 2.2, C.laneMark);
    }

    // Crosswalks at the plaza edges
    for (let x = -4; x <= 4; x += 1.6) {
      this.deco(x, 0.05, 20, 0.8, 0.02, 3, C.laneMark);
      this.deco(x, 0.05, -20, 0.8, 0.02, 3, C.laneMark);
    }

    // Territory lines: blue / red thresholds across the street
    this.glowStrip(0, 0.055, 24, 10, 0.04, 0.4, C.blueAccent);
    this.glowStrip(0, 0.055, -24, 10, 0.04, 0.4, C.redAccent);
  }

  private buildBoundary(): void {
    const h = 14;

    // West / east / north perimeter (vault GLB visuals, same colliders)
    this.vaultWall(-43, 0, 0, 2, h, 96, Math.PI / 2);
    this.vaultWall(43, 0, 0, 2, h, 96, -Math.PI / 2);
    this.vaultWall(0, 0, -47, 88, h, 2, 0);

    // South perimeter with a doorway (x 8..14) into the training range
    this.vaultWall(-18, 0, 47, 52, h, 2, Math.PI);
    this.vaultWall(29, 0, 47, 30, h, 2, Math.PI);
    this.vaultWall(11, 4, 47, 6, 10, 2, Math.PI); // lintel above doorway (opening 4 m)
    this.sign("RANGE", 11, 4.8, 45.85, 4, 1.6, Math.PI, "#20242c", "#c084fc");
  }

  // ------------------------------------------------------------------
  // BLUE side (south, +Z)
  // ------------------------------------------------------------------

  /**
   * Blue House — main blue building (x -28..-12, z 24..36).
   * Doors: east (street) + north (center). Windows on both fight-facing
   * walls. Walkable flat roof with a parapet toward the center, reached
   * by an exterior ramp in the west lane.
   */
  private buildBlueHouse(): void {
    const C = TdmMap.COLORS;
    const W = C.blueMain;
    const T = C.blueDark;

    // West wall (solid, wall-slide friendly)
    this.box(-27.7, 2, 30, 0.6, 4, 12, W);

    // South wall (back door to the blue yard, x -22..-19)
    this.box(-25, 2, 35.7, 6, 4, 0.6, W);
    this.box(-20.5, 3.5, 35.7, 3, 1, 0.6, T);
    this.box(-15.5, 2, 35.7, 7, 4, 0.6, W);

    // East wall, facing the street: door (z 27..30) + window (z 31.5..34.5)
    this.box(-12.3, 2, 25.5, 0.6, 4, 3, W);
    this.box(-12.3, 3.5, 28.5, 0.6, 1, 3, T); // door lintel
    this.box(-12.3, 2, 30.75, 0.6, 4, 1.5, W);
    this.box(-12.3, 0.6, 33, 0.6, 1.2, 3, T); // window sill
    this.box(-12.3, 3.4, 33, 0.6, 1.2, 3, T); // window header
    this.box(-12.3, 2, 35.25, 0.6, 4, 1.5, W);

    // North wall, facing center: door (x -26..-23) + window (x -19..-15)
    this.box(-27, 2, 24.3, 2, 4, 0.6, W);
    this.box(-24.5, 3.5, 24.3, 3, 1, 0.6, T); // door lintel
    this.box(-21, 2, 24.3, 4, 4, 0.6, W);
    this.box(-17, 0.6, 24.3, 4, 1.2, 0.6, T); // window sill
    this.box(-17, 3.4, 24.3, 4, 1.2, 0.6, T); // window header
    this.box(-13.5, 2, 24.3, 3, 4, 0.6, W);

    // Roof slab (top 4.6) + parapet cover on the center-facing edge
    this.box(-20, 4.3, 30, 16.6, 0.6, 12.6, C.roof);
    this.box(-20, 5.05, 24.2, 16.6, 0.9, 0.4, T);

    // Exterior roof ramp in the west lane (slide up / slide down!)
    this.rampZ(-29.5, 3, 43, 0, 33.5, 4.6, C.concrete);

    // Interior cover
    this.crate(-24, 0.7, 32, 1.4);

    // Rooftop billboard facing the center
    this.deco(-22, 5.5, 29, 0.3, 1.8, 0.3, C.dark);
    this.deco(-18, 5.5, 29, 0.3, 1.8, 0.3, C.dark);
    this.sign("BLUE", -20, 7.2, 29, 6, 2.4, Math.PI, "#16294f", "#66a3ff");
  }

  /**
   * Blue Garage (x 13..25, z 27..36) — open door facing center, side door
   * to the street. PHASE WALL: east wall panel → dash straight into the
   * east lane (fast street ↔ east-lane rotation, entry & exit flank).
   */
  private buildBlueGarage(): void {
    const C = TdmMap.COLORS;
    const W = C.blueDark;
    const T = C.trim;

    // North face: wide garage opening (x 15..23, 2.8 m high)
    this.box(14, 1.7, 27.3, 2, 3.4, 0.6, W);
    this.box(24, 1.7, 27.3, 2, 3.4, 0.6, W);
    this.box(19, 3.1, 27.3, 8, 0.6, 0.6, T);

    // West wall (street side) with a door (z 30..33)
    this.box(13.3, 1.7, 28.5, 0.6, 3.4, 3, W);
    this.box(13.3, 3.1, 31.5, 0.6, 0.6, 3, T);
    this.box(13.3, 1.7, 34.5, 0.6, 3.4, 3, W);

    // South wall (solid, backs the blue yard)
    this.box(19, 1.7, 35.7, 12, 3.4, 0.6, W);

    // East wall: PHASE PANEL (z 29..33) framed by solid segments
    this.box(24.7, 1.7, 28, 0.6, 3.4, 2, W);
    this.phaseWall(24.7, 1.5, 31, 0.5, 3, 4);
    this.box(24.7, 3.2, 31, 0.6, 0.4, 4, T);
    this.box(24.7, 1.7, 34.5, 0.6, 3.4, 3, W);

    // Roof (top 3.9) — reachable from the crate stack in the east lane
    this.box(19, 3.65, 31.5, 12.6, 0.5, 9.6, C.roof);

    // Interior cover
    this.crate(21, 0.7, 33.5, 1.4);

    // Crate stack in the east lane → garage roof access
    this.crate(28.5, 0.7, 35, 1.4);
    this.crate(28.5, 2.1, 35, 1.4);
  }

  /** Blue yard: spawn feel, props, base banner. */
  private buildBlueYard(): void {
    const C = TdmMap.COLORS;

    this.glowStrip(0, 0.03, 38, 14, 0.05, 0.5, C.blueAccent);
    this.crate(-5, 0.45, 40, 0.9);
    this.crate(-3.7, 0.45, 40.6, 0.9);
    this.crate(-4.4, 1.35, 40.3, 0.9);

    this.sign("BLUE\nBASE", 0, 4.5, 45.85, 5, 2.5, Math.PI, "#16294f", "#66a3ff");
  }

  // ------------------------------------------------------------------
  // RED side (north, -Z) — mirrored twin of the blue side
  // ------------------------------------------------------------------

  /** Red House (x 12..28, z -36..-24) — mirror of the Blue House. */
  private buildRedHouse(): void {
    const C = TdmMap.COLORS;
    const W = C.redMain;
    const T = C.redDark;

    // East wall (solid)
    this.box(27.7, 2, -30, 0.6, 4, 12, W);

    // North wall (back door to the red yard, x 19..22)
    this.box(25, 2, -35.7, 6, 4, 0.6, W);
    this.box(20.5, 3.5, -35.7, 3, 1, 0.6, T);
    this.box(15.5, 2, -35.7, 7, 4, 0.6, W);

    // West wall, facing the street: door (z -30..-27) + window (z -34.5..-31.5)
    this.box(12.3, 2, -25.5, 0.6, 4, 3, W);
    this.box(12.3, 3.5, -28.5, 0.6, 1, 3, T);
    this.box(12.3, 2, -30.75, 0.6, 4, 1.5, W);
    this.box(12.3, 0.6, -33, 0.6, 1.2, 3, T);
    this.box(12.3, 3.4, -33, 0.6, 1.2, 3, T);
    this.box(12.3, 2, -35.25, 0.6, 4, 1.5, W);

    // South wall, facing center: door (x 23..26) + window (x 15..19)
    this.box(27, 2, -24.3, 2, 4, 0.6, W);
    this.box(24.5, 3.5, -24.3, 3, 1, 0.6, T);
    this.box(21, 2, -24.3, 4, 4, 0.6, W);
    this.box(17, 0.6, -24.3, 4, 1.2, 0.6, T);
    this.box(17, 3.4, -24.3, 4, 1.2, 0.6, T);
    this.box(13.5, 2, -24.3, 3, 4, 0.6, W);

    // Roof slab (top 4.6) + parapet toward center
    this.box(20, 4.3, -30, 16.6, 0.6, 12.6, C.roof);
    this.box(20, 5.05, -24.2, 16.6, 0.9, 0.4, T);

    // Exterior roof ramp in the east lane
    this.rampZ(29.5, 3, -43, 0, -33.5, 4.6, C.concrete);

    // Interior cover
    this.crate(24, 0.7, -32, 1.4);

    // Rooftop billboard facing the center
    this.deco(22, 5.5, -29, 0.3, 1.8, 0.3, C.dark);
    this.deco(18, 5.5, -29, 0.3, 1.8, 0.3, C.dark);
    this.sign("RED", 20, 7.2, -29, 6, 2.4, 0, "#4a1410", "#ff8a75");
  }

  /**
   * Red Garage (x -25..-13, z -36..-27) — mirror of the Blue Garage.
   * PHASE WALL: west wall panel → dash straight into the west lane.
   */
  private buildRedGarage(): void {
    const C = TdmMap.COLORS;
    const W = C.redDark;
    const T = C.trim;

    // South face: wide garage opening (x -23..-15)
    this.box(-14, 1.7, -27.3, 2, 3.4, 0.6, W);
    this.box(-24, 1.7, -27.3, 2, 3.4, 0.6, W);
    this.box(-19, 3.1, -27.3, 8, 0.6, 0.6, T);

    // East wall (street side) with a door (z -33..-30)
    this.box(-13.3, 1.7, -28.5, 0.6, 3.4, 3, W);
    this.box(-13.3, 3.1, -31.5, 0.6, 0.6, 3, T);
    this.box(-13.3, 1.7, -34.5, 0.6, 3.4, 3, W);

    // North wall (solid, backs the red yard)
    this.box(-19, 1.7, -35.7, 12, 3.4, 0.6, W);

    // West wall: PHASE PANEL (z -33..-29) framed by solid segments
    this.box(-24.7, 1.7, -28, 0.6, 3.4, 2, W);
    this.phaseWall(-24.7, 1.5, -31, 0.5, 3, 4);
    this.box(-24.7, 3.2, -31, 0.6, 0.4, 4, T);
    this.box(-24.7, 1.7, -34.5, 0.6, 3.4, 3, W);

    // Roof (top 3.9)
    this.box(-19, 3.65, -31.5, 12.6, 0.5, 9.6, C.roof);

    // Interior cover
    this.crate(-21, 0.7, -33.5, 1.4);

    // Crate stack in the west lane → garage roof access
    this.crate(-28.5, 0.7, -35, 1.4);
    this.crate(-28.5, 2.1, -35, 1.4);
  }

  /** Red yard: mirrored spawn feel. */
  private buildRedYard(): void {
    const C = TdmMap.COLORS;

    this.glowStrip(0, 0.03, -38, 14, 0.05, 0.5, C.redAccent);
    this.crate(5, 0.45, -40, 0.9);
    this.crate(3.7, 0.45, -40.6, 0.9);
    this.crate(4.4, 1.35, -40.3, 0.9);

    this.sign("RED\nBASE", 0, 4.5, -45.85, 5, 2.5, 0, "#4a1410", "#ff8a75");
  }

  // ------------------------------------------------------------------
  // Center / mid structures
  // ------------------------------------------------------------------

  /**
   * Mid Shop (west, x -36..-24, z -6..6) — neutral pass-through building
   * between the street and the west lane (doors east + west).
   * PHASE WALL: rear (north) wall panel → aggressive exit toward the red
   * half, cutting the west-lane sightline.
   */
  private buildMidShop(): void {
    const C = TdmMap.COLORS;
    const W = C.cream;
    const T = C.trim;

    // East wall (street side) with a centered door (z -1.5..1.5)
    this.box(-24.3, 1.8, -3.75, 0.6, 3.6, 4.5, W);
    this.box(-24.3, 3.3, 0, 0.6, 0.6, 3, T);
    this.box(-24.3, 1.8, 3.75, 0.6, 3.6, 4.5, W);

    // West wall (lane side) with a centered door
    this.box(-35.7, 1.8, -3.75, 0.6, 3.6, 4.5, W);
    this.box(-35.7, 3.3, 0, 0.6, 0.6, 3, T);
    this.box(-35.7, 1.8, 3.75, 0.6, 3.6, 4.5, W);

    // South wall (blue-facing) with a window (x -33..-29)
    this.box(-34.5, 1.8, 5.7, 3, 3.6, 0.6, W);
    this.box(-31, 0.6, 5.7, 4, 1.2, 0.6, T);
    this.box(-31, 3.2, 5.7, 4, 0.8, 0.6, T);
    this.box(-26.5, 1.8, 5.7, 5, 3.6, 0.6, W);

    // North wall (red-facing): PHASE PANEL (x -33..-29)
    this.box(-34.5, 1.8, -5.7, 3, 3.6, 0.6, W);
    this.phaseWall(-31, 1.5, -5.7, 4, 3, 0.5);
    this.box(-31, 3.3, -5.7, 4, 0.6, 0.6, T);
    this.box(-26.5, 1.8, -5.7, 5, 3.6, 0.6, W);

    // Roof (top 4.1) — reachable from the west-lane crate stack
    this.box(-30, 3.85, 0, 12.6, 0.5, 12.6, C.roof);

    // Interior counter (cover)
    this.box(-30, 0.6, 1.5, 5, 1.2, 1.2, C.wood);

    // Crate stack against the west facade → shop roof access
    this.crate(-37.8, 0.7, 4.5, 1.4);
    this.crate(-37.8, 2.1, 4.5, 1.4);

    // Rooftop ad facing the street
    this.deco(-30, 4.9, 0.5, 0.3, 1.4, 0.3, C.dark);
    this.sign("YOUR AD\nHERE", -30, 6.2, 0.5, 5.5, 2.6, Math.PI / 2, "#2a2d34", "#e8e4da");
  }

  /**
   * Container tunnel (east, x 27..35, z -2..2) — a covered east-west
   * pass-through with a climbable top. PHASE WALL: the north side panel
   * lets you dash through the container to cut the corner toward red.
   */
  private buildContainerTunnel(): void {
    const C = TdmMap.COLORS;

    // South side wall (solid)
    this.box(31, 1.25, 1.85, 8, 2.5, 0.3, C.container);

    // North side: PHASE PANEL framed by solid ends
    this.box(27.5, 1.25, -1.85, 1, 2.5, 0.3, C.container);
    this.phaseWall(31, 1.25, -1.85, 6, 2.5, 0.3);
    this.box(34.5, 1.25, -1.85, 1, 2.5, 0.3, C.container);

    // Roof (top 2.8) — jumpable from the nearby crate
    this.box(31, 2.65, 0, 8, 0.3, 4.3, C.container);

    // Access crate
    this.crate(36.8, 0.7, 4.2, 1.4);
  }

  /** Street centerpiece (truck) + mid cover + lampposts + front yards. */
  private buildCenterStreet(): void {
    const C = TdmMap.COLORS;

    // Delivery truck parked mid-street: cargo top (2.75) is a power position
    this.box(0, 1.45, -1, 2.8, 2.6, 7, C.truckBox); // cargo
    this.box(0, 1.1, 4.1, 2.5, 2.2, 2.6, C.truckCab); // cab
    this.deco(0, 1.9, 5.42, 2.2, 0.7, 0.1, C.dark); // windshield
    for (const [wx, wz] of [
      [-1.3, -3.4],
      [1.3, -3.4],
      [-1.3, 1.4],
      [1.3, 1.4],
      [-1.2, 4.3],
      [1.2, 4.3],
    ] as Array<[number, number]>) {
      this.deco(wx, 0.4, wz, 0.35, 0.8, 0.8, C.dark);
    }
    this.crate(4.5, 0.7, 1, 1.4); // hop-up to the cargo top

    // Jersey barriers staggered on the street (slide-past cover)
    this.box(-3.2, 0.55, 12, 3.5, 1.1, 0.9, C.concrete);
    this.box(3.2, 0.55, -12, 3.5, 1.1, 0.9, C.concrete);

    // Planters at the plaza corners
    this.box(-8.5, 0.5, 16, 2.5, 1, 1.2, C.hedge);
    this.box(8.5, 0.5, -16, 2.5, 1, 1.2, C.hedge);

    // Lampposts flanking the plaza
    for (const [lx, lz] of [
      [6.3, 18],
      [-6.3, 18],
      [6.3, -18],
      [-6.3, -18],
    ] as Array<[number, number]>) {
      this.box(lx, 2.4, lz, 0.25, 4.8, 0.25, C.dark);
      const headX = lx > 0 ? lx - 0.9 : lx + 0.9;
      this.glowStrip(headX, 4.7, lz, 1.6, 0.15, 0.3, C.lampWarm);
    }

    // Front-yard picket fences + hedges (short cover, hoppable)
    this.box(-9.5, 0.5, 20, 5, 1, 0.25, C.fence); // blue house front
    this.box(9.5, 0.5, -20, 5, 1, 0.25, C.fence); // red house front
    this.box(10, 0.6, 23, 4, 1.2, 1, C.hedge); // blue garage front
    this.box(-10, 0.6, -23, 4, 1.2, 1, C.hedge); // red garage front
  }

  /** Flank lanes: fences that break sightlines but leave slide gaps. */
  private buildLanes(): void {
    const C = TdmMap.COLORS;

    // West lane (blue half): fence hugging the boundary, gap building-side
    this.box(-38, 1, 14, 8, 2, 0.3, C.fence);
    // West lane (red half): fence hugging the buildings, gap boundary-side
    this.box(-33, 1, -18, 8, 2, 0.3, C.fence);

    // East lane (blue half)
    this.box(34, 1, 16, 8, 2, 0.3, C.fence);
    // East lane (red half)
    this.box(38, 1, -16, 8, 2, 0.3, C.fence);
  }

  // ------------------------------------------------------------------
  // Training range annex (behind the blue yard, through the doorway)
  // ------------------------------------------------------------------

  /**
   * Compact shooting range (x -22..22, z 47..93). Firing line near the
   * entrance, close / medium / long markers, a couple of jump blocks.
   * Targets are spawned by TargetManager.
   */
  private buildTrainingRange(): void {
    const C = TdmMap.COLORS;

    // Floor (top surface at y = 0)
    this.box(0, -0.5, 70, 44, 1, 46, C.plaza);

    // Enclosing walls (vault GLB visuals, same colliders)
    this.vaultWall(-22, 0, 70, 2, 10, 46, Math.PI / 2);
    this.vaultWall(22, 0, 70, 2, 10, 46, -Math.PI / 2);
    this.vaultWall(0, 0, 93, 46, 10, 2, Math.PI);

    // Firing line + distance markers
    this.glowStrip(0, 0.03, 52, 40, 0.05, 0.4, C.rangeAccent);
    this.glowStrip(0, 0.03, 58, 40, 0.04, 0.3, 0x6d28d9);
    this.glowStrip(0, 0.03, 72, 40, 0.04, 0.3, 0x6d28d9);
    this.glowStrip(0, 0.03, 84, 40, 0.04, 0.3, 0x6d28d9);

    // Jump blocks for aerial tracking practice
    this.box(14, 0.7, 66, 3, 1.4, 3, C.concrete);
    this.box(-14, 0.9, 78, 3.5, 1.8, 3.5, C.concrete);
  }
}