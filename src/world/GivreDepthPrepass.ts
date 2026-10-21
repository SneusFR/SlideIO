import * as THREE from "three";
import { splitByGrid, type ChunkGrid } from "./GivreRenderOptim";
import { diagSwitch } from "../ui/perfDiag";

/**
 * GIVRE — DEPTH PREPASS of the opaque static map (GPU: pixel-shading overdraw).
 *
 * The map's material (MeshStandardMaterial: sun + hemisphere light, PCF
 * shadow map, baked AO + emissive maps) is the heaviest pixel of the frame,
 * and it was shaded ≈ 2 times per covered pixel: inside one big batch the
 * triangles come in BVH order (MapBvh reorders the index), not front to
 * back, and three's front-to-back sort only orders whole batches
 * (tools/perf/overdraw-bench.mjs counts it per pixel and per draw).
 *
 * With the prepass, the big triangles of the static map (≥ minArea: walls,
 * floors, roofs — they do almost all the occluding) and of the backdrop
 * (out-of-bounds plain + mountains, which hide part of the map's ground) are
 * drawn FIRST, depth only (colour writes off, empty fragment shader); then
 * the world pass runs exactly as before (depth test LEQUAL, three's
 * default): a map fragment passes only where it IS the nearest surface —
 * each covered pixel is shaded ≈ once (plus exact depth ties). Cost: those
 * triangles' positions a second time (welded: fewer vertices than the
 * batches, which split them on UV / normal seams), depth-only
 * rasterisation, and 2 draws (one position-only mesh per face side).
 *
 * SAME IMAGE, bit for bit, as long as no prepass depth is NEARER than the
 * depth the main pass computes for the same fragment: at every pixel the
 * prepass depth is then ≥ the nearest opaque depth m, and with LEQUAL the
 * main pass keeps, as before, the LAST drawn fragment at depth m (a fragment
 * passes while nothing nearer was stored; once m is written, only depth-m
 * fragments pass); transparents and the sky test the same final depth
 * buffer. This holds for ANY subset of the main pass's opaque fragments, so
 * batches can be left out freely — but never a fragment the main pass does
 * not draw (a back face of a FrontSide batch, say): hence one proxy per side.
 * The depth is the same because:
 *  - same triangles: the proxies hold the batches' own position values,
 *    copied bit for bit (exact-bit welding only merges equal floats), each
 *    triangle with its vertices in the same order; batches and proxies are
 *    both drawn with an IDENTITY world matrix (refused otherwise), so three
 *    computes the same modelViewMatrix in JS, from the same camera;
 *  - same computation: the proxy's vertex shader is three's own chunks
 *    (begin_vertex + project_vertex: `projectionMatrix * (modelViewMatrix *
 *    vec4(position, 1.0))`), and both programs declare
 *    `invariant gl_Position` — GLSL ES 3.00 §4.6.1: the same expression on
 *    the same inputs in two programs then gives the same value (no
 *    compiler-dependent contraction or reordering of that computation);
 *  - only plain meshes (prepassEligible): no skinning, morph targets,
 *    instancing, displacement, alpha test / hash, clipping planes, polygon
 *    offset, custom depth function, custom or unknown shader patch; Game's
 *    renderer has no logarithmic / reversed depth buffer (a different depth
 *    path — never enable one with the prepass on).
 * Pixel identity is checked on the bench (old vs new, RGBA, several poses,
 * LOW and HIGH); `?diag=prepass` / `?diag=noprepass` switch it per session.
 */

/** Group order of the proxies: before every other opaque of the world (three sorts by groupOrder first). */
export const PREPASS_GROUP_ORDER = -1000;

/** Name of the proxies (debug HUD: the `?gpu=draws` category "pré-passe"). */
export const PREPASS_NAME = "givre_prepass";

const INVARIANT = "invariant gl_Position;\n";

/** Vertex shader of the proxies: three's position chunks, nothing else. */
export const PREPASS_VERTEX_SHADER = `${INVARIANT}void main() {
#include <begin_vertex>
#include <project_vertex>
}
`;

