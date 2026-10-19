// CORPSE CLONE PREPARED OFF THE KILL FRAME (ragdoll/CorpseCloneSpare.ts, BotModel.createCorpseVisual):
// headless check that the corpse built from the prepared spare is the SAME object graph the reference clone
// (cloneCorpseModel, the former kill-frame path) builds at the moment of death — every node, every property,
// skeletons, bounds — and that any change of the body's shape since the preparation falls back to the clone.
// Real BotModel on the real Potato asset and the real weapon GLBs (Vite SSR, no browser).
// Usage (repo root):  npx --prefix backend tsx scripts/test-corpse-spare.mts
import fs from "node:fs";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
const g = globalThis as unknown as Record<string, unknown>;
g.self = globalThis;
g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
process.on("unhandledRejection", () => {}); // optional weapon GLBs (Meshopt) may not decode headless
function fakeEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    id: "", className: "", children: [] as unknown[], width: 0, height: 0,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c: unknown) { (el.children as unknown[]).push(c); },
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
  };
  return el;
}
g.document = { createElement: () => fakeEl(), body: { appendChild() {} } };
const read = async (file: string): Promise<GLTF> => {
  const b = fs.readFileSync(file);
  return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
};
const findAsset = (name: string): string | null => {
  const stack = [`${project}/src/assets`];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(`${dir}/${e.name}`);
      else if (e.name === name) return `${dir}/${e.name}`;
    }
  }
  return null;
};
GLTFLoader.prototype.loadAsync = async function (url: string) {
  const name = url.split("/").pop()!.split("?")[0];
  const file = findAsset(name);
  if (!file) throw new Error(`asset not found: ${name}`);
  return read(file);
};

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---- Deep comparison of two corpse graphs (reference clone vs prepared spare) ----
const SKIP = new Set(["uuid", "id", "parent", "children"]);
function deepEqualGraph(ref: THREE.Object3D, got: THREE.Object3D): { nodes: number; props: number } {
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  const walk = (a: THREE.Object3D, b: THREE.Object3D, path: string) => {
    assert.equal(b.constructor, a.constructor, `${path}: node class`);
    assert.equal(b.children.length, a.children.length, `${path}: child count`);
    map.set(a, b);
    a.children.forEach((c, i) => walk(c, b.children[i], `${path}/${c.name || c.type}[${i}]`));
  };
  walk(ref, got, ref.name || "root");
  let props = 0;
  const seen = new Set<unknown>();
  const same = (x: unknown, y: unknown, path: string): void => {
    if (x === y) return;
    if (typeof x === "function" && typeof y === "function") return; // per-instance callbacks
    assert.ok(x !== null && y !== null && typeof x === "object" && typeof y === "object", `${path}: ${String(x)} vs ${String(y)}`);
    if ((x as THREE.Object3D).isObject3D) {
      assert.equal(map.get(x as THREE.Object3D), y, `${path}: object reference maps to its counterpart`);
      return;
    }
    // Shared resources must be the very same objects (geometry, material, texture).
    if ((x as THREE.Material).isMaterial || (x as THREE.BufferGeometry).isBufferGeometry || (x as THREE.Texture).isTexture) {
      assert.equal(y, x, `${path}: shared resource identity`);
      return;
    }
    if (seen.has(x)) return;
    seen.add(x);
    assert.equal(Object.getPrototypeOf(y), Object.getPrototypeOf(x), `${path}: value class`);
    if (ArrayBuffer.isView(x)) {
      const xa = x as unknown as ArrayLike<number>, ya = y as unknown as ArrayLike<number>;
      assert.equal(ya.length, xa.length, `${path}: length`);
      for (let i = 0; i < xa.length; i++) assert.ok(Object.is(xa[i], ya[i]), `${path}[${i}]: ${xa[i]} vs ${ya[i]}`);
      props++;
      return;
    }
    const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      props++;
      same((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
    }
  };
  for (const [a, b] of map) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      props++;
      same((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k], `${a.name || a.type}.${k}`);
    }
  }
  return { nodes: map.size, props };
}

