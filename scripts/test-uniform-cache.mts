// UNIFORM CACHES (effects/UniformCacheKinds.ts) — every program uniform holds the same value at
// every moment. three.js's own uniform objects (WebGLUniforms, r185) are built twice over a fake
// WebGL context that keeps the GPU's uniform values (as float32, like the GPU), from the same
// program description (floats, vectors, matrices, bool / int uniforms, float arrays, structs,
// struct arrays); one set is optimized. The same long random sequence of values (repeats, -0 / 0,
// NaN, integers, Vector / Color / Matrix objects, plain and typed arrays, and now and then a value
// that is not a number) goes to both:
//   - single uniforms (raw-double caches + the setter copies): the very same GL calls, in the same
//     order — the copies against three's own setters;
//   - float arrays (upload on change): the GPU value of every uniform is the same after every
//     call, and the skipped calls are exactly the uploads of the value the GPU already holds;
//   - the caches keep three's contents.
// In V8, the raw-double caches stay raw doubles through the setter copies (natives syntax).
// A program is handled at its first getUniforms() after it is watched (never asked earlier), the
// wrapper removes itself.
// Usage (repo root):  npx tsx scripts/test-uniform-cache.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import { WebGLUniforms } from "three/src/renderers/webgl/WebGLUniforms.js";
import { doubleArrayOf, optimizeUniforms, watchProgram } from "../src/effects/UniformCacheKinds.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const T = {
  FLOAT: 0x1406, VEC2: 0x8b50, VEC3: 0x8b51, VEC4: 0x8b52, MAT3: 0x8b5b, MAT4: 0x8b5c, MAT2: 0x8b5a,
  INT: 0x1404, BOOL: 0x8b56,
};
const INFOS = [
  { name: "f", type: T.FLOAT, size: 1 },
  { name: "v2", type: T.VEC2, size: 1 },
  { name: "v3", type: T.VEC3, size: 1 },
  { name: "c3", type: T.VEC3, size: 1 },
  { name: "v4", type: T.VEC4, size: 1 },
  { name: "m2", type: T.MAT2, size: 1 },
  { name: "m3", type: T.MAT3, size: 1 },
  { name: "m4", type: T.MAT4, size: 1 },
  { name: "flag", type: T.BOOL, size: 1 },
  { name: "count", type: T.INT, size: 1 },
  { name: "arr[0]", type: T.MAT4, size: 2 },
  { name: "varr[0]", type: T.VEC3, size: 2 },
  { name: "farr[0]", type: T.FLOAT, size: 3 },
  { name: "light.color", type: T.VEC3, size: 1 },
  { name: "light.intensity", type: T.FLOAT, size: 1 },
  { name: "lights[0].dir", type: T.VEC3, size: 1 },
  { name: "lights[1].dir", type: T.VEC3, size: 1 },
  { name: "shadowMatrix[0]", type: T.MAT4, size: 1 },
];
const ARRAYS = new Set(["arr[0]", "varr[0]", "farr[0]", "shadowMatrix[0]"]);

type Call = [string, string, ...unknown[]];
const enc = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "number" ? (Object.is(x, -0) ? "-0" : Number.isNaN(x) ? "NaN" : x) : x));

/** A fake context: the calls made, and the value each uniform location holds (float32 for floats). */
function fakeGl() {
  const log: Call[] = [];
  const state = new Map<string, string>();
  const rec = (kind: string, float: boolean) => (loc: { name: string }, ...args: unknown[]) => {
    const vals = args.map((a) =>
      ArrayBuffer.isView(a) || Array.isArray(a)
        ? Array.from(a as ArrayLike<number>, (x) => (float ? Math.fround(x) : x))
        : typeof a === "number" && float
          ? Math.fround(a)
          : a,
    );
    log.push([kind, loc.name, ...vals]);
    state.set(loc.name, enc(vals));
  };
  const gl = {
    ACTIVE_UNIFORMS: 0x8b86,
    SAMPLER_2D_SHADOW: 0x8b62,
    SAMPLER_CUBE_SHADOW: 0x8dc5,
    SAMPLER_2D_ARRAY_SHADOW: 0x8dc4,
    getProgramParameter: () => INFOS.length,
    getActiveUniform: (_p: unknown, i: number) => INFOS[i],
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    uniform1f: rec("1f", true), uniform2f: rec("2f", true), uniform3f: rec("3f", true), uniform4f: rec("4f", true),
    uniform1fv: rec("1fv", true), uniform2fv: rec("2fv", true), uniform3fv: rec("3fv", true), uniform4fv: rec("4fv", true),
    uniform1i: rec("1i", false), uniform1iv: rec("1iv", false),
    uniformMatrix2fv: rec("m2", true), uniformMatrix3fv: rec("m3", true), uniformMatrix4fv: rec("m4", true),
  };
  return { gl, log, state };
}

