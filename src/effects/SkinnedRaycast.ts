import * as THREE from "three";

/**
 * PERF — fast ray / skinned-mesh intersection for the VISUAL paint and wet
 * marks (paintball / water FAMAS character hits).
 *
 * three's SkinnedMesh.raycast re-skins every vertex of every triangle it
 * tests, on the CPU, recomputing `bone.matrixWorld × boneInverse` for each
 * influence of each corner: ~21 000 skinning operations (and ~85 000 matrix
 * products) per ray on the 3 754-vertex Potato body. Bots firing paintball /
 * FAMAS at each other paid that on EVERY hit — the frame-time spikes of the
 * 8-bot fights.
 *
 * Here the body is skinned ONCE per frame into a cached position buffer
 * (only when a ray actually needs it, with the skeleton's precomputed bone
 * matrices), then the ray is tested against plain triangles. Same result
 * (same pose, same triangles, double-sided like the body material).
 */
interface SkinCache {
  /**
   * The bind-pose positions the cache was built for. Keyed on the ATTRIBUTE,
   * not the geometry: the paint / wet layers swap in a geometry WRAPPER that
   * shares it (first hit, then back on death) — the same buffer stays valid.
   */
  source: THREE.BufferAttribute;
  frame: number;
  positions: Float32Array;
}

const caches = new WeakMap<THREE.SkinnedMesh, SkinCache>();
let frame = 0;
let lastBump = 0;

/** Call once per simulated frame (cached poses are valid for one frame). */
export function nextSkinnedRaycastFrame(): void {
  frame++;
  lastBump = performance.now();
}

const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export interface SkinnedHit {
  distance: number;
  point: THREE.Vector3;
  faceIndex: number;
}

/**
 * Nearest intersection of the WORLD ray (`origin`, unit `dir`, up to `far`)
 * with the skinned mesh in its current pose, or null.
 */
export function raycastSkinnedMesh(
  mesh: THREE.SkinnedMesh,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  far: number,
): SkinnedHit | null {
  const positions = skinnedPositions(mesh);
  if (!positions) return null;
  const geometry = mesh.geometry;
  const index = geometry.index;
  const triangles = index ? index.count / 3 : positions.length / 9;
  const idx = index ? (index.array as ArrayLike<number>) : null;

  // Ray in the mesh's LOCAL space (positions are local, as three's raycast).
  mesh.updateWorldMatrix(true, false);
  _inv.copy(mesh.matrixWorld).invert();
  _o.copy(origin).applyMatrix4(_inv);
  _d.copy(dir).transformDirection(_inv); // normalized: t is a local distance
  const ox = _o.x, oy = _o.y, oz = _o.z, dx = _d.x, dy = _d.y, dz = _d.z;

  let bestT = Infinity;
  let bestFace = -1;
  for (let f = 0; f < triangles; f++) {
    const a = (idx ? idx[f * 3] : f * 3) * 3;
    const b = (idx ? idx[f * 3 + 1] : f * 3 + 1) * 3;
    const c = (idx ? idx[f * 3 + 2] : f * 3 + 2) * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax, e2y = positions[c + 1] - ay, e2z = positions[c + 2] - az;
    // Möller–Trumbore, double-sided.
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < bestT) {
      bestT = t;
      bestFace = f;
    }
  }
  if (bestFace < 0) return null;
  const point = new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT).applyMatrix4(mesh.matrixWorld);
  const distance = point.distanceTo(origin);
  if (distance > far) return null;
  return { distance, point, faceIndex: bestFace };
}

/** Local-space skinned positions of `mesh` for the current frame (cached). */
function skinnedPositions(mesh: THREE.SkinnedMesh): Float32Array | null {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const skinIndex = geometry.getAttribute("skinIndex") as THREE.BufferAttribute | undefined;
  const skinWeight = geometry.getAttribute("skinWeight") as THREE.BufferAttribute | undefined;
  const skeleton = mesh.skeleton;
  if (!pos || !skinIndex || !skinWeight || !skeleton) return null;
  // Safety net when nobody bumps the frame (other contexts): 30 ms validity.
  if (performance.now() - lastBump > 30) nextSkinnedRaycastFrame();
  let cache = caches.get(mesh);
  if (cache && cache.source === pos && cache.frame === frame) return cache.positions;
  if (!cache || cache.source !== pos) {
    cache = { source: pos, frame: -1, positions: new Float32Array(pos.count * 3) };
    caches.set(mesh, cache);
  }
  // Bone matrices of the CURRENT pose (bones' matrixWorld are up to date in
  // the simulation phase; the renderer refreshes them again before drawing).
  skeleton.update();
  const bones = skeleton.boneMatrices!;
  const bind = mesh.bindMatrix.elements;
  const bindInv = mesh.bindMatrixInverse.elements;
  const out = cache.positions;
  const P = pos.array as ArrayLike<number>;
  const fast = !(pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && pos.itemSize === 3;
  for (let i = 0; i < pos.count; i++) {
    let x: number, y: number, z: number;
    if (fast) {
      x = P[i * 3];
      y = P[i * 3 + 1];
      z = P[i * 3 + 2];
    } else {
      x = pos.getX(i);
      y = pos.getY(i);
      z = pos.getZ(i);
    }
    // bindMatrix · p
    const bx = bind[0] * x + bind[4] * y + bind[8] * z + bind[12];
    const by = bind[1] * x + bind[5] * y + bind[9] * z + bind[13];
    const bz = bind[2] * x + bind[6] * y + bind[10] * z + bind[14];
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w === 0) continue;
      const m = skinIndex.getComponent(i, k) * 16;
      sx += w * (bones[m] * bx + bones[m + 4] * by + bones[m + 8] * bz + bones[m + 12]);
      sy += w * (bones[m + 1] * bx + bones[m + 5] * by + bones[m + 9] * bz + bones[m + 13]);
      sz += w * (bones[m + 2] * bx + bones[m + 6] * by + bones[m + 10] * bz + bones[m + 14]);
    }
    // bindMatrixInverse · skinned
    out[i * 3] = bindInv[0] * sx + bindInv[4] * sy + bindInv[8] * sz + bindInv[12];
    out[i * 3 + 1] = bindInv[1] * sx + bindInv[5] * sy + bindInv[9] * sz + bindInv[13];
    out[i * 3 + 2] = bindInv[2] * sx + bindInv[6] * sy + bindInv[10] * sz + bindInv[14];
  }
  cache.frame = frame;
  return out;
}