const server = await createServer({ root: project, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { loadCharacterAsset } = await server.ssrLoadModule("/src/characters/PotatoCharacter.ts");
  await loadCharacterAsset();
  const { BotModel } = await server.ssrLoadModule("/src/bots/BotModel.ts");
  const { cloneCorpseModel } = await server.ssrLoadModule("/src/ragdoll/CorpseCloneSpare.ts");
  const { PRIMARY_WEAPON_IDS } = await server.ssrLoadModule("/src/loadout/Loadout.ts");
  const { HitZone } = await server.ssrLoadModule("/src/combat/HitZone.ts");

  type Pose = { yaw: number; pitch: number; speed: number; sliding: boolean; grounded: boolean; dashing: boolean; velocityY: number; vx: number; vz: number };
  const run: Pose = { yaw: 0.4, pitch: 0.1, speed: 9.5, sliding: false, grounded: true, dashing: false, velocityY: 0, vx: 3, vz: 9 };
  const jump: Pose = { ...run, grounded: false, velocityY: 6, speed: 6 };
  const camQuat = new THREE.Quaternion();
  let time = 0;
  type BM = InstanceType<typeof BotModel> & {
    characterModel: THREE.Object3D;
    corpseSpare: { ready: boolean; matches(m: THREE.Object3D): boolean };
    weapons: { update(dt: number): void } | null;
  };
  const frames = (bm: BM, pose: Pose, n: number) => {
    for (let i = 0; i < n; i++) {
      time += 1 / 60;
      bm.update(1 / 60, pose, 0.6, camQuat, false, time);
    }
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
  };
  /** The reference corpse group (former kill-frame path) for the bot's CURRENT state. */
  const referenceCorpse = (bm: BM) => {
    const corpse = new THREE.Group();
    corpse.position.copy(bm.group.position);
    corpse.quaternion.copy(bm.group.quaternion);
    corpse.scale.copy(bm.group.scale);
    corpse.add(cloneCorpseModel(bm.characterModel));
    corpse.updateMatrixWorld(true);
    return corpse;
  };
  const makeBot = async (weapon: string) => {
    const bm = new BotModel(3) as BM;
    for (let i = 0; i < 100 && !bm.characterModel; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(bm.characterModel, "character attached");
    const holder = new THREE.Scene();
    holder.add(bm.group);
    bm.group.position.set(2, 1.1, -3);
    bm.setWeapon(weapon);
    await settle(); // weapon GLB attached (async, like in game)
    frames(bm, run, 30);
    return bm;
  };
  const nodeCount = (o: THREE.Object3D) => {
    let n = 0;
    o.traverse(() => n++);
    return n;
  };

  const timings: { weapon: string; nodes: number; clone: number; take: number }[] = [];
  for (const weapon of PRIMARY_WEAPON_IDS as readonly string[]) {
    await test(`${weapon}: corpse from the prepared spare == reference clone at death (pose, flash, materials)`, async () => {
      const bm = await makeBot(weapon);
      bm.prepareCorpseVisual();
      assert.ok(bm.corpseSpare.ready, "spare prepared");
      // Life goes on after the preparation: new pose, a hit flash, a material swap (paint patch path).
      frames(bm, jump, 23);
      bm.hitFlash(HitZone.HEAD);
      frames(bm, run, 7);
      let body: THREE.Mesh | null = null;
      bm.characterModel.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!body && m.isMesh && !m.userData.enemyOutline && !Array.isArray(m.material)) body = m;
      });
      assert.ok(body, "a body mesh");
      const previous = (body as THREE.Mesh).material as THREE.Material;
      const painted = previous.clone();
      (body as THREE.Mesh).material = painted;
      bm.replaceBodyMaterials([previous], [painted]);
      bm.characterModel.updateMatrixWorld(true);
      assert.ok(bm.corpseSpare.matches(bm.characterModel), "same shape since the preparation: the spare is used");
      const ref = referenceCorpse(bm);
      const got = bm.createCorpseVisual();
      assert.equal(bm.corpseSpare.ready, false, "spare consumed");
      const r = deepEqualGraph(ref, got);
      assert.ok(r.nodes > 50, `whole character compared (${r.nodes} nodes)`);
      console.log(`    ${r.nodes} nodes, ${r.props} properties identical`);
    });
  }

  await test("shape changed since the preparation (weapon swapped) → reference clone, then a new spare", async () => {
    const bm = await makeBot(PRIMARY_WEAPON_IDS[0]);
    bm.prepareCorpseVisual();
    const before = nodeCount(bm.characterModel);
    bm.setWeapon(PRIMARY_WEAPON_IDS[1]);
    await settle();
    frames(bm, run, 5);
    const after = nodeCount(bm.characterModel);
    if (after === before) console.log("    (weapon swap kept the node count: parent/identity check still applies)");
    assert.equal(bm.corpseSpare.matches(bm.characterModel), false, "stale spare detected");
    const ref = referenceCorpse(bm);
    const got = bm.createCorpseVisual();
    deepEqualGraph(ref, got);
    bm.prepareCorpseVisual();
    assert.ok(bm.corpseSpare.matches(bm.characterModel), "rebuilt on the next calm frame");
    frames(bm, run, 11);
    const ref2 = referenceCorpse(bm);
    const got2 = bm.createCorpseVisual();
    deepEqualGraph(ref2, got2);
  });

  await test("a node added under a bone since the preparation → stale spare, reference clone", async () => {
    const bm = await makeBot(PRIMARY_WEAPON_IDS[0]);
    bm.prepareCorpseVisual();
    const hand = bm.characterModel.getObjectByName("Hand_R")!;
    hand.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial()));
    assert.equal(bm.corpseSpare.matches(bm.characterModel), false);
    deepEqualGraph(referenceCorpse(bm), bm.createCorpseVisual());
  });

  await test("timing: createCorpseVisual in the kill frame, cloned vs prepared (median of 40 deaths)", async () => {
    const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    for (const weapon of PRIMARY_WEAPON_IDS as readonly string[]) {
      const bm = await makeBot(weapon);
      const spare = bm.corpseSpare as unknown as { reset(): void };
      const cloned: number[] = [], prepared: number[] = [];
      for (let i = 0; i < 90; i++) {
        frames(bm, i % 2 ? run : jump, 1);
        const usePrepared = i % 2 === 0;
        if (usePrepared) bm.prepareCorpseVisual();
        else spare.reset();
        const t0 = performance.now();
        bm.createCorpseVisual();
        const t = performance.now() - t0;
        if (i >= 10) (usePrepared ? prepared : cloned).push(t);
      }
      timings.push({ weapon, nodes: nodeCount(bm.characterModel), clone: median(cloned), take: median(prepared) });
    }
    for (const t of timings) {
      console.log(`    ${t.weapon.padEnd(16)} ${t.nodes} nodes: cloned ${(t.clone * 1000).toFixed(0)} µs → prepared ${(t.take * 1000).toFixed(0)} µs`);
    }
    for (const t of timings) assert.ok(t.take < t.clone, `${t.weapon}: the prepared path is cheaper`);
  });

  console.log(`\n${passed} corpse spare tests passed`);
} finally {
  await server.close();
}
