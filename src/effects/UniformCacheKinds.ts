import { REVISION } from "three";
import type * as THREE from "three";
import { optSwitch } from "../ui/perfDiag";

/**
 * PERF (render submission, garbage) — three.js's uniform value caches hold raw doubles again.
 *
 * Each uniform of each program remembers the value it last sent (`cache`, a plain array) so that
 * an unchanged value is not uploaded twice. Those arrays come from one array literal inside
 * three.js (SingleUniform), and V8 tracks the element kind of every array created by a literal:
 * once ONE of them held a boolean (a `bool` uniform), every cache created afterwards started as
 * an array of generic values — measured on Givre: every cache of every program. In such an array
 * each number written is boxed in a new heap object: every changed matrix uniform (model-view,
 * normal and model matrices, camera…) allocated 16 of them, ~22 KB of garbage per frame with
 * 8 bots in view (a fifth of the frame's allocations), and every comparison read through a
 * pointer.
 *
 * The cache of each single float uniform (float, vec2-4, mat2-4) is replaced, once per program,
 * by an array of raw doubles with the same contents (same length, same values). Replacing the
 * arrays is not enough: three's setters, optimized by V8 while they only saw generic arrays,
 * turn every raw-double array they write into back into a generic one. So these uniforms also
 * get their own copy of three's setter (r185, below): the same reads, the same comparisons, the
 * same GL calls, the same cache writes — functions that only ever see raw-double caches. A value
 * that is not a plain number (never sent by three's own code) sends that uniform back to three's
 * setter for good, which then does exactly what it always did.
 *
 * Uniform ARRAYS of floats (vec / mat arrays: the shadow matrix of the directional light…) have
 * no cache at all in three.js: their setter uploads at every call. The light uniforms are sent
 * again at every program switch, and with the opaques drawn near → far the program changes at
 * nearly every draw: the same shadow matrix was uploaded ~70 times per frame with 8 bots in view.
 * Each float array uniform now remembers the data it last uploaded (as the GPU received it:
 * float32) and uploads only when it differs — with the same comparison three uses for the single
 * uniforms, made stricter for zeros (+0 / -0 kept apart): every program uniform holds, at every
 * draw, exactly the value it held before; only the repeats of the same value are gone.
 *
 * A program is handled at the first `getUniforms()` after it was seen (`watchProgram`, from
 * ProgramPin's per-frame scan): three creates its uniforms at its first use. Never earlier —
 * creating them would wait for a program still being linked in parallel during the loading.
 * `?diag=nouniformcache`: three's own caches and setters, unchanged. (DEV live switch
 * `__cpuOpt.uniformcache`: the array uploads only — the caches and setters stay.)
 * Written against three r185 (its uniform objects, its setters copied below): with another
 * revision nothing is touched — compare with the new WebGLUniforms.js, run
 * scripts/test-uniform-cache.mts, then bump SETTERS_REVISION.
 */
const uniformCache = optSwitch("uniformcache");
const SETTERS_REVISION = "185";
const sameThree = REVISION === SETTERS_REVISION;

/** WebGL float uniform types (FLOAT, FLOAT_VEC2..4, FLOAT_MAT2..4, non-square matrices). */
const FLOAT_TYPES = new Set<number>([
  0x1406, 0x8b50, 0x8b51, 0x8b52, 0x8b5a, 0x8b5b, 0x8b5c, 0x8b65, 0x8b66, 0x8b67, 0x8b68, 0x8b69, 0x8b6a,
]);

/** Source of empty arrays of doubles: `slice` keeps the element kind, and has no allocation site. */
const DOUBLES: number[] = [0.5];

type GL = WebGL2RenderingContext;
type Setter = (this: UniformLike, gl: GL, value: unknown, textures?: unknown) => void;

interface UniformLike {
  cache?: unknown[];
  type?: number;
  addr?: WebGLUniformLocation | null;
  /** Array uniforms (three's PureArrayUniform): element count. */
  size?: number;
  seq?: UniformLike[];
  setValue?: Setter;
}

/** A single float uniform once handled: raw-double cache, location. */
interface FloatUniform extends UniformLike {
  cache: number[];
  addr: WebGLUniformLocation | null;
}

// ---- three r185's single float setters (WebGLUniforms.js), for raw-double caches only ----

const mat2array = new Float32Array(4);
const mat3array = new Float32Array(9);
const mat4array = new Float32Array(16);
/** three's own setter of each uniform given one of the copies below (fallback). */
const threeSetters = new WeakMap<object, Setter>();

