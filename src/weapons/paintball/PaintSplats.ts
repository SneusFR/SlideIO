import * as THREE from "three";

/**
 * PAINT SPLATS — what a paintball leaves behind. Purely visual (damage stays in the gameplay code).
 *
 * 1) Surfaces (level geometry): ONE InstancedMesh of quads with a procedural splat shape (blob + droplets,
 *    a different shape per instance from a seed) — 1 draw call for all the splats of the match. PERSISTENT:
 *    splats stay until clearSurfaces() (new round); past maxSurface (4096) the oldest is reused. Optimised for
 *    long matches: a hash grid MERGES a splat landing on an existing one (same wall) instead of stacking quads
 *    (count + overdraw stay low under sustained fire), each new splat uploads only its own instance
 *    (addUpdateRange), the shape / rotation / size come from the shot seed (identical on every client).
 *    No texture, no DecalGeometry, no per-splat allocation.
 * 2) Players (skinned Potato): the paint is stored PER VERTEX (a `paint` attribute rgb + amount) on a per-player
 *    geometry that SHARES every other attribute with the original (no mesh copy). The hit is converted to the
 *    mesh's BIND space (face + barycentric) and spread over the welded vertex neighbourhood, so the paint follows
 *    the animation for free (it is skinned with the mesh). A patched material mixes the paint over the base
 *    colour with a noisy edge (splattery look even on a low-poly body).
 */

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export interface PaintSplatsOptions {
  /** Max surface splats alive (ring buffer: past it, the OLDEST is reused). Default 4096 (1 draw call anyway). */
  maxSurface?: number;
  /** Default surface splat diameter (world metres). */
  surfaceSize?: number;
  /** Offset along the normal (m) against z-fighting (plus polygonOffset). */
  lift?: number;
  /**
   * Merge distance, as a fraction of the splat size: a new splat that lands closer than this to an existing one
   * (same wall: normals within ~25°) REUSES it (new colour on top, grows a little) instead of stacking another
   * quad. Keeps the count and the overdraw low where a burst hits the same spot. 0 = never merge. Default 0.35.
   */
  mergeRadius?: number;
  /** Max growth of a merged splat (x its base size). Default 1.5. */
  maxGrow?: number;
}