let seed = 0x1234567;
const rnd = (): number => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const pool = [0, -0, 1, 0.5, 0.1 + 0.2, -3, 1e-30, 2 ** 31, Number.NaN, 1 + 2 ** -40];
const num = (): number => (rnd() < 0.7 ? pool[Math.floor(rnd() * 4)] : rnd() < 0.9 ? pool[Math.floor(rnd() * pool.length)] : rnd() * 10 - 5);
const mat4 = (): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  if (rnd() < 0.6) m.makeRotationY(num()).setPosition(num(), num(), num());
  return m;
};

function notNaNFirst<A extends { [i: number]: number }>(a: A): A {
  if (Number.isNaN(a[0])) a[0] = 0;
  return a;
}

/** Now and then a value three's own code never sends (the copies hand it back to three's setter). */
const odd = (): unknown => [true, null, undefined, "1"][Math.floor(rnd() * 4)];

function valueFor(name: string): unknown {
  switch (name) {
    case "f":
      return rnd() < 0.003 ? odd() : num();
    case "light.intensity":
      return num();
    case "v2":
      return rnd() < 0.003 ? [num(), odd()] : rnd() < 0.5 ? new THREE.Vector2(num(), num()) : [num(), num()];
    case "v3":
    case "light.color":
    case "lights[0].dir":
    case "lights[1].dir":
      return rnd() < 0.5 ? new THREE.Vector3(num(), num(), num()) : rnd() < 0.5 ? new Float32Array([num(), num(), num()]) : [num(), num(), num()];
    case "c3":
      return new THREE.Color(num(), num(), num());
    case "v4":
      return rnd() < 0.5 ? new THREE.Vector4(num(), num(), num(), num()) : [num(), num(), num(), num()];
    case "m2":
      return [num(), num(), num(), num()];
    case "m3": {
      const m = new THREE.Matrix3();
      if (rnd() < 0.6) m.set(num(), num(), num(), num(), num(), num(), num(), num(), num());
      return rnd() < 0.8 ? m : new Float32Array(m.elements);
    }
    case "m4": {
      const m = mat4();
      return rnd() < 0.8 ? m : new Float32Array(m.elements);
    }
    // (A flat array whose FIRST value is NaN is taken by three for an array of objects — and
    // throws: never sent by three's own code; the flat cases below start with a number.)
    case "arr":
      return rnd() < 0.7 ? [mat4(), mat4()] : notNaNFirst(new Float32Array([...mat4().elements, ...mat4().elements]));
    case "shadowMatrix":
      return rnd() < 0.8 ? [mat4()] : notNaNFirst(mat4().elements.slice()); // array of objects, or flat numbers
    case "varr":
      return rnd() < 0.7 ? [new THREE.Vector3(num(), num(), num()), new THREE.Vector3(num(), num(), num())] : notNaNFirst([num(), num(), num(), num(), num(), num()]);
    case "farr":
      return rnd() < 0.5 ? new Float32Array([num(), num(), num()]) : [num(), num(), num()];
    case "flag":
      return rnd() < 0.5;
    case "count":
      return Math.floor(rnd() * 3);
    default:
      throw new Error(name);
  }
}

const NAMES = ["f", "v2", "v3", "c3", "v4", "m2", "m3", "m4", "flag", "count", "arr", "varr", "farr", "shadowMatrix", "light", "lights"];

