import * as THREE from "three";
import { WetMarks, waterHitBarycentric } from "./WetMarks";
import { WaterJets, type WaterJetHit } from "./WaterJets";
import { WaterFamasConfig } from "../../../shared/combat/WaterFamasRules";

/** Name of the Potato body SkinnedMesh (the wettable skin). */
const BODY_MESH = "Potato";

/** Live muzzle anchor: writes the muzzle WORLD position, false when unavailable. */
export type WaterFamasAnchor = (out: THREE.Vector3) => boolean;

/**
 * WATER FAMAS VISUALS (SlideIO glue around the pack's WaterJets / WetMarks) —
 * ONE instance for the whole session, shared by the local shooter and every
 * remote replay:
 *   - the visible water jets in flight (WaterJets: 2 draw calls for everybody,
 *     3 well separated packets per burst, glued to the LIVE muzzle);
 *   - the wet marks on the static level geometry (WetMarks: 1 draw call,
 *     seeded → identical on every client, dry in ~6 s);
 *   - per-vertex wetness on the characters: the gameplay hitboxes are boxes /
 *     capsules, so a second VISUAL raycast on the hit character's body mesh
 *     gives the face + barycentric the pack soaks (skinned raycast).
 * Purely visual: never a damage path.
 */
export class WaterFamasFX {
  readonly marks: WetMarks;
  readonly jets: WaterJets;
  private readonly ray = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly bodies = new WeakMap<THREE.Object3D, THREE.SkinnedMesh>();
  private readonly center = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(worldScene: THREE.Object3D) {
    // Pack defaults (tuned on its preview), except the cruise speed: x4
    // (30 → 120 m/s, WaterFamasConfig.jetSpeed) on request. The water still
    // leaves the barrel at 35 % of it and accelerates in the same 0.06 s.
    this.marks = new WetMarks(worldScene);
    this.jets = new WaterJets(worldScene, this.marks, { speed: WaterFamasConfig.jetSpeed });
  }

  /**
   * One visible jet (muzzle → hitscan impact). `hit` = what to wet on arrival
   * (null = miss). `anchor` = the shooter's LIVE muzzle: the water leaves the
   * barrel on the gun line even while he moves. NEVER `join` (it would merge
   * the 3 jets of a burst into one continuous stream — not a FAMAS).
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, hit: WaterJetHit | null, anchor: WaterFamasAnchor | null): void {
    const tmp = this.tmp;
    const source = anchor ? () => (anchor(tmp) ? tmp : null) : null;
    this.jets.spawn(from, to, hit, 1, { source });
  }

  /** Surface wet-mark target (STATIC level geometry only — never a moving prop). */
  surfaceHit(hit: THREE.Intersection, rayDir: THREE.Vector3, seed: number): WaterJetHit {
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : rayDir.clone().negate();
    return { normal, seed };
  }

  /**
   * Character wet target: VISUAL raycast on the body mesh of `root` (a Potato
   * clone) along the jet ray; fallback toward the body axis at the impact
   * height (the hitbox volume is larger than the mesh). Null when the mesh is
   * not found / not touched.
   */
  characterHit(root: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, point: THREE.Vector3): WaterJetHit | null {
    const body = this.bodyOf(root);
    if (!body) return null;
    this.marks.attach(body); // idempotent
    let hit = this.castBody(body, origin, dir, origin.distanceTo(point) + 3);
    if (!hit) {
      root.getWorldPosition(this.center);
      this.center.y = point.y;
      this.dir.subVectors(this.center, origin);
      const len = this.dir.length();
      if (len > 1e-4) hit = this.castBody(body, origin, this.dir.divideScalar(len), len + 3);
    }
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const bary = waterHitBarycentric(body, hit.faceIndex, hit.point, new THREE.Vector3());
    return { mesh: body, faceIndex: hit.faceIndex, bary };
  }

  /** DEATH / respawn: the player is dry again (every client). */
  dryUnder(root: THREE.Object3D): void {
    this.marks.dryUnder(root);
  }

  /** Disconnect / despawn / outfit change: original geometry + material restored. */
  detachUnder(root: THREE.Object3D): void {
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && this.marks.wet.has(sm)) meshes.push(sm);
    });
    for (const m of meshes) this.marks.detach(m);
    this.bodies.delete(root);
  }

  /** New session / round: surface marks gone, every character dry. */
  clearAll(): void {
    this.marks.clearSurfaces();
    for (const w of this.marks.wet.values()) w.clear();
  }

  /** Once per frame (after the spawns of the frame and after the weapons moved). */
  update(dt: number): void {
    this.jets.update(dt);
    this.marks.update(dt);
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

  private castBody(body: THREE.SkinnedMesh, origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
    this.ray.set(origin, dir);
    this.ray.near = 0;
    this.ray.far = far;
    this.hits.length = 0;
    // Direct skinned raycast: the characters' meshes are raycast-disabled for
    // gameplay (hitboxes own the shots) — this VISUAL query bypasses it. Broad
    // phase = the geometry sphere swapped in for the query only (no per-shot
    // re-skinning of the whole body, the culling sphere is untouched).
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