/** Small deterministic RNG (same seed -> same splat on every client). */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PaintSplats {
  readonly surfaceMesh: THREE.InstancedMesh;
  private readonly seeds: THREE.InstancedBufferAttribute;
  /** Per-instance spread 0 → 1 (1 = the final splat): a fresh splat spreads out instead of popping in. */
  private readonly spreads: THREE.InstancedBufferAttribute;
  private readonly max: number;
  private next = 0;
  private live = 0;
  private stamp = 0;
  private readonly size: number;
  private readonly lift: number;
  private readonly mergeR: number;
  private readonly maxGrow: number;
  // per instance: centre, normal, base size, growth, rotation, aspect, hash cell
  private readonly cen: Float32Array;
  private readonly nor: Float32Array;
  private readonly base: Float32Array;
  private readonly grow: Float32Array;
  private readonly rot: Float32Array;
  private readonly asp: Float32Array;
  private readonly cellOf: Float64Array;
  private readonly grid = new Map<number, number[]>();
  private readonly painted = new Map<THREE.SkinnedMesh | THREE.Mesh, PaintableMesh>();

  constructor(parent: THREE.Object3D, options: PaintSplatsOptions = {}) {
    const max = (this.max = options.maxSurface ?? 4096);
    this.size = options.surfaceSize ?? 0.32;
    this.lift = options.lift ?? 0.004;
    this.mergeR = options.mergeRadius ?? 0.35;
    this.maxGrow = options.maxGrow ?? 1.5;
    this.cen = new Float32Array(max * 3); this.nor = new Float32Array(max * 3);
    this.base = new Float32Array(max); this.grow = new Float32Array(max);
    this.rot = new Float32Array(max); this.asp = new Float32Array(max * 2);
    this.cellOf = new Float64Array(max).fill(NaN);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.seeds = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.seeds.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSeed", this.seeds);
    this.spreads = new THREE.InstancedBufferAttribute(new Float32Array(max).fill(1), 1);
    this.spreads.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSpread", this.spreads);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aSeed;\nattribute float aSpread;\nvarying float vSeed;\nvarying float vSpread;\nvarying vec2 vSplatP;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSeed = aSeed;\nvSpread = aSpread;\nvSplatP = position.xy * 2.0;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSeed;\nvarying float vSpread;\nvarying vec2 vSplatP;\n" + SPLAT_GLSL)
        .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (splatMask(vSplatP, vSeed, vSpread) < 0.5) discard;");
    };
    mat.customProgramCacheKey = () => "paint-splat-v2";
    this.surfaceMesh = new THREE.InstancedMesh(geo, mat, max);
    this.surfaceMesh.name = "PaintSplats";
    this.surfaceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.surfaceMesh.count = 0;
    this.surfaceMesh.frustumCulled = false;
    this.surfaceMesh.castShadow = false;
    this.surfaceMesh.receiveShadow = true;
    this.surfaceMesh.matrixAutoUpdate = false;
    this.surfaceMesh.raycast = () => {};
    this.surfaceMesh.setColorAt(0, new THREE.Color(1, 1, 1));   // allocate instanceColor
    this.surfaceMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.surfaceMesh);
  }

  /** Surface splats currently alive (<= maxSurface). */
  get surfaceCount(): number { return this.live; }

  /** Default splat size (m): the size used when splatSurface() gets no explicit size. */
  get surfaceBase(): number { return this.size; }

  /**
   * A splat on STATIC level geometry (walls, floor, props that never move). normal = WORLD normal of the hit face.
   * seed: pass the shot seed so every client draws the SAME splat (shape, rotation, size); omitted = random.
   * Persistent: it stays until clearSurfaces() or until maxSurface newer splats pushed it out. Cost of a call:
   * O(1) (hash grid lookup) + a partial GPU upload of that one instance — nothing is re-uploaded in full.
   * spread: initial spread of a NEW splat (0 = a small round puddle, 1 = the final shape); drive it with
   * setSpread() so the paint spreads out (round core, then the fingers, then the satellite drops) instead of
   * popping in as a stamp. A merged splat keeps its current spread.
   * Returns the instance index used.
   */
  splatSurface(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, size = this.size, seed?: number, spread = 1): number {
    const r = seed === undefined ? Math.random : rng(seed);
    const cs = this.size;                                         // hash cell = one default splat
    const ix = Math.floor(point.x / cs), iy = Math.floor(point.y / cs), iz = Math.floor(point.z / cs);
    // 1) merge into a splat already there (same wall) instead of stacking quads
    {
      const best = this.findMerge(point, normal, size);
      if (best >= 0) {
        // SlideIO: the merged splat keeps its SHAPE + ROTATION (no re-seed,
        // no spin) — under sustained fire on one spot the splat under the
        // crosshair stays readable; only the newest colour + a small growth.
        this.grow[best] = Math.min(this.maxGrow, this.grow[best] * 1.08 + 0.02);
        this.surfaceMesh.setColorAt(best, color);                 // the newest paint shows on top
        this.writeMatrix(best);
        this.touch(best);
        return best;
      }
    }
    // 2) new instance (ring buffer: reuses the oldest once full)
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.live = Math.min(this.live + 1, this.max);
    const old = this.cellOf[i];
    if (!Number.isNaN(old)) {
      const l = this.grid.get(old);
      if (l) { const k = l.indexOf(i); if (k >= 0) { l[k] = l[l.length - 1]; l.pop(); } if (!l.length) this.grid.delete(old); }
    }
    const key = cellKey(ix, iy, iz);
    let l = this.grid.get(key);
    if (!l) { l = []; this.grid.set(key, l); }
    l.push(i);
    this.cellOf[i] = key;
    const i3 = i * 3;
    _n.copy(normal).normalize();
    const lift = this.lift + (this.stamp++ % 256) * 2e-6;          // newer on top of older, no z-fight
    this.cen[i3] = point.x + _n.x * lift; this.cen[i3 + 1] = point.y + _n.y * lift; this.cen[i3 + 2] = point.z + _n.z * lift;
    this.nor[i3] = _n.x; this.nor[i3 + 1] = _n.y; this.nor[i3 + 2] = _n.z;
    this.base[i] = size; this.grow[i] = 1;
    this.rot[i] = r() * Math.PI * 2;
    this.asp[i * 2] = 0.8 + r() * 0.45; this.asp[i * 2 + 1] = 0.8 + r() * 0.45;
    this.seeds.setX(i, Math.round(r() * 1000 * 64) / 64); // on the 1/64 grid the shader snaps to (stable shape)
    this.spreads.setX(i, Math.min(1, Math.max(0, spread)));
    this.surfaceMesh.setColorAt(i, color);
    this.writeMatrix(i);
    this.surfaceMesh.count = this.live;
    this.touch(i);
    return i;
  }

  /**
   * Spread of splat `i` (0 = small round puddle → 1 = final shape). Only ever GROWS (a splat several impacts
   * drive, or a merged one already fully spread, never shrinks back). Uploads that one float.
   */
  setSpread(i: number, spread: number): void {
    if (i < 0 || i >= this.max) return;
    const s = Math.min(1, Math.max(0, spread));
    if (s <= this.spreads.getX(i)) return;
    this.spreads.setX(i, s);
    this.spreads.addUpdateRange(i, 1);
    this.spreads.needsUpdate = true;
  }

  /** Current spread of splat `i` (1 = fully spread). */
  spreadOf(i: number): number {
    return i >= 0 && i < this.max ? this.spreads.getX(i) : 1;
  }

  /** Existing splat on the same wall close enough to `point` to merge into, or -1. */
  private findMerge(point: THREE.Vector3, normal: THREE.Vector3, size: number): number {
    if (this.mergeR <= 0) return -1;
    const cs = this.size;
    const ix = Math.floor(point.x / cs), iy = Math.floor(point.y / cs), iz = Math.floor(point.z / cs);
    let best = -1, bestD = size * this.mergeR;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.grid.get(cellKey(ix + dx, iy + dy, iz + dz));
      if (!list) continue;
      for (const j of list) {
        const j3 = j * 3;
        if (this.nor[j3] * normal.x + this.nor[j3 + 1] * normal.y + this.nor[j3 + 2] * normal.z < 0.9) continue;
        const d = Math.hypot(this.cen[j3] - point.x, this.cen[j3 + 1] - point.y, this.cen[j3 + 2] - point.z);
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    return best;
  }

  private writeMatrix(i: number): void {
    const i3 = i * 3;
    _n.set(this.nor[i3], this.nor[i3 + 1], this.nor[i3 + 2]);
    _q.setFromUnitVectors(_z, _n).multiply(_q2.setFromAxisAngle(_z, this.rot[i]));
    const sz = this.base[i] * this.grow[i];
    _s.set(sz * this.asp[i * 2], sz * this.asp[i * 2 + 1], 1);
    _p.set(this.cen[i3], this.cen[i3 + 1], this.cen[i3 + 2]);
    this.surfaceMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
  }

  /** Upload ONLY this instance (matrix + colour + seed + spread) — never the whole buffers. */
  private touch(i: number): void {
    const im = this.surfaceMesh.instanceMatrix, ic = this.surfaceMesh.instanceColor!;
    im.addUpdateRange(i * 16, 16); im.needsUpdate = true;
    ic.addUpdateRange(i * 3, 3); ic.needsUpdate = true;
    this.seeds.addUpdateRange(i, 1); this.seeds.needsUpdate = true;
    this.spreads.addUpdateRange(i, 1); this.spreads.needsUpdate = true;
  }

  /** Remove every surface splat (new round / map change). */
  clearSurfaces(): void {
    this.live = 0; this.next = 0; this.stamp = 0; this.surfaceMesh.count = 0;
    this.grid.clear(); this.cellOf.fill(NaN);
  }

  /** Make a (skinned) character mesh paintable: per-player geometry sharing the original attributes. */
  attach(mesh: THREE.SkinnedMesh | THREE.Mesh): PaintableMesh {
    let p = this.painted.get(mesh);
    if (!p) { p = new PaintableMesh(mesh); this.painted.set(mesh, p); }
    return p;
  }

  /**
   * Paint a character where a ball hit it. Call it with the raycast hit of the SHOT (faceIndex + point on the
   * posed mesh) — or later (when the visual ball arrives) with the face / barycentric stored at shot time.
   */
  paintHit(mesh: THREE.SkinnedMesh | THREE.Mesh, faceIndex: number, bary: THREE.Vector3, color: THREE.Color, radius = 0.075): void {
    this.attach(mesh).paint(faceIndex, bary, color, radius);
  }

  /** Remove the paint of one character mesh — or of everybody (new round). */
  clearCharacter(mesh?: THREE.SkinnedMesh | THREE.Mesh): void {
    if (mesh) this.painted.get(mesh)?.clear();
    else for (const p of this.painted.values()) p.clear();
  }

  /** DEATH: remove all the paint a player carries (every painted mesh under his character root). */
  clearPaintUnder(root: THREE.Object3D): void {
    root.traverse((o) => { const p = this.painted.get(o as THREE.Mesh); if (p) p.clear(); });
  }

  /** Stop tracking a character (despawn): restores its original geometry / material. */
  detach(mesh: THREE.SkinnedMesh | THREE.Mesh): void {
    this.painted.get(mesh)?.dispose();
    this.painted.delete(mesh);
  }

  dispose(): void {
    for (const p of this.painted.values()) p.dispose();
    this.painted.clear();
    this.surfaceMesh.removeFromParent();
    this.surfaceMesh.geometry.dispose();
    (this.surfaceMesh.material as THREE.Material).dispose();
    this.surfaceMesh.dispose();
  }
}