/** Depth only: colour writes are off; nothing to compute. */
export const PREPASS_FRAGMENT_SHADER = "void main() {}\n";

/** Program cache-key suffix of a material patched with `invariant gl_Position`. */
const INVARIANT_KEY = "+invariant-position";

/** A camera pose of the load-time check (radians; yaw = rotation.y, 0 = facing −Z). */
export interface VerifyPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/**
 * Views of the load-time check: the village centre facing north (walls,
 * ground, interiors behind façades) and the whole map from above the south
 * edge (most batches at once). A depth mismatch is systematic (compiler):
 * two dense views are enough to see it.
 */
export const VERIFY_POSES: readonly VerifyPose[] = [
  { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 },
  { x: 0, y: 30, z: 75, yaw: 0, pitch: (-16 * Math.PI) / 180 },
];

/**
 * Console line of the load-time check (production builds too: on the real
 * GPU, F12 tells whether the prepass is really on).
 */
export function logPrepassCheck(differing: number, prepass: { verified: { pixels: number } | null; proxies: readonly unknown[] }): void {
  const pixels = prepass.verified?.pixels ?? 0;
  if (differing === 0) {
    console.info(`[GPU] pré-passe de profondeur active : image identique avec / sans (${pixels} pixels comparés, ${prepass.proxies.length} draws de profondeur)`);
  } else if (differing < 0) {
    console.warn("[GPU] pré-passe de profondeur DÉSACTIVÉE : depth buffer logarithmique ou inversé (autre calcul de profondeur)");
  } else {
    console.warn(`[GPU] pré-passe de profondeur DÉSACTIVÉE : ${differing} pixels sur ${pixels} diffèrent avec / sans — profondeur non identique entre les deux programmes sur ce GPU`);
  }
}

/** Session switch: GivreConfig default, `?diag=prepass` forces it on, `?diag=noprepass` off. */
export function depthPrepassWanted(defaultOn: boolean, experiments: ReadonlySet<string>): boolean {
  return diagSwitch(experiments, "prepass", defaultOn);
}

interface MaybeSpecial {
  isSkinnedMesh?: boolean;
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
}

/**
 * May this mesh be drawn in the depth prepass with the SAME depth as its
 * main-pass draw? Conservative: anything that moves vertices or fragments
 * away from `projectionMatrix * modelViewMatrix * position` + the fixed
 * LEQUAL depth test is refused. `knownPatch` = the materials whose
 * onBeforeCompile is known not to touch the position (MapUberMaterial).
 */