/** three's `arraysEqual` (here `a` is always a raw-double cache). */
function arraysEqual(a: number[], b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0, l = a.length; i < l; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** three's `copyArray` (numbers only: checked by the caller). */
function copyArray(a: number[], b: ArrayLike<number>): void {
  for (let i = 0, l = b.length; i < l; i++) a[i] = b[i];
}

function allNumbers(b: ArrayLike<unknown>): boolean {
  for (let i = 0, l = b.length; i < l; i++) if (typeof b[i] !== "number") return false;
  return true;
}

/** Not a plain number to store: this uniform goes back to three's own setter, for good. */
function fallBack(u: FloatUniform, gl: GL, v: unknown): void {
  const own = threeSetters.get(u)!;
  u.setValue = own;
  own.call(u, gl, v);
}

type Vec = { x?: unknown; y?: unknown; z?: unknown; w?: unknown; r?: unknown; g?: unknown; b?: unknown };
const num = (x: unknown): x is number => typeof x === "number";

function setValueV1f(this: FloatUniform, gl: GL, v: unknown): void {
  const cache = this.cache;
  if (cache[0] === v) return;
  if (!num(v)) return fallBack(this, gl, v);
  gl.uniform1f(this.addr, v);
  cache[0] = v;
}

function setValueV2f(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Vec & ArrayLike<unknown>;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y) {
      if (!num(v.x) || !num(v.y)) return fallBack(this, gl, value);
      gl.uniform2f(this.addr, v.x, v.y);
      cache[0] = v.x;
      cache[1] = v.y;
    }
  } else {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniform2fv(this.addr, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  }
}

function setValueV3f(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Vec & ArrayLike<unknown>;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z) {
      if (!num(v.x) || !num(v.y) || !num(v.z)) return fallBack(this, gl, value);
      gl.uniform3f(this.addr, v.x, v.y, v.z);
      cache[0] = v.x;
      cache[1] = v.y;
      cache[2] = v.z;
    }
  } else if (v.r !== undefined) {
    if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b) {
      if (!num(v.r) || !num(v.g) || !num(v.b)) return fallBack(this, gl, value);
      gl.uniform3f(this.addr, v.r, v.g, v.b);
      cache[0] = v.r;
      cache[1] = v.g;
      cache[2] = v.b;
    }
  } else {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniform3fv(this.addr, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  }
}

function setValueV4f(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Vec & ArrayLike<unknown>;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z || cache[3] !== v.w) {
      if (!num(v.x) || !num(v.y) || !num(v.z) || !num(v.w)) return fallBack(this, gl, value);
      gl.uniform4f(this.addr, v.x, v.y, v.z, v.w);
      cache[0] = v.x;
      cache[1] = v.y;
      cache[2] = v.z;
      cache[3] = v.w;
    }
  } else {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniform4fv(this.addr, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  }
}

type Mat = { elements?: ArrayLike<unknown> } & ArrayLike<unknown>;