/** Barycentric coordinates of `point` (world) on face `faceIndex` of the POSED mesh (skinning applied). */
export function hitBarycentric(mesh: THREE.Mesh, faceIndex: number, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const idx = mesh.geometry.index;
  const ia = idx ? idx.getX(faceIndex * 3) : faceIndex * 3;
  const ib = idx ? idx.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
  const ic = idx ? idx.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
  mesh.getVertexPosition(ia, _a).applyMatrix4(mesh.matrixWorld);
  mesh.getVertexPosition(ib, _b).applyMatrix4(mesh.matrixWorld);
  mesh.getVertexPosition(ic, _c).applyMatrix4(mesh.matrixWorld);
  return THREE.Triangle.getBarycoord(point, _a, _b, _c, out) ?? out.set(1 / 3, 1 / 3, 1 / 3);
}

/** Per-character paint state (see PaintSplats). */
export class PaintableMesh {
  readonly mesh: THREE.SkinnedMesh | THREE.Mesh;
  private readonly original: THREE.BufferGeometry;
  private readonly originalMaterial: THREE.Material | THREE.Material[];
  private readonly paintAttr: THREE.BufferAttribute;
  private readonly weld: Int32Array;            // vertex -> welded representative
  private readonly members: Int32Array[];       // representative -> its duplicate vertices
  private readonly nbr: Int32Array[];           // representative -> neighbour representatives
  private readonly pos: THREE.BufferAttribute;
  private readonly visited: Int32Array;
  private stamp = 1;
  private readonly queue: Int32Array;

