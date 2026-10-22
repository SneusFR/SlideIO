// GivreDepthPrepass — headless checks on the REAL givre_01.glb (no DOM / WebGL).
// Usage (repo root):  npx --prefix backend tsx scripts/test-givre-depth-prepass.mts
//   1. depthPrepassWanted: config default, ?diag=prepass / noprepass;
//   2. prepassEligible: plain opaque meshes only (every refusal case);
//   3. weldedPositions: exact-bit welding, every triangle's vertices unchanged and in order;
//   4. the prepass of the real static batches + the backdrop (givre_01_fond.glb), built like
//      GivreMap: one proxy per face side (`cells`: per grid cell and side, same triangles),
//      depth-only material per side, drawn first (group order), identity matrices, never a
//      shadow caster / shot target, and EXACTLY the covered meshes' triangles per side (bit
//      patterns of the positions, vertex order kept; ≥ minArea); the covered materials declare
//      `invariant gl_Position` (new program cache key), the refused ones are left untouched;
//      the load-time check (verify) with a fake renderer; the map's specialised shader swapped in
//      afterwards (clones: the invariant patch is lost) and put back by repatch;
//   5. same position computation: the proxy's vertex shader is three's begin_vertex +
//      project_vertex, and between those two chunks the standard / physical shader only has
//      chunks that are inactive for a plain mesh (morph targets, skinning, displacement) + the
//      uber varyings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildStaticBatches, toStandardMaterial, worldSpaceCopy, type ChunkGrid, type StaticEntry } from "../src/world/GivreRenderOptim.ts";
import { applyUberMaterial, MapUberMaterial } from "../src/world/MapBatching.ts";
import {
  GivreDepthPrepass,
  PREPASS_FRAGMENT_SHADER,
  PREPASS_GROUP_ORDER,
  PREPASS_NAME,
  PREPASS_VERTEX_SHADER,
  depthPrepassWanted,
  hasInvariantPosition,
  isIdentity,
  patchInvariantPosition,
  prepassEligible,
  unpatchInvariantPosition,
  weldedPositions,
} from "../src/world/GivreDepthPrepass.ts";
import { applyMapShader, MAP_SHADER_EXACT, type MapShaderTarget } from "../src/world/GivreMapMaterial.ts";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`OK   ${label}`);
};

// ---------------------------------------------------------------- 1. switch
{
  assert.equal(depthPrepassWanted(false, new Set()), false);
  assert.equal(depthPrepassWanted(true, new Set()), true);
  assert.equal(depthPrepassWanted(false, new Set(["prepass"])), true);
  assert.equal(depthPrepassWanted(true, new Set(["noprepass"])), false);
  assert.equal(depthPrepassWanted(false, new Set(["prepass", "noprepass"])), false, "noprepass wins");
  ok("depthPrepassWanted: default, ?diag=prepass, ?diag=noprepass (wins)");
}

