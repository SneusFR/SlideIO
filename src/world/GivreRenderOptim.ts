import * as THREE from "three";

/**
 * GIVRE rendering optimisations — helpers without asset import, so they run
 * in the browser (GivreMap / Game) AND headless in Node
 * (scripts/test-givre-render-optim.mts). Only buildLimitedMipmaps needs the
 * DOM (it returns null without it).
 *
 *  1. SPATIAL CHUNKS: the static map used to be merged into ONE mesh per
 *     material, each spanning the whole 280 × 220 m map — nothing could ever
 *     be frustum-culled and the opaque sort could not draw near → far. Every
 *     large merged material is now split on a coarse XZ grid (triangle
 *     centroid → cell): off-screen cells are culled, the rest drawn
 *     front-to-back.
 *  2. SINGLE-SIDED SOLIDS: every glb material is doubleSided. Closed,
 *     consistently wound, OUTWARD-facing meshes too thin to ever contain the
 *     camera (crates, slabs, posts, bulbs…) are drawn FrontSide: identical
 *     image from outside, half the rasterised triangles (main pass AND
 *     shadow pass). Open surfaces (most walls / ground) stay DoubleSide.
 *  3. FRONT-TO-BACK opaque sort (renderer.setOpaqueSort): three's default
 *     sort groups by material BEFORE depth, which defeats early-Z on a map
 *     whose meshes overlap in screen space.
 *  4. Short mip chain for the 2048² baked lightmaps (buildLimitedMipmaps).
 */

/** XZ grid over the map (metres). */
export interface ChunkGrid {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cellsX: number;
  cellsZ: number;
}

