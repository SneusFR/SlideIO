import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PickupConfig as pc } from "./PickupConfig";

/**
 * Medkit model (public/assets/medkit.glb, served as-is by Vite from
 * /public — same convention as the credit coin below).
 * Low-poly (~4.6k tris), untextured: one flat-colored primitive per color
 * (red case, cream cross, shine, ink outline, cyan details).
 */
const medkitUrl = "/assets/medkit.glb";

/**
 * Coin model = the "credit" coin (public/assets/credit.glb, served as-is
 * by Vite from /public — same path convention as the audio assets).
 * Low-poly (~5.5k tris), untextured: one flat-colored primitive per color.
 */
const coinUrl = "/assets/credit.glb";

/**
 * GLB templates for the loot pickups.
 *
 * Each model is fetched + parsed EXACTLY ONCE (same pipeline as the
 * weapon viewmodels: optimized *_opt.glb + GLTFLoader). Every drop in
 * the world is a cheap `clone()` of the prepared template — geometry
 * and materials are shared between all instances, nothing is ever
 * re-downloaded or re-parsed on a kill.
 */
export class PickupAssets {
  medkitTemplate: THREE.Group | null = null;
  coinTemplate: THREE.Group | null = null;
  /** Resolves once BOTH templates finished loading (or failed — never rejects). */
  ready: Promise<void> = Promise.resolve();

  private started = false;

  /** Kick the one-time loads (call once at game startup). */
  load(): void {
    if (this.started) return;
    this.started = true;
    const loader = new GLTFLoader();
    const medkit = new Promise<void>((resolve) => {
      loader.load(
        medkitUrl,
        (gltf) => {
          this.medkitTemplate = normalizeTemplate(
            gltf.scene,
            pc.medkitSize,
            pc.medkitGlowColor,
            // Already low-poly: grid clustering would wreck its flat
            // color shapes (cross, shine, ink outline).
            { decimate: false },
          );
          resolve();
        },
        undefined,
        (err) => {
          console.warn("[pickups] medkit GLB failed to load", err);
          resolve();
        },
      );
    });
    const coin = new Promise<void>((resolve) => {
      loader.load(
        coinUrl,
        (gltf) => {
          this.coinTemplate = normalizeTemplate(
            gltf.scene,
            pc.coinSize,
            pc.coinGlowColor,
            // Already low-poly: grid clustering would wreck its flat
            // color shapes (bean, shine, rim stripes).
            { decimate: false },
          );
          resolve();
        },
        undefined,
        (err) => {
          console.warn("[pickups] coin GLB failed to load", err);
          resolve();
        },
      );
    });
    this.ready = Promise.all([medkit, coin]).then(() => undefined);
  }
}

/**
 * Scale the raw model to the target gameplay size and center it at the
 * origin so pickups can position/rotate it trivially. Done once per GLB.
 * Also makes the pickup GLOW: the GLB materials become self-lit (their
 * own texture re-used as an emissive map) and an additive halo sprite is
 * baked into the template so every clone reads from across the map.
 */
function normalizeTemplate(
  model: THREE.Group,
  targetSize: number,
  glowColor: number,
  options: { decimate?: boolean } = {},
): THREE.Group {
  const decimate = options.decimate ?? true;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  model.scale.setScalar(targetSize / maxDim);

  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Collectables don't need high-poly meshes: decimate ONCE on the
      // template (every drop clones it) — dozens of coins on the ground
      // used to push millions of triangles and tank the framerate.
      if (decimate) decimateMeshGeometry(mesh);
      // Shared materials: mark them so per-bot dispose logic elsewhere
      // never destroys them by accident.
      const mat = mesh.material as THREE.Material;
      if (mat) {
        mat.userData.shared = true;
        // Self-illumination: reuse the albedo texture as an emissive map
        // so the pickup glows with its own colors even in shadow.
        // Untextured materials (credit coin, medkit) glow with their base color
        // instead — a plain white emissive would wash them out to white.
        if (mat instanceof THREE.MeshStandardMaterial) {
          if (mat.map) {
            mat.emissiveMap = mat.map;
            mat.emissive.setHex(0xffffff);
          } else {
            mat.emissive.copy(mat.color);
          }
          mat.emissiveIntensity = pc.glowEmissiveIntensity;
          mat.needsUpdate = true;
        }
      }
    }
  });
  mergeFlatColorParts(model);

  const wrapper = new THREE.Group();
  wrapper.add(model);
  wrapper.add(makeHaloSprite(targetSize, glowColor));
  // Loot is never cel-outlined (Givre white rim) — children included.
  // userData is copied by clone(), so every drop inherits the flag.
  wrapper.userData.noOutline = true;
  return wrapper;
}