// ---------------------------------------------------------------- 2. eligibility
{
  // (BoxGeometry carries 6 groups: cleared, like a merged map batch)
  const box = (): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.clearGroups(); // (not chainable)
    return g;
  };
  const std = (p: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial(p);
  assert.equal(prepassEligible(new THREE.Mesh(box(), std())), true, "plain opaque");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ side: THREE.DoubleSide }))), true, "double-sided");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ transparent: true }))), false, "transparent");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ alphaTest: 0.5 }))), false, "alpha test");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ alphaHash: true }))), false, "alpha hash");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ depthWrite: false }))), false, "no depth write");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ depthTest: false }))), false, "no depth test");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ colorWrite: false }))), false, "no colour write");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ depthFunc: THREE.LessDepth }))), false, "depth func");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ polygonOffset: true }))), false, "polygon offset");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ wireframe: true }))), false, "wireframe");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ blending: THREE.AdditiveBlending }))), false, "blending");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ displacementMap: new THREE.Texture() }))), false, "displacement");
  assert.equal(prepassEligible(new THREE.Mesh(box(), std({ clippingPlanes: [new THREE.Plane()] }))), false, "clipping");
  assert.equal(prepassEligible(new THREE.Mesh(box(), new THREE.ShaderMaterial())), false, "custom shader");
  assert.equal(prepassEligible(new THREE.Mesh(box(), new THREE.RawShaderMaterial())), false, "raw shader");
  const patched = std();
  patched.onBeforeCompile = () => {};
  assert.equal(prepassEligible(new THREE.Mesh(box(), patched)), false, "unknown onBeforeCompile");
  assert.equal(prepassEligible(new THREE.Mesh(box(), patched), (m) => m === patched), true, "known patch");
  const uber = new MapUberMaterial();
  assert.equal(prepassEligible(new THREE.Mesh(box(), uber), (m) => (m as MapUberMaterial).isMapUberMaterial === true), true, "uber");
  const morph = box();
  morph.morphAttributes.position = [morph.getAttribute("position").clone()];
  assert.equal(prepassEligible(new THREE.Mesh(morph, std())), false, "morph targets");
  const grouped = new THREE.BoxGeometry(1, 1, 1);
  assert.ok(grouped.groups.length > 0);
  assert.equal(prepassEligible(new THREE.Mesh(grouped, std())), false, "groups (BoxGeometry has 6)");
  const plain = box();
  assert.equal(prepassEligible(new THREE.Mesh(plain, std())), true, "no group");
  const ranged = plain.clone();
  ranged.setDrawRange(0, 6);
  assert.equal(prepassEligible(new THREE.Mesh(ranged, std())), false, "draw range");
  assert.equal(prepassEligible(new THREE.InstancedMesh(plain, std(), 2)), false, "instanced");
  assert.equal(prepassEligible(new THREE.SkinnedMesh(plain, std())), false, "skinned");
  const hidden = new THREE.Mesh(plain, std());
  hidden.visible = false;
  assert.equal(prepassEligible(hidden), false, "hidden");
  assert.equal(prepassEligible(new THREE.Mesh(plain, [std(), std()])), false, "multi-material");
  const interleaved = new THREE.BufferGeometry();
  interleaved.setAttribute("position", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array(18), 6), 3, 0));
  assert.equal(prepassEligible(new THREE.Mesh(interleaved, std())), false, "interleaved positions");
  assert.equal(isIdentity(new THREE.Matrix4()), true);
  assert.equal(isIdentity(new THREE.Matrix4().makeTranslation(0, 1e-9, 0)), false);
  // Patched keys: two different custom patches (default key = their source) never share a program.
  const p1 = std();
  p1.onBeforeCompile = (s) => void (s.vertexShader += "\n// one");
  const p2 = std();
  p2.onBeforeCompile = (s) => void (s.vertexShader += "\n// two");
  const k1 = p1.customProgramCacheKey(), k2 = p2.customProgramCacheKey();
  patchInvariantPosition(p1);
  patchInvariantPosition(p2);
  assert.equal(p1.customProgramCacheKey(), `${k1}+invariant-position`);
  assert.equal(p2.customProgramCacheKey(), `${k2}+invariant-position`);
  assert.notEqual(p1.customProgramCacheKey(), p2.customProgramCacheKey());
  ok("prepassEligible: plain opaque only (23 refusal cases); isIdentity exact; patched program keys stay distinct");
}

// ---------------------------------------------------------------- 3. welding
const bitsOfTriangles = (geometry: THREE.BufferGeometry, out: string[]) => {
  const pos = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const index = geometry.index;
  const n = index ? index.count : pos.length / 3;
  for (let i = 0; i < n; i += 3) {
    let s = "";
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(i + k) : i + k;
      s += `${bits[v * 3].toString(16)},${bits[v * 3 + 1].toString(16)},${bits[v * 3 + 2].toString(16)};`;
    }
    out.push(s);
  }
  return out;
};
{
  const a = new THREE.BoxGeometry(1, 2, 3); // 24 split vertices, 8 distinct positions
  const b = new THREE.BoxGeometry(1, 2, 3).toNonIndexed();
  b.translate(5, 0, 0);
  const welded = weldedPositions([a, b]);
  assert.equal(welded.getAttribute("position").count, 16, "8 + 8 distinct corners");
  assert.deepEqual(Object.keys(welded.attributes), ["position"]);
  assert.deepEqual(bitsOfTriangles(welded, []), [...bitsOfTriangles(a, []), ...bitsOfTriangles(b, [])], "same triangles, same order, same vertex order");
  const signed = new THREE.BufferGeometry();
  signed.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, -0, 0, 0, 1, 0, 0]), 3));
  assert.equal(weldedPositions([signed]).getAttribute("position").count, 3, "−0 and +0 are different bits: kept apart");
  // minArea: a 2 m² triangle kept, a 0.005 m² one left out (whole triangles, order kept).
  const sizes = new THREE.BufferGeometry();
  sizes.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0]), 3));
  const big = weldedPositions([sizes], 0.5);
  assert.equal(big.index!.count, 3);
  assert.deepEqual(bitsOfTriangles(big, []), bitsOfTriangles(sizes, []).slice(1), "only the big triangle");
  assert.equal(weldedPositions([sizes], 0).index!.count, 6);
  ok("weldedPositions: exact-bit welding (16 of 48 box vertices), triangles and vertex order unchanged; minArea keeps whole big triangles");
}

