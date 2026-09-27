import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PaintSplats, hitBarycentric } from "./PaintSplats";
import type { PaintHit } from "./PaintballProjectiles";
import { PaintballBalls, type PaintballAnchor } from "./PaintballBalls";

/** Surface splat diameter (m): 3× the pack's 0.32 m, matching the 3× ball. */
const SPLAT_SIZE = 0.96;

/** Name of the Potato body SkinnedMesh (the paintable skin — 3 754 vertices). */
const BODY_MESH = "Potato";

/**
 * PAINTBALL VISUALS (SlideIO glue around the pack's PaintSplats +
 * PaintballProjectiles) — ONE instance for the whole session, shared by the
 * local shooter and every remote replay:
 *   - persistent surface splats (1 draw call, seeded → identical everywhere);
 *   - the REAL balls in flight (PaintballBalls: balls + trails, the hopper
 *     ball — Ball_Template geometry, hopper material, exact palette colour —
 *     18 cm, straight + fast, glued to the live muzzle);
 *   - per-vertex paint on the characters: the gameplay hitboxes are boxes /
 *     capsules, so a second VISUAL raycast on the hit character's body mesh
 *     gives the face + barycentric the pack paints on (skinned raycast).
 * Purely visual: never a damage path.
 */
export class PaintballFX {
  readonly splats: PaintSplats;
  projectiles: PaintballBalls | null = null;
  /**
   * Called when a character body gets its paint material (per-avatar
   * clones replace the previous ones) — the solo bots re-route their
   * damage flash to the new materials through it.
   */
  onPaintMaterials: ((body: THREE.SkinnedMesh, previous: THREE.Material[], next: THREE.Material[]) => void) | null = null;
  /** Hopper palette (linear RGB) — index = the `pc` sent on the wire. */
  private palette: THREE.Color[] = [new THREE.Color(1, 1, 1)];
  private readonly ray = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly bodies = new WeakMap<THREE.Object3D, THREE.SkinnedMesh>();
  private readonly center = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(private readonly worldScene: THREE.Object3D) {
    this.splats = new PaintSplats(worldScene, { surfaceSize: SPLAT_SIZE });
  }

  /** Build the ball pool + palette from the (cached) weapon GLB. */
  init(gltf: GLTF): void {
    if (this.projectiles) return;
    const tpl = gltf.scene.getObjectByName("Ball_Template") as THREE.Mesh | undefined;
    if (tpl?.isMesh) {
      // The hopper ball geometry (unit radius) with a private glossy,
      // self-lit paint material (never the in-hand stencil marking).
      this.projectiles = new PaintballBalls(tpl.geometry, this.worldScene, this.splats);
    }
    const pal = gltf.scene.getObjectByName("Hopper")?.userData.palette as number[][] | undefined;
    if (pal && pal.length > 0) {
      this.palette = pal.map((c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace));
    }
  }

  /** Paint colour of a palette index (wire `pc`). */
  colorOf(index: number, out: THREE.Color): THREE.Color {
    return out.copy(this.palette[index] ?? this.palette[0]);
  }