export function prepassEligible(mesh: THREE.Mesh, knownPatch: (m: THREE.Material) => boolean = () => false): boolean {
  const special = mesh as unknown as MaybeSpecial;
  if (!mesh.isMesh || special.isSkinnedMesh || special.isInstancedMesh || special.isBatchedMesh) return false;
  if (Array.isArray(mesh.material) || !mesh.visible) return false;
  const geometry = mesh.geometry;
  if (Object.keys(geometry.morphAttributes).length > 0 || geometry.groups.length > 0) return false;
  if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return false;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (!position || position.itemSize !== 3 || (position as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return false;
  if (position.normalized || !((position as THREE.BufferAttribute).array instanceof Float32Array)) return false;
  const m = mesh.material as THREE.MeshStandardMaterial;
  // A custom vertex shader may compute the position its own way.
  if ((m as unknown as THREE.ShaderMaterial).isShaderMaterial) return false;
  if (!m.visible || m.transparent || m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage) return false;
  if (!m.depthTest || !m.depthWrite || m.depthFunc !== THREE.LessEqualDepth || !m.colorWrite) return false;
  if (m.blending !== THREE.NormalBlending || m.polygonOffset || m.wireframe) return false;
  if ((m.clippingPlanes && m.clippingPlanes.length > 0) || m.displacementMap) return false;
  // (our own invariant patch does not move vertices: judge the patch under it)
  const onBeforeCompile = (m as InvariantTagged).__invariantPosition?.onBeforeCompile ?? m.onBeforeCompile;
  if (onBeforeCompile !== THREE.Material.prototype.onBeforeCompile && !knownPatch(m)) return false;
  return true;
}

/** Exactly the identity (every element bit-equal to the identity's). */
export function isIdentity(m: THREE.Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) if (e[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  return true;
}

/**
 * Adds `invariant gl_Position` to a material's vertex shader (once; its
 * program cache key changes accordingly: a new program, compiled at load
 * with the rest of the scene).
 */
export function patchInvariantPosition(material: THREE.Material): void {
  const tagged = material as InvariantTagged;
  if (tagged.__invariantPosition) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey;
  tagged.__invariantPosition = { onBeforeCompile: before, customProgramCacheKey: key };
  material.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    if (!shader.vertexShader.startsWith(INVARIANT)) shader.vertexShader = INVARIANT + shader.vertexShader;
  };
  // three's default key is the SOURCE of onBeforeCompile — now this wrapper's,
  // the same for every patched material: keep the original patch's source in
  // the key, or two different patches would share one program.
  const defaultKey = key === THREE.Material.prototype.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return (defaultKey ? before.toString() : key.call(this)) + INVARIANT_KEY;
  };
  material.needsUpdate = true;
}

/** Undoes patchInvariantPosition (bench A/B: the exact production program). */
export function unpatchInvariantPosition(material: THREE.Material): void {
  const tagged = material as InvariantTagged;
  const saved = tagged.__invariantPosition;
  if (!saved) return;
  material.onBeforeCompile = saved.onBeforeCompile;
  material.customProgramCacheKey = saved.customProgramCacheKey;
  delete tagged.__invariantPosition;
  material.needsUpdate = true;
}

type InvariantTagged = THREE.Material & {
  __invariantPosition?: {
    onBeforeCompile: THREE.Material["onBeforeCompile"];
    customProgramCacheKey: THREE.Material["customProgramCacheKey"];
  };
};

/** True when `patchInvariantPosition` was applied. */
export function hasInvariantPosition(material: THREE.Material): boolean {
  return (material as InvariantTagged).__invariantPosition !== undefined;
}

/** The depth-only material of the proxies (one per side). */
export function createPrepassMaterial(side: THREE.Side): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: `${PREPASS_NAME}_${side === THREE.FrontSide ? "front" : side === THREE.BackSide ? "back" : "double"}`,
    vertexShader: PREPASS_VERTEX_SHADER,
    fragmentShader: PREPASS_FRAGMENT_SHADER,
    side,
  });
  material.colorWrite = false;
  // An override material (outline pre-pass…) never replaces it: the proxy
  // stays a depth-only draw of the same surface.
  material.allowOverride = false;
  return material;
}

/** Area (m²) of the triangle (a, b, c) of a position array. */
function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return Math.sqrt(x * x + y * y + z * z) / 2;
}

/**
 * Position-only copy of `geometries` merged into one indexed geometry, with
 * vertices welded on EXACT float equality (bit-identical positions only:
 * every triangle keeps its exact vertex values, in the same order). The UV /
 * normal seams of the batches split vertices the depth pass does not need.
 * `minArea` > 0 keeps only the triangles of at least that area (m²): the
 * big occluders (walls, floors, roofs) do the prepass's job — the small
 * detail it leaves out is still depth-tested against them.
 */