// ---------------------------------------------------------------- real glb → batches (as GivreMap)
const buf = readFileSync("src/assets/MAP/Givre/givre_01.glb");
const loader = new GLTFLoader();
loader.register((parser) => {
  const cache = new Map<number, Promise<THREE.Texture>>();
  (parser as unknown as { loadImageSource: (i: number) => Promise<THREE.Texture> }).loadImageSource = (i) => {
    if (!cache.has(i)) cache.set(i, Promise.resolve(new THREE.Texture()));
    return cache.get(i)!.then((t) => t.clone());
  };
  return { name: "STUB_IMAGE_SOURCES" };
});
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) =>
  loader.parse(ab, "", res as never, rej),
);
const scene = gltf.scene;
scene.updateMatrixWorld(true);
const animated = new Set<THREE.Object3D>();
for (const clip of gltf.animations) {
  for (const track of clip.tracks) {
    const node = scene.getObjectByName(THREE.PropertyBinding.parseTrackName(track.name).nodeName);
    node?.traverse((o) => animated.add(o));
  }
}
const KEEP = new Set(["position", "normal", "uv"]);
const entries: StaticEntry[] = [];
const standard = new Map<THREE.Material, THREE.Material>(); // as GivreMap (GivreConfig.standardMaterials)
scene.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || animated.has(mesh)) return;
  let g = worldSpaceCopy(mesh.geometry, mesh.matrixWorld, KEEP);
  if (!g) {
    g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
  }
  const source = mesh.material as THREE.Material;
  if (!standard.has(source)) standard.set(source, toStandardMaterial(source));
  entries.push({ geometry: g, material: standard.get(source)! });
});
applyUberMaterial(entries, new Set(["GIV_Feu", "GIV_Lampe"]));
const grid: ChunkGrid = { minX: -140, minZ: -140, maxX: 140, maxZ: 80, cellsX: 3, cellsZ: 2 };
const batches = buildStaticBatches(entries, (g) => mergeGeometries(g, false), {
  grid,
  chunkMinTriangles: 6000,
  singleSidedMaxThickness: 2,
  singleSidedPerComponent: false, // (GivreConfig default)
  keepMaterials: new Set(["GIV_Feu"]),
});
const meshes = batches.map(({ geometry, material }) => {
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
});
const root = new THREE.Group();
root.add(...meshes);
root.updateMatrixWorld(true);
// The backdrop (out-of-bounds plain + mountains, its own glb, no texture) joins the prepass (as GivreMap).
const fondBuf = readFileSync("src/assets/MAP/Givre/givre_01_fond.glb");
const fond = await new Promise<{ scene: THREE.Group }>((res, rej) =>
  new GLTFLoader().parse(fondBuf.buffer.slice(fondBuf.byteOffset, fondBuf.byteOffset + fondBuf.byteLength) as ArrayBuffer, "", res as never, rej),
);
const backdrop: THREE.Mesh[] = [];
fond.scene.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) backdrop.push(o as THREE.Mesh);
});
assert.equal(backdrop.length, 2, "plain + mountains");
const occluders = [...meshes, ...backdrop];
const isUber = (m: THREE.Material) => (m as MapUberMaterial).isMapUberMaterial === true;
const keyBefore = new Map(occluders.map((m) => [m, (m.material as THREE.Material).customProgramCacheKey()]));

