import * as THREE from "three";

/**
 * PERF (loading): SkinnedMesh.computeBoundingBox / computeBoundingSphere,
 * same results, a fraction of the cost.
 *
 * three skins every vertex through `applyBoneTransform`, which multiplies
 * the bone's world matrix by its inverse bind matrix FOR EACH INFLUENCE OF
 * EACH VERTEX (a full 4×4 product, ×4 per vertex). Those products only
 * depend on the bone: here each one is computed once per call (same
 * function, same inputs, same float64 values), then every vertex goes through
 * EXACTLY three's sequence of operations — bind matrix, weighted sum of the
 * bone transforms, inverse bind matrix — so the boxes / spheres are
 * bit-identical. The character template's height normalisation spent
 * ~0.1 s of the loading screen in there.
 *
 * Meshes with active morph targets keep three's own code.
 */
const originalBox = THREE.SkinnedMesh.prototype.computeBoundingBox;
const originalSphere = THREE.SkinnedMesh.prototype.computeBoundingSphere;
const point = new THREE.Vector3();

/** Calls `visit` with every skinned vertex position, or returns false (three's path). */
function forEachSkinnedVertex(mesh: THREE.SkinnedMesh, visit: (p: THREE.Vector3) => void): boolean {
  const geometry = mesh.geometry;
  if (geometry.morphAttributes.position && mesh.morphTargetInfluences) return false;
  const position = geometry.getAttribute("position");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const skeleton = mesh.skeleton;
  if (!position || !skinIndex || !skinWeight || !skeleton) return false;

  const bones = skeleton.bones;
  const inverses = skeleton.boneInverses;
  // multiplyMatrices(bone.matrixWorld, boneInverse), once per bone used.
  const boneMatrix: (number[] | undefined)[] = [];
  const product = new THREE.Matrix4();
  const b = mesh.bindMatrix.elements;
  const v = mesh.bindMatrixInverse.elements;
  for (let index = 0; index < position.count; index++) {
    // Mesh.getVertexPosition (no morph) …
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    // … SkinnedMesh.applyBoneTransform: _baseVector.set(x, y, z, 1).applyMatrix4(bindMatrix)
    const w = 1;
    const bx = b[0] * x + b[4] * y + b[8] * z + b[12] * w;
    const by = b[1] * x + b[5] * y + b[9] * z + b[13] * w;
    const bz = b[2] * x + b[6] * y + b[10] * z + b[14] * w;
    const bw = b[3] * x + b[7] * y + b[11] * z + b[15] * w;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    for (let i = 0; i < 4; i++) {
      const weight = skinWeight.getComponent(index, i);
      if (weight === 0) continue;
      const bone = skinIndex.getComponent(index, i);
      let m = boneMatrix[bone];
      if (!m) {
        m = product.multiplyMatrices(bones[bone].matrixWorld, inverses[bone]).elements.slice();
        boneMatrix[bone] = m;
      }
      // _vector4.copy(_baseVector).applyMatrix4(_matrix4), then addScaledVector
      tx += (m[0] * bx + m[4] * by + m[8] * bz + m[12] * bw) * weight;
      ty += (m[1] * bx + m[5] * by + m[9] * bz + m[13] * bw) * weight;
      tz += (m[2] * bx + m[6] * by + m[10] * bz + m[14] * bw) * weight;
    }
    // target.applyMatrix4(bindMatrixInverse) (Vector3: perspective divide)
    const iw = 1 / (v[3] * tx + v[7] * ty + v[11] * tz + v[15]);
    point.set(
      (v[0] * tx + v[4] * ty + v[8] * tz + v[12]) * iw,
      (v[1] * tx + v[5] * ty + v[9] * tz + v[13]) * iw,
      (v[2] * tx + v[6] * ty + v[10] * tz + v[14]) * iw,
    );
    visit(point);
  }
  return true;
}

THREE.SkinnedMesh.prototype.computeBoundingBox = function (this: THREE.SkinnedMesh): void {
  if (this.boundingBox === null) this.boundingBox = new THREE.Box3();
  const box = this.boundingBox;
  box.makeEmpty();
  if (!forEachSkinnedVertex(this, (p) => box.expandByPoint(p))) originalBox.call(this);
};

THREE.SkinnedMesh.prototype.computeBoundingSphere = function (this: THREE.SkinnedMesh): void {
  if (this.boundingSphere === null) this.boundingSphere = new THREE.Sphere();
  const sphere = this.boundingSphere;
  sphere.makeEmpty();
  if (!forEachSkinnedVertex(this, (p) => sphere.expandByPoint(p))) originalSphere.call(this);
};