test("same GPU state after every call; same calls for single uniforms; only array repeats skipped (80 000 calls)", () => {
  const A = fakeGl();
  const B = fakeGl();
  const a = new WebGLUniforms(A.gl, {});
  const b = new WebGLUniforms(B.gl, {});
  const done = optimizeUniforms(b.seq as never);
  assert.ok(done.caches === 12 && done.setters === 12 && done.arrays === 4, `float caches: ${done.caches}, setter copies: ${done.setters}, arrays: ${done.arrays}`);
  let skipped = 0;
  for (let i = 0; i < 80000; i++) {
    const name = NAMES[Math.floor(rnd() * NAMES.length)];
    let value: unknown;
    if (name === "light") value = { color: valueFor("light.color"), intensity: valueFor("light.intensity") };
    else if (name === "lights") value = [{ dir: valueFor("lights[0].dir") }, { dir: valueFor("lights[1].dir") }];
    else value = valueFor(name);
    const repeats = rnd() < 0.4 ? 2 : 1; // the same object again: the cache-hit path
    for (let r = 0; r < repeats; r++) {
      const na = A.log.length;
      const nb = B.log.length;
      const before = new Map(B.state);
      a.setValue(A.gl, name, value);
      b.setValue(B.gl, name, value);
      const ca = A.log.slice(na);
      const cb = B.log.slice(nb);
      if (ca.length !== cb.length) {
        // only array uploads may be skipped, and only when the GPU already holds that value
        for (const call of ca) {
          const kept = cb.some((c) => enc(c) === enc(call));
          if (kept) continue;
          assert.ok(ARRAYS.has(call[1]), `skipped a non-array call: ${enc(call)}`);
          assert.equal(before.get(call[1]), enc(call.slice(2)), `skipped upload of a NEW value: ${enc(call)}`);
          skipped++;
        }
      } else {
        assert.equal(enc(cb), enc(ca), `call ${i}`);
      }
      assert.deepEqual(B.state, A.state, `GPU state after call ${i} (${name})`);
    }
  }
  const single = (log: Call[]) => log.filter((c) => !ARRAYS.has(c[1])).map(enc);
  assert.deepEqual(single(B.log), single(A.log), "single uniforms: the very same calls");
  assert.ok(skipped > 1000, `array repeats skipped: ${skipped}`);
  console.log(`    ${A.log.length} calls → ${B.log.length} (${skipped} array re-uploads of the same value skipped)`);
  // caches: same contents
  const caches = (u: WebGLUniforms) => {
    const out: unknown[] = [];
    const walk = (seq: { cache?: unknown[]; seq?: unknown[] }[]) => {
      for (const x of seq) {
        if (x.seq) walk(x.seq as never);
        else out.push(x.cache ? enc(Array.from(x.cache)) : null);
      }
    };
    walk(u.seq as never);
    return out;
  };
  assert.deepEqual(caches(b), caches(a));
});

test("the raw-double caches stay raw doubles through the setter copies (V8 element kinds)", () => {
  let hasDoubles: ((a: unknown) => boolean) | null = null;
  try {
    hasDoubles = new Function("a", "return %HasDoubleElements(a)") as (a: unknown) => boolean;
  } catch {
    console.log("    (skipped: run with node --allow-natives-syntax to check the element kinds)");
    return;
  }
  const { gl } = fakeGl();
  const IDS = ["m4", "m3", "v3", "c3", "f"];
  const run = (u: WebGLUniforms, n: number) => {
    for (let i = 0; i < n; i++) {
      u.setValue(gl, "m4", mat4());
      u.setValue(gl, "m3", new THREE.Matrix3().set(num(), num(), num(), num(), num(), num(), num(), num(), num()));
      u.setValue(gl, "v3", new THREE.Vector3(num(), num(), num()));
      u.setValue(gl, "c3", new THREE.Color(num(), num(), num()));
      u.setValue(gl, "f", rnd());
    }
  };
  const map = (u: WebGLUniforms) => u.map as Record<string, { cache: unknown[] }>;
  // As in the game: three's setters first run (and get optimized) on GENERIC caches (in the
  // browser, a bool uniform turns the allocation site of three's cache literal).
  const generic = (): unknown[] => {
    const g: unknown[] = [{}];
    g.pop();
    return g;
  };
  const warm = new WebGLUniforms(gl, {});
  for (const id of IDS) map(warm)[id].cache = generic();
  run(warm, 20000);
  // Control: raw-double caches with three's own setters (what the first version did).
  const control = new WebGLUniforms(gl, {});
  for (const id of IDS) map(control)[id].cache = doubleArrayOf([])!;
  run(control, 20000);
  const turned = IDS.filter((id) => !hasDoubles!(map(control)[id].cache)).length;
  console.log(`    three's own setters turned ${turned} of ${IDS.length} raw-double caches generic`);
  // The setter copies: raw doubles to the end.
  const b = new WebGLUniforms(gl, {});
  optimizeUniforms(b.seq as never);
  run(b, 20000);
  for (const id of IDS) assert.ok(hasDoubles!(map(b)[id].cache), `${id}: raw doubles`);
});