// ---------------------------------------------------------------- 4. prepass of the real map
for (const minArea of [0, 0.1]) {
  const t0 = performance.now();
  const prepass = new GivreDepthPrepass(occluders, grid, { knownPatch: isUber, minArea });
  const ms = performance.now() - t0;
  const cells = grid.cellsX * grid.cellsZ;
  const sides = new Set(prepass.covered.map((m) => (m.material as THREE.Material).side));
  assert.ok(prepass.covered.some((b) => isUber(b.material as THREE.Material)), "the uber batches are covered (known patch)");
  for (const b of backdrop) assert.ok(prepass.covered.includes(b), `backdrop ${b.name} covered`);
  assert.ok(prepass.proxies.length > 0 && prepass.proxies.length <= sides.size, "one proxy per side (2 draws)");
  const perCell = new GivreDepthPrepass(occluders, grid, { knownPatch: isUber, minArea, cells: true });
  assert.ok(perCell.proxies.length > prepass.proxies.length && perCell.proxies.length <= cells * sides.size, `cells: ≤ ${cells} proxies per side`);
  assert.equal(perCell.triangles, prepass.triangles, "cells: the same triangles, split");
  assert.equal(prepass.covered.length + prepass.refused.length, occluders.length);
  assert.equal(prepass.group.renderOrder, PREPASS_GROUP_ORDER);
  assert.ok(PREPASS_GROUP_ORDER < 0);
  for (const proxy of prepass.proxies) {
    const m = proxy.material as THREE.ShaderMaterial;
    assert.equal(proxy.name, PREPASS_NAME);
    assert.equal(m.colorWrite, false, "depth only");
    assert.equal(m.depthWrite && m.depthTest, true);
    assert.equal(m.depthFunc, THREE.LessEqualDepth);
    assert.equal(m.transparent, false);
    assert.equal(m.vertexShader, PREPASS_VERTEX_SHADER);
    assert.equal(m.fragmentShader, PREPASS_FRAGMENT_SHADER);
    assert.ok(sides.has(m.side));
    assert.equal(proxy.castShadow, false);
    assert.equal(isIdentity(proxy.matrix), true);
    assert.deepEqual(Object.keys(proxy.geometry.attributes), ["position"]);
    assert.ok(proxy.geometry.boundingSphere);
    const hits: THREE.Intersection[] = [];
    proxy.raycast(new THREE.Raycaster(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, -1, 0)), hits);
    assert.equal(hits.length, 0, "never a shot target");
  }
  // Exactly the covered batches' triangles (≥ minArea), per side (bit patterns, vertex order kept).
  const area = (s: string) => {
    const v = s
      .split(";")
      .filter(Boolean)
      .map((c) => c.split(",").map((h) => new Float32Array(new Uint32Array([parseInt(h, 16)]).buffer)[0]));
    const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    const w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    const x = u[1] * w[2] - u[2] * w[1], y = u[2] * w[0] - u[0] * w[2], z = u[0] * w[1] - u[1] * w[0];
    return Math.sqrt(x * x + y * y + z * z) / 2; // (the same float64 formula as the module)
  };
  for (const side of sides) {
    const want: string[] = [];
    for (const b of prepass.covered) if ((b.material as THREE.Material).side === side) bitsOfTriangles(b.geometry, want);
    if (minArea > 0) want.splice(0, want.length, ...want.filter((s) => area(s) >= minArea));
    const got: string[] = [];
    for (const p of prepass.proxies) if ((p.material as THREE.Material).side === side) bitsOfTriangles(p.geometry, got);
    assert.equal(got.length, want.length, `side ${side}: triangle count`);
    want.sort();
    got.sort();
    assert.deepEqual(got, want, `side ${side}: same triangles`);
  }
  // Materials: covered → invariant (new key), refused → untouched; refusals are real refusals.
  for (const b of prepass.covered) {
    const m = b.material as THREE.Material;
    assert.equal(hasInvariantPosition(m), true);
    assert.equal(m.customProgramCacheKey(), `${keyBefore.get(b)}+invariant-position`);
    const shader = { vertexShader: "#define STANDARD\nvoid main() {\n#include <begin_vertex>\n}", fragmentShader: "#include <common>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <emissivemap_fragment>", uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    assert.ok(shader.vertexShader.startsWith("invariant gl_Position;\n"), "invariant first");
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    assert.equal(shader.vertexShader.split("invariant gl_Position;").length, 2, "declared once");
  }
  for (const b of prepass.refused) {
    assert.equal(prepassEligible(b, isUber), false);
    assert.equal(hasInvariantPosition(b.material as THREE.Material), false);
  }
  const tris = (list: THREE.Mesh[]) => list.reduce((s, m) => s + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3, 0);
  const verts = (list: THREE.Mesh[]) => list.reduce((s, m) => s + m.geometry.getAttribute("position").count, 0);
  ok(
    `prepass of the real map + backdrop (minArea ${minArea} m²): ${prepass.covered.length}/${occluders.length} meshes (${tris(prepass.covered)} tris, backdrop ${tris(backdrop)}; refused: ${prepass.refused
      .map((b) => (b.material as THREE.Material).name)
      .join(", ") || "none"}) → ${prepass.proxies.length} depth-only proxies, ${prepass.triangles} tris, ${verts(prepass.covered)} → ${verts(prepass.proxies)} vertices (welded), same triangles bit for bit (${ms.toFixed(0)} ms)`,
  );
  assert.equal(prepass.triangles, tris(prepass.proxies));
  if (minArea > 0) assert.ok(prepass.triangles < tris(prepass.covered), "fewer triangles with minArea");
  // unpatch (bench A/B) restores the exact production key
  const one = prepass.covered[0].material as THREE.Material;
  unpatchInvariantPosition(one);
  assert.equal(hasInvariantPosition(one), false);
  assert.equal(one.customProgramCacheKey(), keyBefore.get(prepass.covered[0]));
  patchInvariantPosition(one);
  assert.equal(hasInvariantPosition(one), true);
  ok("unpatchInvariantPosition restores the production program key");
}