/**
 * PERF — ONE MESH PER LOOT KIND. The credit coin and the medkit GLBs are a
 * single mesh split into one primitive per flat colour (6 / 5 primitives →
 * as many instanced draw calls per loot kind, every frame loot lies on the
 * ground). Their materials only differ by the base colour (untextured, same
 * roughness / metalness / side, glow emissive = base colour): the parts are
 * merged into one geometry whose VERTEX COLOUR carries each part's base
 * colour, and the emissive follows the vertex colour too (tiny shader
 * patch) — the exact same shading, one draw per loot kind.
 * Anything unexpected (textures, different roughness, transforms on
 * different parents…) → the template is left untouched.
 */
function mergeFlatColorParts(model: THREE.Object3D): void {
  const parts: THREE.Mesh[] = [];
  let ok = true;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) ok = false;
    parts.push(mesh);
  });
  if (!ok || parts.length < 2) return;
  const parent = parts[0].parent;
  const mats = parts.map((m) => m.material as THREE.MeshStandardMaterial);
  const first = mats[0];
  const flat = (m: THREE.MeshStandardMaterial) =>
    !Array.isArray(m) &&
    m instanceof THREE.MeshStandardMaterial &&
    !(m as THREE.MeshStandardMaterial & { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial &&
    !m.map && !m.normalMap && !m.bumpMap && !m.roughnessMap && !m.metalnessMap && !m.emissiveMap &&
    !m.aoMap && !m.alphaMap && !m.lightMap && !m.envMap && !m.displacementMap &&
    !m.transparent && !m.vertexColors && !m.flatShading && !m.wireframe &&
    m.opacity === 1 && m.alphaTest === 0 &&
    m.roughness === first.roughness && m.metalness === first.metalness &&
    m.side === first.side && m.emissiveIntensity === first.emissiveIntensity &&
    m.emissive.equals(m.color) &&
    m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile;
  if (!parent || !parts.every((p) => p.parent === parent) || !mats.every(flat)) return;

  const pieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const src = parts[i].geometry;
    const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
    const normal = src.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (!pos || !normal || src.groups.length > 1 || Object.keys(src.morphAttributes).length > 0) break;
    // Compact copy of the part: only the vertices its triangles use (the
    // primitives of one glTF mesh share a single vertex buffer).
    const index = src.getIndex();
    const start = src.drawRange.start;
    const end = Math.min(index ? index.count : pos.count, start + src.drawRange.count);
    const remap = new Map<number, number>();
    const outPos: number[] = [];
    const outNormal: number[] = [];
    const outIndex: number[] = [];
    for (let k = start; k < end; k++) {
      const v = index ? index.getX(k) : k;
      let n = remap.get(v);
      if (n === undefined) {
        n = outPos.length / 3;
        remap.set(v, n);
        outPos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        outNormal.push(normal.getX(v), normal.getY(v), normal.getZ(v));
      }
      outIndex.push(n);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(outNormal, 3));
    const c = mats[i].color; // linear, like vertex colours
    const colors = new Float32Array(outPos.length);
    for (let k = 0; k < colors.length; k += 3) {
      colors[k] = c.r;
      colors[k + 1] = c.g;
      colors[k + 2] = c.b;
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(outIndex);
    // Same placement under the shared parent as the part itself.
    parts[i].updateMatrix();
    g.applyMatrix4(parts[i].matrix);
    if (parts[i].matrix.determinant() < 0) {
      // Mirrored part: keep the triangles front-facing after the bake.
      const idx = g.getIndex()!;
      for (let k = 0; k + 2 < idx.count; k += 3) {
        const b = idx.getX(k + 1);
        idx.setX(k + 1, idx.getX(k + 2));
        idx.setX(k + 2, b);
      }
    }
    pieces.push(g);
  }
  if (pieces.length !== parts.length) {
    pieces.forEach((g) => g.dispose());
    return;
  }
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (!geometry) return;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    name: `${first.name || "pickup"}_merged`,
    color: 0xffffff,
    vertexColors: true,
    roughness: first.roughness,
    metalness: first.metalness,
    side: first.side,
    emissive: 0xffffff,
    emissiveIntensity: first.emissiveIntensity,
  });
  // Glow = base colour (vertex colour) × intensity, as on every former part.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;",
    );
  };
  material.customProgramCacheKey = () => "pickup-flat-merged";
  material.userData.shared = true;

  const merged = new THREE.Mesh(geometry, material);
  merged.name = "pickup_merged";
  merged.castShadow = false;
  merged.receiveShadow = false;
  parent.add(merged);
  for (const p of parts) {
    p.removeFromParent();
    p.geometry.dispose();
  }
  for (const m of new Set(mats)) m.dispose();
}