  /** Palette index of a ball colour (nearest entry — the hopper colours are exact). */
  indexOf(color: THREE.Color): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.palette.length; i++) {
      const p = this.palette[i];
      const d = (p.r - color.r) ** 2 + (p.g - color.g) ** 2 + (p.b - color.b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * One real ball (muzzle → hitscan impact, straight). `hit` = what to paint
   * on arrival (null = miss). `anchor` = the shooter's LIVE muzzle: the ball
   * stays on the gun line while he moves (hitscan feel).
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, hit: PaintHit | null, anchor: PaintballAnchor | null = null): void {
    this.projectiles?.spawn(from, to, color, hit, anchor);
  }

  /** Surface splat target (STATIC level geometry only — never a moving prop). */
  surfaceHit(hit: THREE.Intersection, rayDir: THREE.Vector3, seed: number): PaintHit {
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : rayDir.clone().negate();
    return { normal, seed };
  }

  /**
   * Character paint target: VISUAL raycast on the body mesh of `root`
   * (a Potato clone) along the ball ray; fallback toward the body axis at
   * the impact height (the hitbox volume is larger than the mesh). Null
   * when the mesh is not found / not touched.
   */
  characterHit(root: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, point: THREE.Vector3): PaintHit | null {
    const body = this.bodyOf(root);
    if (!body || !this.prepare(body)) return null;
    let hit = this.castBody(body, origin, dir, origin.distanceTo(point) + 3);
    if (!hit) {
      root.getWorldPosition(this.center);
      this.center.y = point.y;
      this.dir.subVectors(this.center, origin);
      const len = this.dir.length();
      if (len > 1e-4) hit = this.castBody(body, origin, this.dir.divideScalar(len), len + 3);
    }
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const bary = hitBarycentric(body, hit.faceIndex, hit.point, new THREE.Vector3());
    return { mesh: body, faceIndex: hit.faceIndex, bary };
  }

  /** DEATH / respawn: the player loses every paint he carries. */
  clearPaintUnder(root: THREE.Object3D): void {
    this.splats.clearPaintUnder(root);
  }

  /** Disconnect / despawn / outfit change: original geometry + material restored. */
  detachUnder(root: THREE.Object3D): void {
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.geometry.getAttribute("paint")) meshes.push(sm);
    });
    for (const m of meshes) {
      const painted = Array.isArray(m.material) ? [...m.material] : [m.material];
      this.splats.detach(m); // restores + disposes the paint materials
      const restored = Array.isArray(m.material) ? m.material : [m.material];
      this.onPaintMaterials?.(m, painted, restored);
    }
    this.bodies.delete(root);
  }

  /** New session / round: balls, surface splats + character paint gone. */
  clearAll(): void {
    this.projectiles?.clear();
    this.splats.clearSurfaces();
    this.splats.clearCharacter();
  }

  /** GPU warm-up: compile the patched skin program on a temporary clone. */
  warmCharacter(root: THREE.Object3D): void {
    const body = this.bodyOf(root);
    if (body) this.prepare(body);
  }

  /**
   * Once per frame (after the spawns of the frame). `viewer` = the camera
   * world position: far balls keep a readable on-screen size.
   */
  update(dt: number, viewer?: THREE.Vector3): void {
    if (viewer) this.projectiles?.setViewer(viewer);
    this.projectiles?.update(dt);
  }

  // ------------------------------------------------------------------

  private bodyOf(root: THREE.Object3D): THREE.SkinnedMesh | null {
    const cached = this.bodies.get(root);
    if (cached) return cached;
    let found: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!found && sm.isSkinnedMesh && sm.name === BODY_MESH && !sm.userData.enemyOutline) found = sm;
    });
    if (found) this.bodies.set(root, found);
    return found;
  }

  /**
   * Per-player paint geometry + patched material (idempotent). Returns
   * false when the body cannot carry paint right now: an OUTFIT (Potato
   * Astronaut) swaps the body geometry for a masked copy it owns and
   * restores later — painting over it would fight that swap, so a dressed
   * body simply stays unpainted (surface splats still happen).
   */
  private prepare(body: THREE.SkinnedMesh): boolean {
    if (body.geometry.getAttribute("paint")) return true;
    if (/_AstronautMask$/.test(body.geometry.name)) return false;
    const previous = Array.isArray(body.material) ? [...body.material] : [body.material];
    this.splats.attach(body);
    const next = Array.isArray(body.material) ? body.material : [body.material];
    // Private per-avatar clones: the corpse fade pool evicts them once
    // unused (same policy as the per-instance outfit materials).
    for (const m of next) m.userData.corpsePoolEphemeral = true;
    this.onPaintMaterials?.(body, previous, next);
    return true;
  }

  private castBody(body: THREE.SkinnedMesh, origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
    this.ray.set(origin, dir);
    this.ray.near = 0;
    this.ray.far = far;
    this.hits.length = 0;
    // Direct skinned raycast: the characters' meshes are raycast-disabled
    // for gameplay (hitboxes own the shots) — this VISUAL query bypasses
    // it. Broad phase = the geometry sphere (inflated x2.5 for every pose
    // by PotatoCharacter) swapped in for the query only: no per-shot
    // re-skinning of 3 754 vertices, the culling sphere is untouched.
    const geo = body.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const broad = geo.boundingSphere;
    if (!broad) return null;
    const saved = body.boundingSphere;
    body.boundingSphere = broad;
    try {
      THREE.SkinnedMesh.prototype.raycast.call(body, this.ray, this.hits);
    } finally {
      body.boundingSphere = saved;
    }
    if (this.hits.length === 0) return null;
    let best = this.hits[0];
    for (const h of this.hits) if (h.distance < best.distance) best = h;
    return best;
  }
}