// ---------------------------------------------------------------- 4b. load-time check (verify)
{
  const prepass = new GivreDepthPrepass([], grid);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, 2, 3);
  camera.rotation.set(0.1, 0.2, 0, "YXZ");
  camera.updateMatrixWorld(true);
  const before = camera.matrixWorld.clone();
  let broken = false;
  let frames = 0;
  const gl = {
    drawingBufferWidth: 4,
    drawingBufferHeight: 2,
    FRAMEBUFFER: 0x8d40,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    bindFramebuffer() {},
    readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) {
      out.fill(prepass.enabled && broken ? 7 : 5); // a broken GPU: the prepass changes the image
    },
  };
  const capabilities = { logarithmicDepthBuffer: false, reversedDepthBuffer: false };
  const renderer = { getContext: () => gl, setRenderTarget() {}, capabilities } as unknown as THREE.WebGLRenderer;
  capabilities.logarithmicDepthBuffer = true;
  assert.equal(prepass.verify(renderer, camera, () => frames++), -1, "logarithmic depth: refused");
  assert.equal(prepass.enabled, false);
  assert.equal(frames, 0, "nothing rendered");
  capabilities.logarithmicDepthBuffer = false;
  assert.equal(prepass.verify(renderer, camera, () => frames++), 0);
  assert.equal(prepass.enabled, true, "identical → kept on");
  assert.equal(frames, 2 * 2, "2 views × (on, off)");
  assert.deepEqual(prepass.verified, { differing: 0, pixels: 16 });
  assert.ok(camera.matrixWorld.equals(before), "camera restored");
  broken = true;
  assert.equal(prepass.verify(renderer, camera, () => {}), 16);
  assert.equal(prepass.enabled, false, "any difference → off for the session");
  assert.ok(camera.matrixWorld.equals(before), "camera restored");
  ok("verify: logarithmic depth refused; identical → on; any differing pixel → off for the session; camera restored");
}