/**
 * Simplify a mesh's geometry with GRID VERTEX CLUSTERING: every vertex
 * inside the same cell of a regular 3D grid collapses onto one
 * representative vertex; triangles whose corners merge become degenerate
 * and are dropped, duplicated result-triangles are emitted only once.
 *
 * O(n), runs once per template at load time. Coarse by design — these are
 * small glowing collectables, silhouette + texture read is all that
 * matters (coin: ~44k tris → ~2k, medkit: ~31k tris → ~2k).
 */
function decimateMeshGeometry(mesh: THREE.Mesh): void {
  const src = mesh.geometry as THREE.BufferGeometry;
  const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < pc.meshDecimateMinVertices) return;
  const normal = src.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const uv = src.getAttribute("uv") as THREE.BufferAttribute | undefined;

  src.computeBoundingBox();
  const bb = src.boundingBox!;
  const g = pc.meshDecimateGrid;
  const maxAxis = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1e-6);
  const cell = maxAxis / g; // cubic cells sized from the largest axis

  // ---- Cluster: map every source vertex to its cell representative ----
  const cellToRep = new Map<string, number>();
  const vertexRep = new Uint32Array(pos.count);
  const outPos: number[] = [];
  const outNormal: number[] = [];
  const outUv: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const cx = Math.floor((pos.getX(i) - bb.min.x) / cell);
    const cy = Math.floor((pos.getY(i) - bb.min.y) / cell);
    const cz = Math.floor((pos.getZ(i) - bb.min.z) / cell);
    const key = `${cx},${cy},${cz}`;
    let rep = cellToRep.get(key);
    if (rep === undefined) {
      rep = outPos.length / 3;
      cellToRep.set(key, rep);
      outPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (normal) outNormal.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (uv) outUv.push(uv.getX(i), uv.getY(i));
    }
    vertexRep[i] = rep;
  }

  // ---- Rebuild the index: drop degenerates + deduplicate triangles ----
  const index = src.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;
  const outIndex: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const a = vertexRep[i0];
    const b = vertexRep[i1];
    const c = vertexRep[i2];
    if (a === b || b === c || a === c) continue; // collapsed → drop
    // Orientation-preserving canonical key (smallest vertex first).
    const key =
      a < b && a < c ? `${a},${b},${c}` : b < c ? `${b},${c},${a}` : `${c},${a},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outIndex.push(a, b, c);
  }
  if (outIndex.length === 0) return; // safety: keep the original mesh

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
  if (normal) geom.setAttribute("normal", new THREE.Float32BufferAttribute(outNormal, 3));
  if (uv) geom.setAttribute("uv", new THREE.Float32BufferAttribute(outUv, 2));
  geom.setIndex(outIndex);
  if (!normal) geom.computeVertexNormals();
  geom.computeBoundingSphere();

  mesh.geometry = geom;
  src.dispose();
}

/**
 * Soft additive radial-gradient billboard — a cheap "bloom" halo around
 * the pickup. The texture and material are created once per template and
 * shared by every clone (Sprite.clone() shares its material).
 */
function makeHaloSprite(targetSize: number, glowColor: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getHaloTexture(),
    color: glowColor,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: pc.glowHaloOpacity,
    depthWrite: false,
  });
  mat.userData.shared = true;
  const sprite = new THREE.Sprite(mat);
  const d = targetSize * pc.glowHaloScale;
  sprite.scale.set(d, d, 1);
  return sprite;
}

let haloTexture: THREE.Texture | null = null;

/** Lazily build the shared radial gradient texture (64px canvas). */
function getHaloTexture(): THREE.Texture {
  if (haloTexture) return haloTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(0.7, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(canvas);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}