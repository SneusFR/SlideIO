// PROGRAM-FIRST OPAQUE SORT (world/GivreRenderOptim.ts programFirstOpaqueSort, `?diag=programsort`):
// groupOrder and renderOrder stay first (prepass proxies, stencil contracts), then the program three
// last drew the material with, then the material, near → far, object id; a material without a
// program yet goes after its group; the rank is read once per item and per render() call.
// Usage (repo root):  npx tsx scripts/test-program-sort.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import { frontToBackOpaqueSort, programFirstOpaqueSort } from "../src/world/GivreRenderOptim.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** renderer.properties / info.render, as far as the sort reads them. */
function fakeRenderer() {
  const props = new Map<object, Record<string, unknown>>();
  let reads = 0;
  const renderer = {
    properties: {
      get(o: object) {
        reads++;
        let p = props.get(o);
        if (!p) props.set(o, (p = {}));
        return p;
      },
    },
    info: { render: { frame: 0 } },
  };
  const setProgram = (m: THREE.Material, id: number | null) => {
    renderer.properties.get(m).currentProgram = id === null ? undefined : { id };
    reads--;
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, setProgram, reads: () => reads, frame: renderer.info.render };
}

let nextId = 1;
function item(material: THREE.Material, z: number, extra: Partial<THREE.RenderItem> = {}): THREE.RenderItem {
  return { id: nextId++, object: new THREE.Object3D(), geometry: null, material, groupOrder: 0, renderOrder: 0, z, group: null, ...extra } as unknown as THREE.RenderItem;
}

test("program first, then material, then near → far, then id", () => {
  const f = fakeRenderer();
  const [m1, m2, m3, m4] = [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial());
  f.setProgram(m1, 20);
  f.setProgram(m2, 10);
  f.setProgram(m3, 20);
  f.setProgram(m4, null); // not drawn yet
  const a = item(m1, 5), b = item(m2, 9), c = item(m3, 1), d = item(m1, 2), e = item(m4, 0), g = item(m2, 9);
  const list = [a, b, c, d, e, g].sort(programFirstOpaqueSort(f.renderer));
  // program 10 (m2: z 9, 9 → by id), program 20 (m1 before m3 by material id: m1 z2, z5; then m3), no program last
  assert.deepEqual(list, [b, g, d, a, c, e]);
  // the reference sort is strictly near → far
  assert.deepEqual([a, b, c, d, e, g].sort(frontToBackOpaqueSort).map((i) => i.z), [0, 1, 2, 5, 9, 9]);
});

test("groupOrder and renderOrder stay above the program", () => {
  const f = fakeRenderer();
  const m1 = new THREE.MeshStandardMaterial(), m2 = new THREE.MeshStandardMaterial();
  f.setProgram(m1, 1);
  f.setProgram(m2, 2);
  const proxy = item(m2, 50, { groupOrder: -1000 });
  const late = item(m1, 0, { renderOrder: 3 });
  const x = item(m2, 1), y = item(m1, 9);
  assert.deepEqual([x, late, y, proxy].sort(programFirstOpaqueSort(f.renderer)), [proxy, y, x, late]);
});

test("one rank read per item and per render() call", () => {
  const f = fakeRenderer();
  const mats = Array.from({ length: 12 }, () => new THREE.MeshStandardMaterial());
  mats.forEach((m, i) => f.setProgram(m, i % 3));
  const items = mats.map((m, i) => item(m, (i * 7) % 5));
  const sort = programFirstOpaqueSort(f.renderer);
  const before = f.reads();
  items.slice().sort(sort);
  assert.equal(f.reads() - before, items.length);
  items.slice().sort(sort); // same render() call: cached
  assert.equal(f.reads() - before, items.length);
  f.frame.frame++; // next render(): read again (a program may have changed)
  f.setProgram(mats[0], 99);
  const again = items.slice().sort(sort);
  assert.equal(f.reads() - before, 2 * items.length);
  assert.equal(again[again.length - 1].material, mats[0]);
});

test("a pass with an override material keeps the front-to-back order", () => {
  const f = fakeRenderer();
  const world = new THREE.Scene();
  const m1 = new THREE.MeshStandardMaterial(), m2 = new THREE.MeshStandardMaterial();
  f.setProgram(m1, 2);
  f.setProgram(m2, 1);
  const items = [item(m1, 1), item(m2, 3), item(m1, 2), item(m2, 0)];
  const sort = programFirstOpaqueSort(f.renderer, world);
  assert.deepEqual(items.slice().sort(sort).map((i) => i.z), [0, 3, 1, 2]); // program 1, then 2
  world.overrideMaterial = new THREE.MeshNormalMaterial(); // outline pre-pass
  f.frame.frame++;
  assert.deepEqual(items.slice().sort(sort).map((i) => i.z), [0, 1, 2, 3]);
  assert.deepEqual(items.slice().sort(sort), items.slice().sort(frontToBackOpaqueSort));
});

console.log(`program sort: ${passed} tests passed`);