// ---------------------------------------------------------------- 4c. map shader swapped in after the prepass (as GivreMap)
{
  // GivreMap builds the prepass (buildVisual), THEN swaps the map's specialised
  // shader in (GivreMapMaterial: clones — Material.copy never copies
  // onBeforeCompile): without `repatch` the batches lose `invariant gl_Position`.
  const prepass = new GivreDepthPrepass(occluders, grid, { knownPatch: isUber, minArea: 0.1 });
  const targets: MapShaderTarget[] = prepass.covered.map((mesh) => ({ mesh, stock: mesh.material as THREE.Material }));
  const cache = new Map<string, THREE.Material | null>();
  const swapped = applyMapShader(targets, MAP_SHADER_EXACT, cache);
  assert.ok(swapped > 0, "the specialised shader replaces covered materials");
  const lost = prepass.covered.filter((b) => !hasInvariantPosition(b.material as THREE.Material)).length;
  assert.ok(lost > 0, "a specialised clone has lost the invariant patch (what repatch is for)");
  prepass.repatch();
  const real = () =>
    ({
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      uniforms: {},
    }) as unknown as THREE.WebGLProgramParametersWithUniforms;
  let specialisedSeen = 0;
  for (const b of prepass.covered) {
    const m = b.material as THREE.Material;
    assert.equal(hasInvariantPosition(m), true, `${m.name}: invariant again`);
    const shader = real();
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    assert.ok(shader.vertexShader.startsWith("invariant gl_Position;\n"), `${m.name}: invariant first`);
    assert.equal(shader.vertexShader.split("invariant gl_Position;").length, 2, `${m.name}: declared once`);
    if (m.userData.mapShader) {
      specialisedSeen++;
      // the specialisation itself still runs under the patch (noIbl: RE_IndirectSpecular behind USE_ENVMAP)
      assert.ok(shader.fragmentShader.includes("#ifdef USE_ENVMAP\n#define RE_IndirectSpecular"), `${m.name}: still specialised`);
      assert.ok(m.customProgramCacheKey().includes("givre-map-shader-v1") && m.customProgramCacheKey().endsWith("+invariant-position"));
    }
  }
  assert.equal(specialisedSeen, swapped);
  // DEV `givreMapShader.set(null)` (stock back) and set(options) again: still patched.
  applyMapShader(targets, null, cache);
  prepass.repatch();
  for (const b of prepass.covered) assert.equal(hasInvariantPosition(b.material as THREE.Material), true);
  applyMapShader(targets, MAP_SHADER_EXACT, cache);
  prepass.repatch();
  for (const b of prepass.covered) assert.equal(hasInvariantPosition(b.material as THREE.Material), true);
  applyMapShader(targets, null, cache); // (stock materials again for the next section)
  ok(`map shader swapped in after the prepass: ${lost} of ${swapped} specialised clones had lost invariant gl_Position, repatch puts it back (specialisation kept, own program keys)`);
}

// ---------------------------------------------------------------- 5. same position computation
{
  const resolve = (src: string): string =>
    src.replace(/^[ \t]*#include +<([\w\d.]+)>/gm, (_m, name: string) => resolve((THREE.ShaderChunk as Record<string, string>)[name]));
  const prepassVs = resolve(PREPASS_VERTEX_SHADER);
  const expected = `invariant gl_Position;\nvoid main() {\n${THREE.ShaderChunk.begin_vertex}\n${THREE.ShaderChunk.project_vertex}\n}\n`;
  assert.equal(prepassVs, expected, "prepass VS = begin_vertex + project_vertex");
  // The standard (uber) VS after its patch: what sits between begin_vertex and project_vertex.
  const uber = new MapUberMaterial();
  const shader = {
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  uber.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  const main = shader.vertexShader.slice(shader.vertexShader.indexOf("void main()"));
  const between = main.slice(main.indexOf("#include <begin_vertex>") + "#include <begin_vertex>".length, main.indexOf("#include <project_vertex>"));
  const statements = between
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.deepEqual(
    statements,
    [
      "vUberEmissive = aEmissive;",
      "vUberRoughness = aRoughness;",
      "vUberMetalness = aMetalness;",
      "#include <morphtarget_vertex>",
      "#include <skinning_vertex>",
      "#include <displacementmap_vertex>",
    ],
    "only varyings + inactive chunks between the two",
  );
  for (const [chunk, define] of [
    ["morphtarget_vertex", "USE_MORPHTARGETS"],
    ["skinning_vertex", "USE_SKINNING"],
    ["displacementmap_vertex", "USE_DISPLACEMENTMAP"],
  ]) {
    const body = THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk].trim();
    assert.ok(body.startsWith(`#ifdef ${define}`) && body.endsWith("#endif"), `${chunk} wholly inside #ifdef ${define}`);
  }
  // project_vertex: only batching / instancing (both off for a plain batch and a proxy) alter it.
  const pv = THREE.ShaderChunk.project_vertex;
  assert.ok(pv.includes("gl_Position = projectionMatrix * mvPosition;") && pv.includes("mvPosition = modelViewMatrix * mvPosition;"));
  // The backdrop's materials are MeshPhysicalMaterial (KHR_materials_specular): the same vertex shader.
  assert.equal(new Set(backdrop.map((m) => (m.material as THREE.Material).type)).size, 1);
  assert.equal((backdrop[0].material as THREE.Material).type, "MeshPhysicalMaterial");
  assert.equal(THREE.ShaderLib.physical.vertexShader, THREE.ShaderLib.standard.vertexShader, "physical VS = standard VS");
  ok("same position computation: begin_vertex + project_vertex in both programs (only inactive chunks and uber varyings between them in the standard / physical shader)");
}

console.log(`\nAll ${passed} GIVRE depth-prepass checks passed.`);
