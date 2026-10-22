import * as THREE from "three";
import { WetMarks, waterHitBarycentric } from "./WetMarks";
import { WaterJets, type WaterJetHit } from "./WaterJets";
import { WaterFamasConfig } from "../../../shared/combat/WaterFamasRules";
import { nextSkinnedRaycastFrame, raycastSkinnedMesh, type SkinnedHit } from "../../effects/SkinnedRaycast";

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

  /**
   * GPU warm-up: makes the body of a temporary clone wettable so the wet
   * skin program compiles at load (detachUnder() afterwards).
   */
  warmCharacter(root: THREE.Object3D): void {
    const body = this.bodyOf(root);
    if (body) this.marks.attach(body);
  }

  /**
   * CPU warm-up of the character hit path (load time, on a warm clone): the
   * visual skinned raycast, the barycentric lookup and the soak spread run a
   * few times — the FIRST real character hit of the session then runs
   * compiled code (see PaintballFX.warmHitPath). The clone is dried again.
   */
  warmHitPath(root: THREE.Object3D, runs = 6): void {
    const body = this.bodyOf(root);
    if (!body) return;
    root.updateMatrixWorld(true);
    const center = root.getWorldPosition(new THREE.Vector3());
    center.y += 0.9;
    const origin = center.clone().add(new THREE.Vector3(-0.3, 0.2, 4));
    const dir = new THREE.Vector3().subVectors(center, origin).normalize();
    for (let i = 0; i < runs; i++) {
      nextSkinnedRaycastFrame(); // a real skinning pass each time (per-frame cache)
      const hit = this.characterHit(root, origin, dir, center);
      if (hit?.mesh && hit.faceIndex !== undefined && hit.bary) this.marks.wetHit(hit.mesh, hit.faceIndex, hit.bary);
    }
    this.marks.dryUnder(root);
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

  private castBody(body: THREE.SkinnedMesh, origin: THREE.Vector3, dir: THREE.Vector3, far: number): SkinnedHit | null {
    // VISUAL query on the skinned body (the characters' meshes are
    // raycast-disabled for gameplay — hitboxes own the shots). PERF: the
    // body is skinned once per frame into a cached buffer (SkinnedRaycast)
    // instead of three's per-triangle CPU re-skinning on every ray.
    return raycastSkinnedMesh(body, origin, dir, far);
  }
}