export function weldedPositions(geometries: readonly THREE.BufferGeometry[], minArea = 0): THREE.BufferGeometry {
  let vertexBudget = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexBudget += g.getAttribute("position").count;
    indexCount += g.index ? g.index.count : g.getAttribute("position").count;
  }
  let cap = 16;
  while (cap < vertexBudget * 2) cap <<= 1;
  const mask = cap - 1;
  const slots = new Int32Array(cap).fill(-1);
  const out = new Float32Array(vertexBudget * 3);
  const outBits = new Uint32Array(out.buffer);
  const index = new Uint32Array(indexCount);
  const scratch = new Float32Array(3);
  const scratchBits = new Uint32Array(scratch.buffer);
  let vertices = 0;
  let w = 0;
  for (const g of geometries) {
    const src = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const srcIndex = g.index;
    const n = srcIndex ? srcIndex.count : src.length / 3;
    // Map of this geometry's vertices → welded ids (computed lazily).
    const local = new Int32Array(src.length / 3).fill(-1);
    for (let i = 0; i < n; i++) {
      const v = srcIndex ? srcIndex.getX(i) : i;
      if (i % 3 === 0 && minArea > 0) {
        const b = srcIndex ? srcIndex.getX(i + 1) : i + 1;
        const c = srcIndex ? srcIndex.getX(i + 2) : i + 2;
        if (triangleArea(src, v, b, c) < minArea) {
          i += 2; // the whole triangle is left out
          continue;
        }
      }
      let id = local[v];
      if (id < 0) {
        scratch[0] = src[v * 3];
        scratch[1] = src[v * 3 + 1];
        scratch[2] = src[v * 3 + 2];
        const a = scratchBits[0];
        const b = scratchBits[1];
        const c = scratchBits[2];
        let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) & mask;
        for (;;) {
          const s = slots[h];
          if (s < 0) {
            id = vertices++;
            slots[h] = id;
            outBits[id * 3] = a;
            outBits[id * 3 + 1] = b;
            outBits[id * 3 + 2] = c;
            break;
          }
          if (outBits[s * 3] === a && outBits[s * 3 + 1] === b && outBits[s * 3 + 2] === c) {
            id = s;
            break;
          }
          h = (h + 1) & mask;
        }
        local[v] = id;
      }
      index[w++] = id;
    }
  }
  const used = index.subarray(0, w);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(out.slice(0, vertices * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(vertices <= 65535 ? new Uint16Array(used) : used.slice(), 1));
  return geometry;
}

export interface DepthPrepassOptions {
  /** Materials whose onBeforeCompile is known not to move vertices (MapUberMaterial). */
  knownPatch?: (m: THREE.Material) => boolean;
  /** Only the triangles of at least this area (m²) — 0 = every triangle. */
  minArea?: number;
  /** One proxy per grid cell and side (≤ 2 × cells draws) instead of one per side (≤ 2 draws). */
  cells?: boolean;
}

/**
 * The depth prepass of a set of static opaque meshes (the map batches + the
 * backdrop): add `group` to the world scene (the proxies are drawn with an
 * identity world matrix, like those meshes — a mesh with any other world
 * matrix is refused). One position-only proxy per face side (`cells`: per
 * grid cell and side, front-to-back sorted and frustum-culled by three like
 * the batches).
 */
export class GivreDepthPrepass {
  readonly group = new THREE.Group();
  readonly proxies: THREE.Mesh[] = [];
  /** Batches drawn by the prepass / refused (not eligible). */
  readonly covered: THREE.Mesh[] = [];
  readonly refused: THREE.Mesh[] = [];
  /** Result of the load-time check (verify), null before it ran. */
  verified: { differing: number; pixels: number } | null = null;
  private readonly materials = new Map<THREE.Side, THREE.ShaderMaterial>();

  /** Triangles drawn by the prepass (all proxies). */
  readonly triangles: number;