  constructor(mesh: THREE.SkinnedMesh | THREE.Mesh) {
    this.mesh = mesh;
    this.original = mesh.geometry;
    this.originalMaterial = mesh.material;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.original.attributes)) g.setAttribute(name, attr);   // shared
    g.setIndex(this.original.index);
    for (const grp of this.original.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
    g.boundingBox = this.original.boundingBox; g.boundingSphere = this.original.boundingSphere;
    const n = this.original.attributes.position.count;
    this.paintAttr = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.paintAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("paint", this.paintAttr);
    mesh.geometry = g;
    mesh.material = Array.isArray(this.originalMaterial) ? this.originalMaterial.map(patchPaintMaterial) : patchPaintMaterial(this.originalMaterial);
    // ---- weld UV-seam duplicates (identical bind positions) and build the vertex adjacency once
    this.pos = this.original.attributes.position as THREE.BufferAttribute;
    const key = new Map<string, number>();
    this.weld = new Int32Array(n);
    const mem: number[][] = [];
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(this.pos.getX(i) * 1e4)},${Math.round(this.pos.getY(i) * 1e4)},${Math.round(this.pos.getZ(i) * 1e4)}`;
      let r = key.get(k);
      if (r === undefined) { r = i; key.set(k, i); }
      this.weld[i] = r;
      (mem[r] ??= []).push(i);
    }
    this.members = []; const nb: Set<number>[] = [];
    for (let i = 0; i < n; i++) if (mem[i]) this.members[i] = Int32Array.from(mem[i]);
    const index = this.original.index;
    const tri = index ? index.count : n;
    for (let t = 0; t < tri; t += 3) {
      const v0 = this.weld[index ? index.getX(t) : t], v1 = this.weld[index ? index.getX(t + 1) : t + 1], v2 = this.weld[index ? index.getX(t + 2) : t + 2];
      (nb[v0] ??= new Set()).add(v1).add(v2); (nb[v1] ??= new Set()).add(v0).add(v2); (nb[v2] ??= new Set()).add(v0).add(v1);
    }
    this.nbr = [];
    for (let i = 0; i < n; i++) if (nb[i]) this.nbr[i] = Int32Array.from(nb[i]);
    this.visited = new Int32Array(n);
    this.queue = new Int32Array(n);
  }

  /** Spread a splat around the hit (bind space), mixing with the paint already there. */
  paint(faceIndex: number, bary: THREE.Vector3, color: THREE.Color, radius: number): void {
    const idx = this.original.index;
    const ia = idx ? idx.getX(faceIndex * 3) : faceIndex * 3;
    const ib = idx ? idx.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
    const ic = idx ? idx.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
    const P = this.pos;
    const cx = P.getX(ia) * bary.x + P.getX(ib) * bary.y + P.getX(ic) * bary.z;
    const cy = P.getY(ia) * bary.x + P.getY(ib) * bary.y + P.getY(ic) * bary.z;
    const cz = P.getZ(ia) * bary.x + P.getZ(ib) * bary.y + P.getZ(ic) * bary.z;
    const st = ++this.stamp;
    let head = 0, tail = 0;
    for (const v of [ia, ib, ic]) { const r = this.weld[v]; if (this.visited[r] !== st) { this.visited[r] = st; this.queue[tail++] = r; } }
    const seed = Math.random() * 100;
    const a = this.paintAttr.array as Float32Array;
    while (head < tail) {
      const v = this.queue[head++];
      const dx = P.getX(v) - cx, dy = P.getY(v) - cy, dz = P.getZ(v) - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // irregular splat: radius modulated by a few lobes around the hit
      const ang = Math.atan2(dy, dx + dz);
      const rr = radius * (0.8 + 0.25 * Math.sin(ang * 5 + seed) + 0.12 * Math.sin(ang * 9 + seed * 2.3));
      if (d > rr * 1.25) continue;
      const w = Math.min(1, Math.max(0, 1.2 - d / rr));
      for (const m of this.members[v]) {
        const o = m * 4;
        // premultiplied "over": the new ball covers the old paint
        a[o] = color.r * w + a[o] * (1 - w);
        a[o + 1] = color.g * w + a[o + 1] * (1 - w);
        a[o + 2] = color.b * w + a[o + 2] * (1 - w);
        a[o + 3] = w + a[o + 3] * (1 - w);
      }
      const nn = this.nbr[v];
      if (nn) for (let k = 0; k < nn.length; k++) { const u = nn[k]; if (this.visited[u] !== st) { this.visited[u] = st; this.queue[tail++] = u; } }
    }
    this.paintAttr.needsUpdate = true;
  }

  clear(): void {
    (this.paintAttr.array as Float32Array).fill(0);
    this.paintAttr.needsUpdate = true;
  }

  dispose(): void {
    const mats = this.mesh.material;
    this.mesh.geometry = this.original;
    this.mesh.material = this.originalMaterial;
    (Array.isArray(mats) ? mats : [mats]).forEach((m) => m.dispose());
    this.paintAttr.array = new Float32Array(0);
  }
}

/** Clone a character material and mix the per-vertex paint over its base colour (noisy splattery edge). */
export function patchPaintMaterial(src: THREE.Material): THREE.Material {
  const m = src.clone();
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 paint;\nvarying vec4 vPaint;\nvarying vec3 vPaintPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPaint = paint;\nvPaintPos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec4 vPaint;\nvarying vec3 vPaintPos;\n" + NOISE_GLSL)
      .replace("#include <color_fragment>", `#include <color_fragment>
      {
        float n = vnoise(vPaintPos * 38.0) * 0.55 + vnoise(vPaintPos * 90.0) * 0.25;
        float mask = smoothstep(0.42, 0.52, vPaint.a * 0.9 + n * 0.45 - 0.08);
        diffuseColor.rgb = mix(diffuseColor.rgb, vPaint.rgb / max(vPaint.a, 1e-3), mask);
      }`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, step(0.5, vPaint.a));");
  };
  const key = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (key ? key() : "") + "|paint-v1";
  return m;
}

const SPLAT_GLSL = /* glsl */ `
// spread 0 → 1: the paint SPREADS OUT (never a stamp): a small round puddle grows to the full core (0 → 0.5),
// the fingers push out of it (0.2 → 0.85), the satellite drops land last, flying outward (0.45 → 0.95).
// spread = 1 is exactly the final splat shape.
float splatMask(vec2 p, float seedIn, float spread) {
  // The seed is a per-instance constant, but its interpolated varying drifts by a few ulps from one fragment
  // to the next, and fract(sin(x) * 43758) amplifies that into speckles on the satellite drops: snap it back
  // to the 1/64 grid it is stored on (PaintSplats.splatSurface).
  float seed = floor(seedIn * 64.0 + 0.5) / 64.0;
  float s = clamp(spread, 0.0, 1.0);
  float core = smoothstep(0.0, 0.5, s);
  float fingers = smoothstep(0.2, 0.85, s);
  float r = length(p);
  float a = atan(p.y, p.x);
  // Shape variants per seed: lobe counts (4..6, 8..10), lobe depth and the number of satellite droplets all change.
  float f1 = 4.0 + floor(fract(seed * 7.31) * 3.0);
  float f2 = 8.0 + floor(fract(seed * 3.17) * 3.0);
  float amp = 0.10 + 0.10 * fract(seed * 1.713);
  float lobes = amp * sin(a * f1 + seed * 6.283) + 0.09 * sin(a * f2 + seed * 12.1) + 0.05 * sin(a * 15.0 + seed * 3.7);
  float edge = 0.52 * mix(0.35, 1.0, core) + lobes * fingers;
  float m = step(r, edge);
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    if (fract(seed * 13.7 + fk * 0.37) < 0.25) continue;
    float sat = smoothstep(0.45 + 0.07 * fk, 0.8 + 0.03 * fk, s);
    if (sat <= 0.0) continue;
    float ang = seed * 31.0 + fk * 1.9;
    float dist = (0.62 + 0.3 * fract(sin(seed * 7.3 + fk * 12.9898) * 43758.5453)) * mix(0.55, 1.0, sat);
    vec2 c = vec2(cos(ang), sin(ang)) * dist;
    float rad = (0.04 + 0.07 * fract(sin(seed * 3.1 + fk * 78.233) * 43758.5453)) * sat;
    m = max(m, step(length(p - c), rad));
  }
  return m;
}`;

const NOISE_GLSL = /* glsl */ `
float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n000 = h31(i), n100 = h31(i + vec3(1,0,0)), n010 = h31(i + vec3(0,1,0)), n110 = h31(i + vec3(1,1,0));
  float n001 = h31(i + vec3(0,0,1)), n101 = h31(i + vec3(1,0,1)), n011 = h31(i + vec3(0,1,1)), n111 = h31(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}`;

/** Integer key of a hash-grid cell — exact (< 2^53) for |cell index| < 65536, i.e. maps up to ~20 km at 0.32 m cells. */
function cellKey(x: number, y: number, z: number): number {
  return ((x + 65536) * 131072 + (y + 65536)) * 131072 + (z + 65536);
}
