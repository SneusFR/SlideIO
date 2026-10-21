// GivreRenderOptim — headless checks on the REAL givre_01.glb (no DOM / WebGL).
// Usage (repo root):  npx --prefix backend tsx scripts/test-givre-render-optim.mts
//   1. isClosedOutward: unit cases (box, open box, flipped box, inconsistent);
//   2. splitByGrid: every triangle kept exactly once, attributes copied
//      verbatim, each chunk inside its cell;
//   3. buildStaticBatches on the real map: same triangle multiset as the old
//      per-material merge, single-sided only on closed outward thin solids,
//      FrontSide clones keep name / colour / maps, GIV_Feu never cloned;
//   3b. the same rule per connected component (closedOutwardThinTriangles): spread-out
//      solids, a solid next to an open part, inward / thick parts refused; on the real map
//      the same triangles, and every triangle single-sided today stays single-sided;
//   4. toStandardMaterial keeps every value the map uses;
//   5. frontToBackOpaqueSort: renderOrder first, then near → far;
//   6. SkyCoveredRenderPass: one depth / stencil clear while the sky covers
//      every pixel (GivreSky.coversEveryPixel), one full clear otherwise
//      (never two); the renderer's autoClear flags are restored;
//   7. the FX light pool adds no (dead) light to the world scene.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  buildStaticBatches,
  canBeSingleSided,
  cellOf,
  closedOutwardThinTriangles,
  frontToBackOpaqueSort,
  isClosedOutward,
  splitByGrid,
  subsetTriangles,
  toStandardMaterial,
  triangleCount,
  type ChunkGrid,
  type StaticEntry,
} from "../src/world/GivreRenderOptim.ts";
import { SkyCoveredRenderPass } from "../src/effects/SkyCoveredRenderPass.ts";
import { GivreSky } from "../src/world/GivreSky.ts";
import { fxLights } from "../src/effects/FXLightPool.ts";

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


// ---------------------------------------------------------------- 3b. per component
{
  // Synthetic: the whole-mesh rule refuses each of these, the per-component rule keeps
  // exactly the closed outward thin solids.
  const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const merge = (...gs: THREE.BufferGeometry[]) => mergeGeometries(gs.map(flat), false)!;
  const box = (w: number, h: number, d: number, x: number) => new THREE.BoxGeometry(w, h, d).translate(x, 0, 0);
  const inward = (x: number) => {
    const g = box(1, 1, 1, x).toNonIndexed();
    const p = g.getAttribute("position").array as Float32Array;
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + 3 + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + 3 + k]];
    return g;
  };
  const tallSpread = merge(box(1, 1, 1, 0), new THREE.BoxGeometry(1, 1, 1).translate(10, 10, 10)); // union 11 × 11 × 11
  const withPlane = merge(box(1, 1, 1, 0), new THREE.PlaneGeometry(4, 4).translate(10, 0, 0));
  const mixedWinding = merge(box(1, 1, 1, 0), inward(5));
  const thick = merge(box(3, 3, 3, 0), new THREE.BoxGeometry(1, 1, 1).translate(10, 10, 10));
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  for (const g of [tallSpread, withPlane, mixedWinding, thick]) assert.equal(canBeSingleSided({ geometry: g, material: mat }, 2, new Set()), false, "whole-mesh rule refuses");
  const count = (m: Uint8Array | null) => (m ? m.reduce((s, v) => s + v, 0) : 0);
  assert.equal(count(closedOutwardThinTriangles(tallSpread, 2)), 24, "both 1 m boxes");
  assert.equal(count(closedOutwardThinTriangles(withPlane, 2)), 12, "the box, not the plane");
  assert.equal(count(closedOutwardThinTriangles(mixedWinding, 2)), 12, "the outward box, not the inward one");
  assert.equal(count(closedOutwardThinTriangles(thick, 2)), 12, "the 1 m box, not the 3 m one");
  assert.equal(closedOutwardThinTriangles(new THREE.PlaneGeometry(2, 2), 2), null);
  // Weld: a box with a 0.2 mm crack (one corner of one face moved) is closed only with the 1 mm weld
  // (positions rounded to the millimetre grid).
  const cracked = box(1, 1, 1, 0).toNonIndexed();
  (cracked.getAttribute("position").array as Float32Array)[0] += 0.0002;
  assert.equal(closedOutwardThinTriangles(cracked, 2), null, "exact weld (default): the crack is an open edge");
  assert.equal(count(closedOutwardThinTriangles(cracked, 2, 1e-3)), 12, "1 mm weld: closed");
  // subsetTriangles: every attribute verbatim, triangles kept in order.
  const mask = closedOutwardThinTriangles(withPlane, 2)!;
  const solids = subsetTriangles(withPlane, mask, 1)!;
  const rest = subsetTriangles(withPlane, mask, 0)!;
  assert.equal(triangleCount(solids) + triangleCount(rest), triangleCount(withPlane));
  assert.deepEqual(Object.keys(solids.attributes).sort(), Object.keys(withPlane.attributes).sort());
  const indexed = new THREE.BoxGeometry(1, 1, 1);
  const half = new Uint8Array(12).map((_, t) => (t < 6 ? 1 : 0));
  const sub = subsetTriangles(indexed, half, 1)!;
  assert.ok(sub.index, "indexed source → indexed subset");
  assert.equal(triangleCount(sub), 6);

  // Real map: same triangles as before, the FrontSide set only grows.
  const perComp = buildStaticBatches(entries, (g) => mergeGeometries(g, false), {
    grid,
    chunkMinTriangles: 6000,
    singleSidedMaxThickness: 2,
    singleSidedPerComponent: true,
    keepMaterials: new Set(["GIV_Feu"]),
  });
  assert.deepEqual(signatures(perComp), before, "per component: exactly the original static triangles");
  const sided = (list: { geometry: THREE.BufferGeometry; material: THREE.Material; singleSided: boolean }[], one: boolean) =>
    signatures(list.filter((b) => b.singleSided === one));
  const todayFront = sided(batches, true);
  const nowFront = new Set(sided(perComp, true));
  for (const s of todayFront) assert.ok(nowFront.has(s), "every triangle single-sided today stays single-sided");
  for (const b of perComp) {
    assert.equal(b.material.side, b.singleSided ? THREE.FrontSide : THREE.DoubleSide);
    if (b.material.name === "GIV_Feu" || b.material.transparent) assert.equal(b.singleSided, false);
  }
  const tris = (list: { geometry: THREE.BufferGeometry; singleSided: boolean }[]) =>
    list.filter((b) => b.singleSided).reduce((s, b) => s + triangleCount(b.geometry), 0);
  const total = perComp.reduce((s, b) => s + triangleCount(b.geometry), 0);
  ok(
    `single-sided per connected component: ${tris(batches)} → ${tris(perComp)} of ${total} tris FrontSide ` +
      `(${((tris(batches) / total) * 100).toFixed(0)} → ${((tris(perComp) / total) * 100).toFixed(0)} %), ${batches.length} → ${perComp.length} batches, same triangles`,
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

console.log(`\nAll ${passed} GIVRE render-optim checks passed.`);

