// GivreRenderOptim — headless checks on the REAL givre_01.glb (no DOM / WebGL).
// Usage (repo root):  npx --prefix backend tsx scripts/test-givre-render-optim.mts
//   1. isClosedOutward: unit cases (box, open box, flipped box, inconsistent);
//   2. splitByGrid: every triangle kept exactly once, attributes copied
//      verbatim, each chunk inside its cell;
//   3. buildStaticBatches on the real map: same triangle multiset as the old
//      per-material merge, single-sided only on closed outward thin solids,
//      FrontSide clones keep name / colour / maps, GIV_Feu never cloned;
//   4. toStandardMaterial keeps every value the map uses;
//   5. frontToBackOpaqueSort: renderOrder first, then near → far;
//   6. SkyCoveredRenderPass: one depth / stencil clear while the sky covers
//      every pixel (GivreSky.coversEveryPixel), one full clear otherwise
//      (never two); the renderer's autoClear flags are restored;
//   7. the FX light pool adds no (dead) light to the world scene;
//   8. specialised map shader (GivreMapMaterial): `?diag=` options, what the
//      real map data allows (metalness ≡ 0, one lightmap uv…), the GLSL
//      rewrite against three's own chunks (every anchor found, the removed
//      terms really gone, the PCF taps rotated exactly), the specialised
//      clones (same values, own cache key, stock patch kept) and the swap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  buildStaticBatches,
  cellOf,
  frontToBackOpaqueSort,
  isClosedOutward,
  splitByGrid,
  toStandardMaterial,
  triangleCount,
  type ChunkGrid,
  type StaticEntry,
} from "../src/world/GivreRenderOptim.ts";
import { SkyCoveredRenderPass } from "../src/effects/SkyCoveredRenderPass.ts";
import { GivreSky } from "../src/world/GivreSky.ts";
import { fxLights } from "../src/effects/FXLightPool.ts";
import { applyUberMaterial } from "../src/world/MapBatching.ts";
import {
  MAP_SHADER_EXACT,
  MAP_SHADER_FAST,
  applyMapShader,
  collectMapShaderTargets,
  createMapShaderMaterial,
  mapShaderEligibility,
  mapShaderOptionsFor,
  specialiseMapShader,
  vogelTaps,
  type MapShaderOptions,
} from "../src/world/GivreMapMaterial.ts";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`OK   ${label}`);
};

// ---------------------------------------------------------------- 1. closed
{
  const box = new THREE.BoxGeometry(1, 2, 3); // 24 split vertices, outward
  assert.equal(isClosedOutward(box), true);
  const nonIndexed = box.toNonIndexed();
  assert.equal(isClosedOutward(nonIndexed), true);

  const flipped = box.clone();
  const idx = flipped.index!.array as Uint16Array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  assert.equal(isClosedOutward(flipped), false, "inward box must stay double-sided");

  const open = box.clone();
  open.setIndex(Array.from(box.index!.array).slice(6)); // one face removed
  assert.equal(isClosedOutward(open), false, "open box");

  const mixed = box.clone();
  const m = mixed.index!.array as Uint16Array;
  [m[1], m[2]] = [m[2], m[1]]; // ONE flipped triangle
  assert.equal(isClosedOutward(mixed), false, "inconsistent winding");

  assert.equal(isClosedOutward(new THREE.PlaneGeometry(4, 4)), false, "plane");
  ok("isClosedOutward: box / non-indexed box closed; flipped, open, mixed, plane rejected");
}

// ---------------------------------------------------------------- real glb
const buf = readFileSync("src/assets/MAP/Givre/givre_01.glb");
const loader = new GLTFLoader();
loader.register((parser) => {
  // No image decoder in Node: one empty texture per image source.
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
scene.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || animated.has(mesh)) return;
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
  entries.push({ geometry: g, material: mesh.material as THREE.Material });
});
const grid: ChunkGrid = { minX: -140, minZ: -140, maxX: 140, maxZ: 80, cellsX: 3, cellsZ: 2 };