/** One static source mesh, already in WORLD space (winding already fixed). */
export interface StaticEntry {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** One draw call of the optimised static map. */
export interface StaticBatch {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Grid cell index (−1 = not split). */
  cell: number;
  /** True when drawn with the FrontSide clone of the glb material. */
  singleSided: boolean;
}

export interface StaticBatchOptions {
  grid: ChunkGrid;
  /** Materials (per side variant) with fewer triangles stay one mesh. */
  chunkMinTriangles: number;
  /**
   * Closed outward meshes whose SMALLEST bounding-box side is at most this
   * (m) are drawn single-sided. ≤ 0 disables the optimisation.
   */
  singleSidedMaxThickness: number;
  /** Material names that must never be cloned (mutated at runtime). */
  keepMaterials?: ReadonlySet<string>;
}

/** Triangle count of a (possibly indexed) geometry. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  return Math.floor((index ? index.count : geometry.getAttribute("position").count) / 3);
}

/** Grid cell of an XZ point (clamped to the grid). */
export function cellOf(grid: ChunkGrid, x: number, z: number): number {
  const fx = (x - grid.minX) / (grid.maxX - grid.minX);
  const fz = (z - grid.minZ) / (grid.maxZ - grid.minZ);
  const ix = Math.min(grid.cellsX - 1, Math.max(0, Math.floor(fx * grid.cellsX)));
  const iz = Math.min(grid.cellsZ - 1, Math.max(0, Math.floor(fz * grid.cellsZ)));
  return iz * grid.cellsX + ix;
}


/**
 * True when the geometry is a CLOSED 2-manifold with CONSISTENT winding
 * whose triangles face OUTWARD (positive signed volume): its back faces are
 * then never visible from outside, so FrontSide rendering is exact.
 * Positions are welded at `weldEpsilon` (glTF splits vertices on UV / normal
 * seams). Every directed edge must appear exactly once and its reverse
 * exactly once — this rejects holes, T-junctions, non-manifold edges and
 * flipped triangles in one pass. Conservative: any doubt → false.
 */
export function isClosedOutward(geometry: THREE.BufferGeometry, weldEpsilon = 1e-3): boolean {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const n = index ? index.count : pos.count;
  if (n < 12) return false; // a closed solid needs at least 4 triangles

  const inv = 1 / weldEpsilon;
  const weld = new Map<string, number>();
  const ids = new Int32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    const key = `${Math.round(pos.getX(v) * inv)}_${Math.round(pos.getY(v) * inv)}_${Math.round(pos.getZ(v) * inv)}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    ids[v] = id;
  }
  const count = weld.size;

  const directed = new Set<number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume6 = 0;
  for (let i = 0; i < n; i += 3) {
    const va = index ? index.getX(i) : i;
    const vb = index ? index.getX(i + 1) : i + 1;
    const vc = index ? index.getX(i + 2) : i + 2;
    const ia = ids[va];
    const ib = ids[vb];
    const ic = ids[vc];
    if (ia === ib || ib === ic || ia === ic) return false; // degenerate
    for (const key of [ia * count + ib, ib * count + ic, ic * count + ia]) {
      if (directed.has(key)) return false; // non-manifold or inconsistent winding
      directed.add(key);
    }
    a.fromBufferAttribute(pos, va);
    b.fromBufferAttribute(pos, vb);
    c.fromBufferAttribute(pos, vc);
    volume6 += a.dot(b.cross(c)); // 6 × signed volume of (origin, A, B, C)
  }
  for (const key of directed) {
    const u = Math.floor(key / count);
    const v = key - u * count;
    if (!directed.has(v * count + u)) return false; // open edge
  }
  return volume6 > 0;
}

type TypedArrayCtor = new (length: number) => THREE.TypedArray;

/**
 * Splits a geometry into one compact geometry per grid cell (triangle
 * centroid → cell). Every attribute is copied verbatim (raw array values:
 * normalized / integer attributes stay exact). Returns the INPUT geometry
 * alone (cell −1) when every triangle falls in a single cell.
 */
export function splitByGrid(
  geometry: THREE.BufferGeometry,
  grid: ChunkGrid,
): { geometry: THREE.BufferGeometry; cell: number }[] {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const tris = triangleCount(geometry);
  const vertexOf = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  const cells = new Int32Array(tris);
  const counts = new Map<number, number>();
  for (let t = 0; t < tris; t++) {
    let x = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(t, k);
      x += pos.getX(v);
      z += pos.getZ(v);
    }
    const cell = cellOf(grid, x / 3, z / 3);
    cells[t] = cell;
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  if (counts.size <= 1) return [{ geometry, cell: -1 }];

  // mergeGeometries outputs plain attributes; anything else is rejected.
  const sources: [string, THREE.BufferAttribute][] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name);
    if (!(attr instanceof THREE.BufferAttribute)) return [{ geometry, cell: -1 }];
    sources.push([name, attr]);
  }

  const remap = new Int32Array(pos.count);
  const out: { geometry: THREE.BufferGeometry; cell: number }[] = [];
  for (const [cell, n] of [...counts].sort((p, q) => p[0] - q[0])) {
    remap.fill(-1);
    const indices = new Uint32Array(n * 3);
    let vertexCount = 0;
    let w = 0;
    for (let t = 0; t < tris; t++) {
      if (cells[t] !== cell) continue;
      for (let k = 0; k < 3; k++) {
        const v = vertexOf(t, k);
        if (remap[v] < 0) remap[v] = vertexCount++;
        indices[w++] = remap[v];
      }
    }
    const part = new THREE.BufferGeometry();
    for (const [name, src] of sources) {
      const size = src.itemSize;
      const srcArray = src.array as THREE.TypedArray;
      const dst = new (srcArray.constructor as TypedArrayCtor)(vertexCount * size);
      for (let v = 0; v < remap.length; v++) {
        const r = remap[v];
        if (r < 0) continue;
        for (let c = 0; c < size; c++) dst[r * size + c] = srcArray[v * size + c];
      }
      part.setAttribute(name, new THREE.BufferAttribute(dst, size, src.normalized));
    }
    part.setIndex(new THREE.BufferAttribute(vertexCount <= 65535 ? new Uint16Array(indices) : indices, 1));
    out.push({ geometry: part, cell });
  }
  return out;
}

/** Smallest side of the geometry's bounding box (m). */
function minExtent(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  return Math.min(size.x, size.y, size.z);
}

/** May this source mesh be drawn single-sided? (see isClosedOutward) */
export function canBeSingleSided(
  entry: StaticEntry,
  maxThickness: number,
  keepMaterials: ReadonlySet<string>,
): boolean {
  const m = entry.material;
  if (maxThickness <= 0) return false;
  if (m.side !== THREE.DoubleSide || m.transparent || keepMaterials.has(m.name)) return false;
  if (minExtent(entry.geometry) > maxThickness) return false; // could contain the camera
  return isClosedOutward(entry.geometry);
}

/**
 * Builds the static draw batches: entries grouped by (material, side),
 * merged, then split on the grid when large enough. The FrontSide variant of
 * a material is a CLONE (same name, same textures / colours — only `side`
 * differs; ONE clone per material). Input geometries are NOT disposed.
 */
export function buildStaticBatches(
  entries: readonly StaticEntry[],
  merge: (geometries: THREE.BufferGeometry[]) => THREE.BufferGeometry | null,
  options: StaticBatchOptions,
): StaticBatch[] {
  const keep = options.keepMaterials ?? new Set<string>();
  const groups = new Map<THREE.Material, { singleSided: boolean; geometries: THREE.BufferGeometry[] }>();
  const frontClones = new Map<THREE.Material, THREE.Material>();
  for (const entry of entries) {
    const single = canBeSingleSided(entry, options.singleSidedMaxThickness, keep);
    let material = entry.material;
    if (single) {
      let clone = frontClones.get(material);
      if (!clone) {
        clone = material.clone();
        clone.name = material.name;
        clone.side = THREE.FrontSide;
        // Shadow caster: the faces turned toward the sun are the nearest to
        // the light on a closed solid → FrontSide writes exactly the depth
        // DoubleSide wrote (three's default would cast with BackSide here).
        clone.shadowSide = THREE.FrontSide;
        frontClones.set(material, clone);
      }
      material = clone;
    }
    const group = groups.get(material) ?? { singleSided: single, geometries: [] };
    group.geometries.push(entry.geometry);
    groups.set(material, group);
  }

  const out: StaticBatch[] = [];
  for (const [material, { singleSided, geometries }] of groups) {
    const merged = merge(geometries);
    if (!merged) throw new Error(`GivreRenderOptim: merge failed for material ${material.name}`);
    const parts =
      triangleCount(merged) >= options.chunkMinTriangles
        ? splitByGrid(merged, options.grid)
        : [{ geometry: merged, cell: -1 }];
    if (parts.length > 1) merged.dispose();
    for (const part of parts) out.push({ geometry: part.geometry, material, cell: part.cell, singleSided });
  }
  return out;
}

/**
 * MeshPhysicalMaterial → MeshStandardMaterial with the SAME colours,
 * textures (baked emissive + ao), roughness, side, transparency and name.
 * GLTFLoader only creates Physical materials in givre_01.glb for
 * KHR_materials_specular (no clearcoat / sheen / transmission / iridescence):
 * the only visible change is the specular level (Standard = fixed 4 % F0,
 * a faint highlight on matte surfaces). Other materials are returned as-is.
 */
export function toStandardMaterial(material: THREE.Material): THREE.Material {
  const physical = material as THREE.MeshPhysicalMaterial;
  if (!physical.isMeshPhysicalMaterial) return material;
  const standard = new THREE.MeshStandardMaterial();
  standard.copy(physical); // MeshStandardMaterial.copy resets defines to STANDARD
  standard.name = physical.name;
  standard.userData = { ...physical.userData };
  return standard;
}

/**
 * Limited mip chain for the baked lightmaps (givre_lumiere / givre_ao).
 * They used to have NO mipmap at all (a full mip chain makes the UV islands
 * of the atlas bleed into each other in the distance): every distant pixel
 * then sampled the 2048² level 0 → texture-cache thrashing, a real cost on
 * integrated GPUs. A SHORT chain (2048 → 1024 → 512 by default) keeps the
 * bleed within a few texels (well inside a usual bake margin) while
 * distant surfaces read a 4–16× smaller level.
 * Returns the levels (level 0 = the original image) or null when the image
 * cannot be downscaled here (Node, missing DOM, odd size) — the caller then
 * keeps the previous no-mipmap setup.
 */
export function buildLimitedMipmaps(image: unknown, levels: number): unknown[] | null {
  if (levels <= 1 || typeof document === "undefined") return null;
  const src = image as { width?: number; height?: number } | null;
  const w = src?.width ?? 0;
  const h = src?.height ?? 0;
  if (w < 2 || h < 2) return null;
  const out: unknown[] = [image];
  let prev = image as CanvasImageSource;
  let pw = w;
  let ph = h;
  for (let i = 1; i < levels && pw > 1 && ph > 1; i++) {
    const nw = Math.max(1, pw >> 1);
    const nh = Math.max(1, ph >> 1);
    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(prev, 0, 0, pw, ph, 0, 0, nw, nh); // box-ish 2:1 downscale
    out.push(canvas);
    prev = canvas;
    pw = nw;
    ph = nh;
  }
  return out;
}

/**
 * Opaque sort for Givre: renderOrder first (stencil / outline contracts are
 * kept), then strictly FRONT-TO-BACK (early-Z rejects the rooms hidden
 * behind the walls), material only as a tie-break.
 */
export function frontToBackOpaqueSort(a: THREE.RenderItem, b: THREE.RenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return a.z - b.z;
  // Material.id exists at runtime (three's own painter sort uses it) but is
  // not declared by @types/three.
  const ma = (a.material as THREE.Material & { id: number }).id;
  const mb = (b.material as THREE.Material & { id: number }).id;
  if (ma !== mb) return ma - mb;
  return a.id - b.id;
}