function setValueM2(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Mat;
  const elements = v.elements;
  if (elements === undefined) {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniformMatrix2fv(this.addr, false, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  } else {
    if (arraysEqual(cache, elements)) return;
    if (!allNumbers(elements)) return fallBack(this, gl, value);
    mat2array.set(elements as ArrayLike<number>);
    gl.uniformMatrix2fv(this.addr, false, mat2array);
    copyArray(cache, elements as ArrayLike<number>);
  }
}

function setValueM3(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Mat;
  const elements = v.elements;
  if (elements === undefined) {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniformMatrix3fv(this.addr, false, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  } else {
    if (arraysEqual(cache, elements)) return;
    if (!allNumbers(elements)) return fallBack(this, gl, value);
    mat3array.set(elements as ArrayLike<number>);
    gl.uniformMatrix3fv(this.addr, false, mat3array);
    copyArray(cache, elements as ArrayLike<number>);
  }
}

function setValueM4(this: FloatUniform, gl: GL, value: unknown): void {
  const cache = this.cache;
  const v = value as Mat;
  const elements = v.elements;
  if (elements === undefined) {
    if (arraysEqual(cache, v)) return;
    if (!allNumbers(v)) return fallBack(this, gl, value);
    gl.uniformMatrix4fv(this.addr, false, v as Float32List);
    copyArray(cache, v as ArrayLike<number>);
  } else {
    if (arraysEqual(cache, elements)) return;
    if (!allNumbers(elements)) return fallBack(this, gl, value);
    mat4array.set(elements as ArrayLike<number>);
    gl.uniformMatrix4fv(this.addr, false, mat4array);
    copyArray(cache, elements as ArrayLike<number>);
  }
}

/** three's getSingularSetter, float types (r185). */
const FLOAT_SETTERS = new Map<number, (this: FloatUniform, gl: GL, value: unknown) => void>([
  [0x1406, setValueV1f],
  [0x8b50, setValueV2f],
  [0x8b51, setValueV3f],
  [0x8b52, setValueV4f],
  [0x8b5a, setValueM2],
  [0x8b5b, setValueM3],
  [0x8b5c, setValueM4],
]);

// ---- Float uniform ARRAYS: upload on change ----

/** Floats per element of the float uniform ARRAY types (FLOAT, VEC2..4, MAT2..4). */
const ARRAY_BLOCK = new Map<number, number>([
  [0x1406, 1],
  [0x8b50, 2],
  [0x8b51, 3],
  [0x8b52, 4],
  [0x8b5a, 4],
  [0x8b5b, 9],
  [0x8b5c, 16],
]);

/** Same value for the GPU: `!==` as three's caches, but +0 and -0 kept apart. */
function sameFloat(a: number, b: number): boolean {
  return a === b && (a !== 0 || 1 / a === 1 / b);
}

interface FlatSource {
  readonly length: number;
  readonly [i: number]: number | { toArray(out: Float32Array, offset: number): unknown };
}

/**
 * An uploading-only-on-change setter for a float uniform ARRAY (`u.size` elements of `block`
 * floats), wrapping three's own setter (which flattens and uploads). The data compared is the
 * data three uploads: the value itself when its first element is a number (already flat), else
 * the elements written one after the other into floats (three's `flatten`).
 */
function cachedArraySetter(u: UniformLike, block: number): void {
  const upload = u.setValue!;
  const size = u.size ?? 1;
  const scratch = new Float32Array(size * block);
  let last = new Float32Array(0);
  let lastLength = -1;
  u.setValue = function (this: UniformLike, gl, value, textures) {
    if (!uniformCache.on) {
      // switched off live (DEV checks): three's setter, and nothing remembered
      lastLength = -1;
      upload.call(this, gl, value, textures);
      return;
    }
    const v = value as FlatSource;
    const first = v[0];
    let data: ArrayLike<number>;
    if (block === 1 || (typeof first === "number" && (first <= 0 || first > 0))) {
      data = v as ArrayLike<number>;
    } else if (first && typeof (first as { toArray?: unknown }).toArray === "function") {
      (first as { toArray(out: Float32Array, offset: number): unknown }).toArray(scratch, 0);
      for (let i = 1, offset = 0; i !== size; ++i) {
        offset += block;
        (v[i] as { toArray(out: Float32Array, offset: number): unknown }).toArray(scratch, offset);
      }
      data = scratch;
    } else {
      upload.call(this, gl, value, textures); // anything else: three's own path, every time
      lastLength = -1;
      return;
    }
    const n = data.length;
    if (n === lastLength) {
      let same = true;
      for (let i = 0; i < n; i++) {
        if (!sameFloat(last[i], Math.fround(data[i]))) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    upload.call(this, gl, value, textures);
    if (last.length < n) last = new Float32Array(n);
    for (let i = 0; i < n; i++) last[i] = data[i];
    lastLength = n;
  };
}

/** An array of doubles with the values of `values`, or null if one is not a number (kept as is). */
export function doubleArrayOf(values: readonly unknown[]): number[] | null {
  const out = DOUBLES.slice(0, 0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number") return null;
    out.push(v);
  }
  return out;
}

const handled = new WeakSet<object>();

/**
 * The uniforms of `seq` (nested structs included), handled once: raw-double caches and the
 * setter copies for the single float uniforms, an upload-on-change setter for the float uniform
 * arrays. Returns how many of each.
 */
export function optimizeUniforms(seq: readonly UniformLike[]): { caches: number; setters: number; arrays: number } {
  const done = { caches: 0, setters: 0, arrays: 0 };
  const walk = (list: readonly UniformLike[]): void => {
    for (const u of list) {
      if (u.seq) {
        walk(u.seq);
        continue;
      }
      if (handled.has(u) || u.type === undefined) continue;
      handled.add(u);
      if (u.size !== undefined) {
        // three's PureArrayUniform (float arrays upload at every call)
        const block = ARRAY_BLOCK.get(u.type);
        if (block !== undefined && typeof u.setValue === "function") {
          cachedArraySetter(u, block);
          done.arrays++;
        }
        continue;
      }
      if (!Array.isArray(u.cache) || !FLOAT_TYPES.has(u.type)) continue;
      const doubles = doubleArrayOf(u.cache);
      if (!doubles) continue;
      u.cache = doubles;
      done.caches++;
      const own = FLOAT_SETTERS.get(u.type);
      if (own && typeof u.setValue === "function") {
        threeSetters.set(u, u.setValue);
        u.setValue = own as Setter;
        done.setters++;
      }
    }
  };
  walk(seq);
  return done;
}

const watched = new WeakSet<object>();

/**
 * `optimizeUniforms` for `program`, at its next `getUniforms()` (three's own call, at the next
 * draw that uses it — the uniforms exist by then). The wrapper removes itself on that call.
 */
export function watchProgram(program: THREE.WebGLProgram): void {
  if (!uniformCache.on || !sameThree || watched.has(program)) return;
  watched.add(program);
  const target = program as unknown as { getUniforms: () => { seq: UniformLike[] } };
  const getUniforms = target.getUniforms;
  if (typeof getUniforms !== "function") return;
  target.getUniforms = function (this: unknown) {
    const uniforms = getUniforms.call(this);
    target.getUniforms = getUniforms;
    if (uniforms && Array.isArray(uniforms.seq)) optimizeUniforms(uniforms.seq);
    return uniforms;
  };
}