/** Sorted multiset of "material|triangle(pos,normal,uv)" signatures (rotation-invariant). */
function signatures(list: { geometry: THREE.BufferGeometry; material: THREE.Material }[]): string[] {
  const out: string[] = [];
  for (const { geometry, material } of list) {
    const p = geometry.getAttribute("position");
    const n = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const idx = geometry.index;
    const count = idx ? idx.count : p.count;
    const vert = (v: number) =>
      [p.getX(v), p.getY(v), p.getZ(v), n?.getX(v), n?.getY(v), n?.getZ(v), uv?.getX(v), uv?.getY(v)]
        .map((x) => (x === undefined ? "-" : x.toFixed(4)))
        .join(",");
    for (let i = 0; i < count; i += 3) {
      const t = [0, 1, 2].map((k) => vert(idx ? idx.getX(i + k) : i + k));
      let best = t.join("|"); // canonical rotation (keeps the winding)
      for (const r of [1, 2]) {
        const s = [t[r], t[(r + 1) % 3], t[(r + 2) % 3]].join("|");
        if (s < best) best = s;
      }
      out.push(`${material.name}|${best}`);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------- 2. split
{
  const orange = entries.filter((e) => e.material.name === "GIV_Orange");
  const merged = mergeGeometries(orange.map((e) => e.geometry), false)!;
  const parts = splitByGrid(merged, grid);
  assert.ok(parts.length > 1, "GIV_Orange spans several cells");
  const total = parts.reduce((s, p) => s + triangleCount(p.geometry), 0);
  assert.equal(total, triangleCount(merged), "every triangle kept once");
  for (const { geometry, cell } of parts) {
    const p = geometry.getAttribute("position");
    const idx = geometry.index!;
    for (let i = 0; i < idx.count; i += 3) {
      let x = 0;
      let z = 0;
      for (let k = 0; k < 3; k++) {
        x += p.getX(idx.getX(i + k));
        z += p.getZ(idx.getX(i + k));
      }
      assert.equal(cellOf(grid, x / 3, z / 3), cell, "triangle centroid inside its chunk cell");
    }
    assert.deepEqual(Object.keys(geometry.attributes).sort(), Object.keys(merged.attributes).sort());
  }
  const m = orange[0].material;
  assert.deepEqual(
    signatures(parts.map((p) => ({ geometry: p.geometry, material: m }))),
    signatures([{ geometry: merged, material: m }]),
    "split = same triangles (positions, normals, uv, winding)",
  );
  ok(`splitByGrid: GIV_Orange ${triangleCount(merged)} tris → ${parts.length} chunks, identical triangles`);
}

// ---------------------------------------------------------------- 3. batches
const before = signatures(entries);
const t0 = performance.now();
const batches = buildStaticBatches(entries, (g) => mergeGeometries(g, false), {
  grid,
  chunkMinTriangles: 6000,
  singleSidedMaxThickness: 2,
  keepMaterials: new Set(["GIV_Feu"]),
});
console.log(`INFO buildStaticBatches load-time cost: ${(performance.now() - t0).toFixed(0)} ms (Node)`);
{
  assert.deepEqual(signatures(batches), before, "batches draw exactly the original static triangles");
  const single = batches.filter((b) => b.singleSided);
  const singleTris = single.reduce((s, b) => s + triangleCount(b.geometry), 0);
  const totalTris = batches.reduce((s, b) => s + triangleCount(b.geometry), 0);
  assert.ok(singleTris > 0, "some solids are single-sided");
  for (const b of batches) {
    assert.equal(b.material.side, b.singleSided ? THREE.FrontSide : THREE.DoubleSide, `${b.material.name} side`);
    if (b.material.name === "GIV_Feu") assert.equal(b.singleSided, false, "GIV_Feu never cloned");
    if (b.material.transparent) assert.equal(b.singleSided, false, "transparent stays double-sided");
  }
  // FrontSide clones: same name / colour / baked maps as their glb original.
  const originals = new Map(entries.map((e) => [e.material.name, e.material as THREE.MeshStandardMaterial]));
  for (const b of single) {
    const src = originals.get(b.material.name)!;
    const clone = b.material as THREE.MeshStandardMaterial;
    assert.notEqual(clone, src);
    assert.equal(clone.color.getHex(), src.color.getHex());
    assert.equal(clone.emissiveMap, src.emissiveMap);
    assert.equal(clone.aoMap, src.aoMap);
    assert.equal(clone.emissiveIntensity, src.emissiveIntensity);
    assert.equal(clone.shadowSide, THREE.FrontSide);
  }
  const clones = new Set(single.map((b) => b.material));
  assert.equal(clones.size, new Set(single.map((b) => b.material.name)).size, "one clone per material");
  const chunks = batches.filter((b) => b.cell >= 0).length;
  ok(
    `buildStaticBatches: ${batches.length} draw batches (${chunks} grid chunks), ` +
      `${singleTris}/${totalTris} tris single-sided (${((singleTris / totalTris) * 100).toFixed(0)} %), same triangles as before`,
  );
}


// ---------------------------------------------------------------- 4. materials
{
  let converted = 0;
  for (const e of entries) {
    const src = e.material as THREE.MeshPhysicalMaterial;
    const out = toStandardMaterial(src) as THREE.MeshStandardMaterial;
    if (!src.isMeshPhysicalMaterial) {
      assert.equal(out, src, "non-physical returned as-is");
      continue;
    }
    converted++;
    assert.equal(out.type, "MeshStandardMaterial");
    assert.equal((out as Partial<THREE.MeshPhysicalMaterial>).isMeshPhysicalMaterial, undefined);
    assert.equal(out.name, src.name);
    assert.equal(out.color.getHex(), src.color.getHex());
    assert.equal(out.emissive.getHex(), src.emissive.getHex());
    assert.equal(out.emissiveIntensity, src.emissiveIntensity);
    assert.equal(out.emissiveMap, src.emissiveMap);
    assert.equal(out.aoMap, src.aoMap);
    assert.equal(out.roughness, src.roughness);
    assert.equal(out.metalness, src.metalness);
    assert.equal(out.side, src.side);
    assert.equal(out.transparent, src.transparent);
    assert.equal(out.opacity, src.opacity);
    assert.deepEqual(out.defines, { STANDARD: "" });
    // Nothing the Standard shader would drop is used by the map.
    assert.equal(src.clearcoat, 0);
    assert.equal(src.sheen, 0);
    assert.equal(src.transmission, 0);
    assert.equal(src.iridescence, 0);
  }
  assert.ok(converted > 10);
  ok(`toStandardMaterial: ${converted} Physical static primitives → Standard, colours / maps / roughness kept`);
}

// ---------------------------------------------------------------- 5. sort
{
  const mat = (id: number) => ({ id }) as unknown as THREE.Material;
  const item = (id: number, z: number, renderOrder = 0, material = 1) =>
    ({ id, z, renderOrder, groupOrder: 0, material: mat(material) }) as unknown as THREE.RenderItem;
  const list = [item(1, 50, 0, 1), item(2, 5, 0, 2), item(3, 20, 0, 1), item(4, 1, 1, 1)];
  list.sort(frontToBackOpaqueSort);
  assert.deepEqual(list.map((i) => i.id), [2, 3, 1, 4], "near → far, renderOrder first");
  ok("frontToBackOpaqueSort: renderOrder first, then near → far");
}

// ---------------------------------------------------------------- 6. clears
{
  // Stand-in renderer: records every clear; render() behaves like three's
  // WebGLBackground with a Color background (clears with the autoClear*
  // flags whatever `autoClear` says — "forceClear").
  type Clear = [boolean, boolean, boolean];
  const clears: Clear[] = [];
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    target: undefined as unknown,
    getContext: () => ({}), // no WebGL 2 in Node: no invalidateFramebuffer
    setRenderTarget(t: unknown) {
      this.target = t;
    },
    clear(color = true, depth = true, stencil = true) {
      if (color || depth || stencil) clears.push([color, depth, stencil]); // three skips gl.clear(0)
    },
    render(scene: THREE.Scene) {
      assert.equal(this.target, readBuffer, "renders into the read buffer");
      if ((scene.background as THREE.Color | null)?.isColor) this.clear(this.autoClearColor, this.autoClearDepth, this.autoClearStencil);
    },
  };
  const readBuffer = { name: "read" };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x336699);
  const sky = new GivreSky();
  scene.add(sky.group);
  const pass = new SkyCoveredRenderPass(scene, new THREE.PerspectiveCamera(), () => sky.coversEveryPixel(scene));
  const run = (): Clear[] => {
    clears.length = 0;
    pass.render(renderer as unknown as THREE.WebGLRenderer, null as never, readBuffer as never, 0, false);
    assert.deepEqual(
      [renderer.autoClear, renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil],
      [true, true, true, true],
      "autoClear flags restored",
    );
    return [...clears];
  };
  assert.equal(sky.coversEveryPixel(scene), true);
  assert.deepEqual(run(), [[false, true, true]], "sky covers: one depth + stencil clear");
  pass.legacyClears = true;
  assert.deepEqual(run(), [[true, true, true], [true, true, true]], "A/B: three's two full clears");
  pass.legacyClears = false;
  sky.group.visible = false;
  assert.equal(sky.coversEveryPixel(scene), false);
  assert.deepEqual(run(), [[true, true, true]], "hidden sky: one full clear (the Color background's)");
  sky.group.visible = true;
  scene.remove(sky.group);
  assert.equal(sky.coversEveryPixel(scene), false, "sky outside the scene");
  assert.deepEqual(run(), [[true, true, true]], "no sky: one full clear");
  sky.dispose();
  ok("SkyCoveredRenderPass: depth + stencil only while the sky covers, one full clear otherwise");
}

// ---------------------------------------------------------------- 7. lights
{
  const scene = new THREE.Scene();
  fxLights.init(scene);
  let lights = 0;
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
  });
  assert.equal(lights, 0, "no dead FX light in the world scene");
  fxLights.request(0xffffff, 5, 4, 2, new THREE.Vector3()); // still a valid call
  fxLights.commit();
  ok("FX light pool: no light added to the scene (nothing requests one)");
}