  constructor(batches: readonly THREE.Mesh[], grid: ChunkGrid, options: DepthPrepassOptions = {}) {
    const knownPatch = options.knownPatch ?? (() => false);
    this.group.name = PREPASS_NAME;
    // A Group's renderOrder is its children's "group order", compared before
    // anything else by the opaque sort: the proxies come first, front to back.
    this.group.renderOrder = PREPASS_GROUP_ORDER;
    this.group.userData.noOutline = true;
    this.group.matrixAutoUpdate = false;
    const bySide = new Map<THREE.Side, THREE.BufferGeometry[]>();
    for (const batch of batches) {
      batch.updateWorldMatrix(true, false);
      if (!prepassEligible(batch, knownPatch) || !isIdentity(batch.matrixWorld)) {
        this.refused.push(batch);
        continue;
      }
      const side = (batch.material as THREE.Material).side;
      const list = bySide.get(side) ?? [];
      list.push(batch.geometry);
      bySide.set(side, list);
      this.covered.push(batch);
    }
    let triangles = 0;
    for (const [side, geometries] of bySide) {
      const welded = weldedPositions(geometries, options.minArea ?? 0);
      if (!welded.index || welded.index.count === 0) continue;
      // ONE proxy per side by default: the grid cells (93 × 110 m) culled
      // no prepass draw in any measured view, so each cell would only add a
      // draw call (CPU) — `options.cells` keeps the per-cell split.
      const parts = options.cells ? splitByGrid(welded, grid) : [{ geometry: welded, cell: -1 }];
      if (parts.length > 1) welded.dispose();
      let material = this.materials.get(side);
      if (!material) {
        material = createPrepassMaterial(side);
        this.materials.set(side, material);
      }
      for (const { geometry } of parts) {
        triangles += geometry.index!.count / 3;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const proxy = new THREE.Mesh(geometry, material);
        proxy.name = PREPASS_NAME;
        proxy.matrixAutoUpdate = false; // identity, like the batches
        proxy.castShadow = false;
        proxy.receiveShadow = false;
        proxy.raycast = () => {}; // never a shot target
        this.group.add(proxy);
        this.proxies.push(proxy);
      }
    }
    this.triangles = triangles;
    for (const batch of this.covered) patchInvariantPosition(batch.material as THREE.Material);
  }

  /** Hidden proxies = the frame without prepass (DEV / bench A/B; the batches keep their invariant patch, a no-op). */
  set enabled(on: boolean) {
    this.group.visible = on;
  }

  get enabled(): boolean {
    return this.group.visible;
  }

  /**
   * Verifies ON THIS GPU that the prepass changes no pixel: from each pose,
   * `frame()` (the whole composer frame) is rendered with and without the
   * prepass and the canvas is read back (RGBA, same task: the drawing buffer
   * is still there) — any difference turns the prepass off for the session.
   * Run once at load (Game.warmUpRendering), after the warm frames. Returns
   * the number of differing pixels (0 = kept on). Same state in both renders
   * (nothing animates in between): only the prepass can make them differ.
   */
  verify(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, frame: () => void, poses: readonly VerifyPose[] = VERIFY_POSES): number {
    const caps = renderer.capabilities as { logarithmicDepthBuffer?: boolean; reversedDepthBuffer?: boolean };
    if (caps.logarithmicDepthBuffer || caps.reversedDepthBuffer) {
      // Another depth path (gl_FragDepth / reversed range) than the proxies': never.
      this.enabled = false;
      this.verified = { differing: -1, pixels: 0 };
      return -1;
    }
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const on = new Uint8Array(w * h * 4);
    const off = new Uint8Array(w * h * 4);
    const read = (out: Uint8Array): void => {
      // The canvas (the composer's last pass draws to it; three's cached
      // bindings already say null — the raw bind also resets READ).
      renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    };
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    let differing = 0;
    try {
      for (const p of poses) {
        camera.position.set(p.x, p.y, p.z);
        camera.quaternion.setFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, "YXZ"));
        camera.updateMatrixWorld(true);
        this.enabled = true;
        frame();
        read(on);
        this.enabled = false;
        frame();
        read(off);
        for (let i = 0; i < on.length; i += 4) {
          if (on[i] !== off[i] || on[i + 1] !== off[i + 1] || on[i + 2] !== off[i + 2] || on[i + 3] !== off[i + 3]) differing++;
        }
      }
    } finally {
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);
      camera.updateMatrixWorld(true);
    }
    this.enabled = differing === 0;
    this.verified = { differing, pixels: w * h * poses.length };
    return differing;
  }

  dispose(): void {
    for (const p of this.proxies) p.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.group.removeFromParent();
  }
}