test("a value that is not a number: that uniform goes back to three's setter for good, same calls", () => {
  const A = fakeGl();
  const B = fakeGl();
  const a = new WebGLUniforms(A.gl, {});
  const b = new WebGLUniforms(B.gl, {});
  optimizeUniforms(b.seq as never);
  const own = (b.map as Record<string, { setValue: unknown }>).f.setValue;
  for (const v of [1, 1, true, true, 2, null, null, 3, "4", 4]) {
    a.setValue(A.gl, "f", v);
    b.setValue(B.gl, "f", v);
  }
  assert.equal(enc(B.log), enc(A.log));
  assert.notEqual((b.map as Record<string, { setValue: unknown }>).f.setValue, own, "three's setter again");
});

test("+0 then -0 in a float array is uploaded (the GPU keeps the sign)", () => {
  const A = fakeGl();
  const u = new WebGLUniforms(A.gl, {});
  optimizeUniforms(u.seq as never);
  u.setValue(A.gl, "farr", [0, 1, 2]);
  u.setValue(A.gl, "farr", [-0, 1, 2]);
  u.setValue(A.gl, "farr", [-0, 1, 2]);
  u.setValue(A.gl, "farr", [Number.NaN, 1, 2]);
  u.setValue(A.gl, "farr", [Number.NaN, 1, 2]); // NaN never equals: uploaded again (three's rule)
  assert.equal(A.log.filter((c) => c[1] === "farr[0]").length, 4);
});

test("doubleArrayOf: same values, plain array; null when a value is not a number", () => {
  const d = doubleArrayOf([1, 0.5, -0, Number.NaN]);
  assert.ok(Array.isArray(d));
  assert.equal(d!.length, 4);
  assert.ok(Object.is(d![2], -0) && Number.isNaN(d![3]));
  assert.equal(doubleArrayOf([1, true]), null);
  assert.equal(doubleArrayOf([1, undefined]), null);
  assert.deepEqual(doubleArrayOf([]), []);
});

test("watchProgram: handled at its next getUniforms(), the wrapper removes itself, never asks early", () => {
  let created = 0;
  let uniforms: WebGLUniforms | undefined;
  const { gl } = fakeGl();
  const program = {
    getUniforms() {
      if (!uniforms) {
        created++;
        uniforms = new WebGLUniforms(gl, {});
      }
      return uniforms;
    },
  };
  const own = program.getUniforms;
  watchProgram(program as never);
  assert.equal(created, 0, "the watch does not create the uniforms");
  assert.notEqual(program.getUniforms, own);
  const u = program.getUniforms();
  assert.equal(created, 1);
  assert.equal(program.getUniforms, own, "wrapper removed");
  const m4 = (u.map as Record<string, { cache: number[] }>).m4;
  u.setValue(gl, "m4", new THREE.Matrix4().makeTranslation(1, 2, 3));
  const before = Array.from(m4.cache);
  optimizeUniforms(u.seq as never); // a second pass changes nothing
  assert.deepEqual(Array.from(m4.cache), before);
  watchProgram(program as never); // twice: no second wrapper
  assert.equal(program.getUniforms, own);
});

console.log(`test-uniform-cache: ${passed} passed`);