// ---------------------------------------------------------------- 8. map shader
{
  // ?diag= options.
  assert.equal(mapShaderOptionsFor(new Set()), MAP_SHADER_EXACT, "default: the exact set");
  assert.equal(mapShaderOptionsFor(new Set(["nomapshader"])), null);
  assert.equal(mapShaderOptionsFor(new Set(["mapshaderfast"])), MAP_SHADER_FAST);
  assert.equal(mapShaderOptionsFor(new Set(["mapshaderfast", "nomapshader"])), null, "off wins");
  assert.ok(MAP_SHADER_EXACT.noIbl && MAP_SHADER_EXACT.dielectric && MAP_SHADER_EXACT.sharedUv && MAP_SHADER_EXACT.sunSkip);
  assert.ok(!MAP_SHADER_EXACT.noDirectMs && !MAP_SHADER_EXACT.pcfRotate, "near-exact parts off by default");
  assert.ok(MAP_SHADER_FAST.noDirectMs && MAP_SHADER_FAST.pcfRotate);

  // The real map as GivreMap builds it: Standard materials, then the uber merge.
  const converted = new Map<THREE.Material, THREE.Material>();
  const mapEntries: StaticEntry[] = entries.map((e) => {
    let m = converted.get(e.material);
    if (!m) {
      m = toStandardMaterial(e.material);
      converted.set(e.material, m);
    }
    return { geometry: e.geometry.clone(), material: m };
  });
  const ubers = applyUberMaterial(mapEntries, new Set(["GIV_Feu", "GIV_Lampe"]));
  const geometriesOf = (m: THREE.Material) => mapEntries.filter((e) => e.material === m).map((e) => e.geometry);
  let vertices = 0;
  for (const uber of ubers) {
    const geometries = geometriesOf(uber);
    for (const g of geometries) {
      const a = g.getAttribute("aMetalness");
      for (let i = 0; i < a.count; i++) assert.equal(a.getX(i), 0, `${uber.name}: metalness 0 on every vertex`);
      vertices += a.count;
    }
    const textured = !!(uber as THREE.MeshStandardMaterial).emissiveMap;
    assert.deepEqual(
      mapShaderEligibility(uber, geometries),
      { noIbl: true, dielectric: true, sharedUv: textured, sunSkip: true, noDirectMs: true, pcfRotate: true },
      `${uber.name}: every option applies`,
    );
  }
  const texturedUber = ubers.find((u) => (u as THREE.MeshStandardMaterial).emissiveMap)!;
  assert.ok(texturedUber && ubers.length >= 2, "textured + untextured uber groups");
  // The conditions are really checked.
  {
    const geometries = geometriesOf(texturedUber).map((g) => g.clone());
    (geometries[0].getAttribute("aMetalness") as THREE.BufferAttribute).setX(0, 0.5);
    const can = mapShaderEligibility(texturedUber, geometries);
    assert.equal(can.dielectric, false, "one metallic vertex → not dielectric");
    assert.equal(can.noDirectMs, false, "the multiscatter bound needs F0 = 0.04");
    const moved = texturedUber.clone() as THREE.MeshStandardMaterial;
    moved.aoMap = moved.aoMap!.clone();
    moved.aoMap.offset.set(0.5, 0);
    assert.equal(mapShaderEligibility(moved, geometriesOf(texturedUber)).sharedUv, false, "different AO transform");
    moved.envMap = new THREE.Texture();
    assert.equal(mapShaderEligibility(moved, geometriesOf(texturedUber)).noIbl, false, "env map → IBL kept");
    const coat = new THREE.MeshPhysicalMaterial({ clearcoat: 1 });
    assert.equal(mapShaderEligibility(coat, geometries).noIbl, false, "clearcoat → stock shader");
    assert.equal(mapShaderEligibility(new THREE.MeshBasicMaterial(), geometries).pcfRotate, false, "unlit → stock");
    const backdrop = new THREE.MeshPhysicalMaterial({ roughness: 0.95, specularIntensity: 0.2 });
    assert.equal(mapShaderEligibility(backdrop, geometries).dielectric, true, "Physical backdrop: dielectric");
  }

  // GLSL rewrite on three's own sources, after MapUberMaterial's patch.
  // The same steps as three's WebGLProgram: includes, light counts (Givre: 1
  // sun with a shadow, 1 hemisphere light), then the unrolled light loops.
  const includePattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const resolve = (src: string): string => src.replace(includePattern, (_m, name: string) => resolve(chunks[name]));
  const lightNums = (src: string): string =>
    src
      .replace(/NUM_DIR_LIGHTS/g, "1")
      .replace(/NUM_SPOT_LIGHTS/g, "0")
      .replace(/NUM_SPOT_LIGHT_MAPS/g, "0")
      .replace(/NUM_SPOT_LIGHT_COORDS/g, "0")
      .replace(/NUM_RECT_AREA_LIGHTS/g, "0")
      .replace(/NUM_POINT_LIGHTS/g, "0")
      .replace(/NUM_HEMI_LIGHTS/g, "1")
      .replace(/NUM_DIR_LIGHT_SHADOWS/g, "1")
      .replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g, "0")
      .replace(/NUM_SPOT_LIGHT_SHADOWS/g, "0")
      .replace(/NUM_POINT_LIGHT_SHADOWS/g, "0")
      .replace(/NUM_CLIPPING_PLANES/g, "0") // replaceClippingPlaneNums: no clipping plane
      .replace(/UNION_CLIPPING_PLANES/g, "0");
  const unrollPattern = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
  const unroll = (src: string): string =>
    src.replace(unrollPattern, (_m, start: string, end: string, body: string) => {
      let out = "";
      for (let i = Number(start); i < Number(end); i++) out += body.replace(/\[\s*i\s*\]/g, `[ ${i} ]`).replace(/UNROLLED_LOOP_INDEX/g, String(i));
      return out;
    });
  const finish = (src: string): string => unroll(lightNums(resolve(src)));
  const program = (m: THREE.Material, o: MapShaderOptions | null, uber = true) => {
    const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    m.onBeforeCompile(s as never, null as never);
    if (o) specialiseMapShader(s, o, uber);
    return { vs: finish(s.vertexShader), fs: finish(s.fragmentShader) };
  };
  const count = (s: string, find: string) => s.split(find).length - 1;
  const balanced = (s: string) => count(s, "{") === count(s, "}") && count(s, "(") === count(s, ")");
  const base = program(texturedUber, null);
  assert.ok(base.fs.includes("vUberMetalness") && base.vs.includes("attribute float aMetalness;"));
  assert.ok(base.fs.includes("texture2D( aoMap, vAoMapUv )"));
  assert.ok(base.fs.includes("irradiance * BRDF_GGX_Multiscatter( directLight.direction"));
  assert.ok(base.fs.includes("#define RE_IndirectSpecular\t\tRE_IndirectSpecular_Physical"));
  const exact = program(texturedUber, MAP_SHADER_EXACT);
  assert.ok(
    !exact.fs.includes("vUberMetalness") && !exact.vs.includes("aMetalness") && !exact.vs.includes("vUberMetalness"),
    "metalness attribute + varying gone",
  );
  assert.ok(exact.fs.includes("const float metalnessFactor = 0.0;"));
  assert.ok(exact.fs.includes("#ifdef USE_ENVMAP\n#define RE_IndirectSpecular\t\tRE_IndirectSpecular_Physical\n#endif"), "IBL only with an env map");
  assert.ok(exact.fs.includes("texture2D( aoMap, vEmissiveMapUv )") && !exact.fs.includes("texture2D( aoMap, vAoMapUv )"));
  assert.ok(exact.vs.includes("#undef USE_AOMAP") && exact.fs.includes("#undef USE_AOMAP"), "no vAoMapUv varying");
  assert.ok(exact.fs.includes("irradiance * BRDF_GGX_Multiscatter("), "exact set keeps the multiscatter");
  assert.ok(exact.fs.includes("vogelDiskSample( 0, 5, phi ) * radius"), "exact set keeps three's PCF taps");
  assert.ok(exact.fs.includes("totalEmissiveRadiance *= vUberEmissive;") && exact.fs.includes("roughness * vUberRoughness"), "uber patch kept");
  // sunSkip: the sun's block in its branch, unrolled like three does it, LOD 0 lookups inside.
  assert.equal(count(base.fs, "#pragma unroll_loop_start"), 0, "the emulation unrolls three's own loops");
  assert.equal(count(exact.fs, "#pragma unroll_loop_start"), 0, "every light loop still unrolls");
  assert.equal(count(exact.fs, "if ( dot( geometryNormal, directLight.direction ) > 0.0 ) {"), 1);
  assert.equal(count(exact.fs, "if ( directLight.color != vec3( 0.0 ) ) RE_Direct( directLight,"), 1);
  {
    const at = exact.fs.indexOf("if ( dot( geometryNormal, directLight.direction ) > 0.0 ) {");
    const block = exact.fs.slice(at, exact.fs.indexOf("#if defined( RE_IndirectDiffuse )", at));
    assert.ok(block.includes("getShadow( directionalShadowMap[ 0 ]") && block.includes("RE_Direct("), "shadow + BRDF inside the branch");
    assert.ok(balanced(block), "the branch closes before the ambient light");
  }
  assert.equal(count(exact.fs, "textureLod( shadowMap, vec3( shadowCoord.xy + "), 5, "PCF taps at LOD 0");
  assert.equal(count(exact.fs, "texture( shadowMap, vec3( shadowCoord.xy + "), 0);
  assert.ok(exact.fs.includes("vec2 dfgV = textureLod( dfgLUT, vec2( material.roughness, dotNV ), 0.0 ).rg;"));
  // (three's comments are not checked for balance: compare the imbalance with the stock text.)
  const imbalance = (s: string) => `${count(s, "{") - count(s, "}")}/${count(s, "(") - count(s, ")")}`;
  assert.equal(imbalance(exact.fs), imbalance(base.fs), "the rewrite adds balanced code (fs)");
  assert.equal(imbalance(exact.vs), imbalance(base.vs), "the rewrite adds balanced code (vs)");
  const fast = program(texturedUber, MAP_SHADER_FAST);
  assert.equal(imbalance(fast.fs), imbalance(base.fs), "the rewrite adds balanced code (fast fs)");
  assert.equal(count(fast.fs, "textureLod( shadowMap, vec3( shadowCoord.xy + givreTap"), 5, "rotated taps at LOD 0");
  assert.ok(!fast.fs.includes("irradiance * BRDF_GGX_Multiscatter(") && fast.fs.includes("irradiance * BRDF_GGX( directLight.direction"));
  assert.ok(fast.fs.includes("vec2 givreRot = vec2( cos( phi ), sin( phi ) );"));
  assert.ok(!fast.fs.includes("vogelDiskSample( 0, 5, phi ) * radius"), "2D PCF taps rotated");
  assert.ok(fast.fs.includes("vec2 sample0 = vogelDiskSample( 0, 5, phi );"), "point-light PCF untouched");
  // The emitted taps ARE three's Vogel disk, rotated: cos(iθ + φ) expanded.
  const taps = vogelTaps(5);
  for (const [i, [x, y]] of taps.entries()) {
    const r = Math.sqrt((i + 0.5) / 5);
    const theta = i * 2.399963229728653;
    for (const phi of [0, 0.7, 2.5, 4.4, 6.2]) {
      const rx = x * Math.cos(phi) - y * Math.sin(phi);
      const ry = x * Math.sin(phi) + y * Math.cos(phi);
      assert.ok(Math.abs(rx - Math.cos(theta + phi) * r) < 1e-12 && Math.abs(ry - Math.sin(theta + phi) * r) < 1e-12, `tap ${i} at φ ${phi}`);
    }
    const decl = new RegExp(`vec2 givreTap${i} = vec2\\( (\\S+) \\* givreRot\\.x - (\\S+) \\* givreRot\\.y, \\1 \\* givreRot\\.y \\+ \\2 \\* givreRot\\.x \\);`).exec(fast.fs);
    assert.ok(decl, `tap ${i} declared`);
    assert.equal(Math.fround(Number(decl[1])), Math.fround(x), `tap ${i} x literal`);
    assert.equal(Math.fround(Number(decl[2])), Math.fround(y), `tap ${i} y literal`);
  }
  // A plain map material (the lamp panels): its own metalness chunk.
  const lamp = [...converted.values()].find((m) => m.name === "GIV_Lampe")!;
  const plain = program(lamp, { ...MAP_SHADER_EXACT, sharedUv: false }, false);
  assert.ok(plain.fs.includes("const float metalnessFactor = 0.0;") && !plain.fs.includes("float metalnessFactor = metalness;"));
  assert.throws(() => specialiseMapShader({ vertexShader: "", fragmentShader: "" }, MAP_SHADER_EXACT, true), /anchor not found/);

  // Specialised clones: same values, own cache key, the stock patch kept.
  const special = createMapShaderMaterial(texturedUber, geometriesOf(texturedUber), MAP_SHADER_EXACT)! as THREE.MeshStandardMaterial;
  const src = texturedUber as THREE.MeshStandardMaterial;
  assert.notEqual(special, src);
  assert.equal(special.name, src.name);
  assert.equal(special.side, src.side);
  assert.equal(special.emissiveMap, src.emissiveMap);
  assert.equal(special.aoMap, src.aoMap);
  assert.equal(special.vertexColors, true);
  assert.equal(special.customProgramCacheKey(), "map-uber-v1|givre-map-shader-v1:ibl0,die,uv1,sun0");
  assert.equal(src.customProgramCacheKey(), "map-uber-v1", "stock material untouched");
  assert.deepEqual(program(special, null), exact, "clone = stock patch + rewrite");
  assert.ok(program(src, null).fs.includes("vUberMetalness"), "stock shader unchanged");

  // Swap: drawn meshes only, GIV_Feu kept, clones reused, stock restored.
  const group = new THREE.Group();
  const geometry = geometriesOf(texturedUber)[0];
  const a = new THREE.Mesh(geometry, texturedUber);
  const b = new THREE.Mesh(geometry, texturedUber);
  const hidden = new THREE.Mesh(geometry, texturedUber);
  hidden.visible = false;
  // (GIV_Feu sits on an animated node: not among the static entries.)
  const feu = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: "GIV_Feu" }));
  group.add(a, b, hidden, feu);
  const targets = collectMapShaderTargets([group], new Set(["GIV_Feu"]));
  assert.deepEqual(targets.map((t) => t.mesh), [a, b], "drawn, non-excluded meshes");
  const cache = new Map<string, THREE.Material | null>();
  assert.equal(applyMapShader(targets, MAP_SHADER_EXACT, cache), 2);
  assert.ok(a.material !== texturedUber && a.material === b.material, "one clone per stock material");
  const first = a.material;
  applyMapShader(targets, null, cache);
  assert.ok(a.material === texturedUber && b.material === texturedUber && (feu.material as THREE.Material).name === "GIV_Feu");
  applyMapShader(targets, MAP_SHADER_EXACT, cache);
  assert.equal(a.material, first, "clone reused (no new program)");
  ok(
    `map shader: ${ubers.length} uber materials (${vertices} vertices, metalness 0 everywhere) eligible; ` +
      "GLSL rewrite applied on three's chunks (IBL / metalness / AO varying gone, PCF taps rotated exactly); clones + swap",
  );
}

console.log(`\nAll ${passed} GIVRE render-optim checks passed.`);

