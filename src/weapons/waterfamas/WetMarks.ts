import * as THREE from "three";
function rng(seed: number): () => number {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const PUDDLE_GLSL = /* glsl */ `
float h1(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
// p in [-1, 1]^2 (quad space, +Y = up on a wall). drip = 1 on walls: water runs down in streaks.
float puddle(vec2 p, float seed, float drip) {
  vec2 c0 = vec2(0.0, 0.22 * drip);
  vec2 q = p - c0;
  float r = length(q);
  float a = atan(q.y, q.x);
  float edge = 0.56 + 0.08 * sin(a * 3.0 + seed * 6.283) + 0.06 * sin(a * 5.0 + seed * 11.7) + 0.035 * sin(a * 9.0 + seed * 2.9);
  edge *= 1.0 - 0.25 * drip;
  float m = 1.0 - smoothstep(edge - 0.08, edge, r);
  for (int k = 0; k < 5; k++) {                         // satellite drops
    float fk = float(k);
    float ang = seed * 17.0 + fk * 1.3;
    vec2 c = c0 + vec2(cos(ang), sin(ang)) * (0.62 + 0.18 * h1(seed * 5.1 + fk));
    float rad = 0.035 + 0.05 * h1(seed * 2.3 + fk * 7.0);
    m = max(m, 1.0 - smoothstep(rad - 0.025, rad, length(p - c)));
  }
  if (drip > 0.5) {                                     // 3-4 runs from the patch down to a drop
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float x0 = (fk - 1.0) * 0.28 + (h1(seed * 3.7 + fk * 5.3) - 0.5) * 0.2;
      float len = 0.18 + 0.55 * h1(seed * 9.1 + fk * 1.7);
      float y1 = 0.1 - len - 0.2;
      float w = 0.05 + 0.035 * h1(seed * 1.3 + fk * 3.1);
      float inY = step(y1, p.y) * step(p.y, 0.15);
      float taper = mix(0.5, 1.0, smoothstep(y1, 0.1, p.y));
      float streak = (1.0 - smoothstep(w * 0.45 * taper, w * taper, abs(p.x - x0 - 0.03 * sin(p.y * 5.0 + fk)))) * inY;
      float drop = 1.0 - smoothstep(w * 1.0, w * 1.5, length((p - vec2(x0 - 0.03 * sin(y1 * 5.0 + fk), y1)) * vec2(1.0, 0.8)));
      m = max(m, max(streak, drop));
    }
  }
  return m;
}`;
export interface WetMarksOptions {
    maxSurface?: number;
    surfaceSize?: number;
    lift?: number;
    wetHold?: number;
    dryTime?: number;
    playerWetHold?: number;
    playerDryTime?: number;
}
export class WetMarks {
    surfaceMesh: THREE.InstancedMesh;
    birth: THREE.InstancedBufferAttribute;
    seeds: THREE.InstancedBufferAttribute;
    drips: THREE.InstancedBufferAttribute;
    uTime = { value: 0 };
    uPlayerTime = { value: 0 };
    max: number;
    next = 0;
    live = 0;
    stamp = 0;
    lastBirth = -1e9;
    size: number;
    lift: number;
    wetHold: number;
    dryTime: number;
    playerWetHold: number;
    playerDryTime: number;
    cen: Float32Array;
    nor: Float32Array;
    grow: Float32Array;
    rot: Float32Array;
    base: Float32Array;
    wet = new Map<THREE.Object3D, WettableMesh>();
    constructor(parent: THREE.Object3D, options: WetMarksOptions = {}) {
        const max = (this.max = options.maxSurface ?? 384);
        this.size = options.surfaceSize ?? 0.55;
        this.lift = options.lift ?? 0.005;
        this.wetHold = options.wetHold ?? 2.5;
        this.dryTime = options.dryTime ?? 3.5;
        this.playerWetHold = options.playerWetHold ?? 4;
        this.playerDryTime = options.playerDryTime ?? 6;
        this.cen = new Float32Array(max * 3);
        this.nor = new Float32Array(max * 3);
        this.grow = new Float32Array(max);
        this.rot = new Float32Array(max);
        this.base = new Float32Array(max);
        const geo = new THREE.PlaneGeometry(1, 1);
        this.birth = new THREE.InstancedBufferAttribute(new Float32Array(max).fill(-1e9), 1);
        this.birth.setUsage(THREE.DynamicDrawUsage);
        this.seeds = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
        this.seeds.setUsage(THREE.DynamicDrawUsage);
        this.drips = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
        this.drips.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("aBirth", this.birth);
        geo.setAttribute("aSeed", this.seeds);
        geo.setAttribute("aDrip", this.drips);
        const mat = new THREE.MeshStandardMaterial({ color: 0x0f2c48, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 1,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const hold = this.wetHold, dry = this.dryTime;
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uWetTime = this.uTime;
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", `#include <common>
        uniform float uWetTime;
        attribute float aBirth;
        attribute float aSeed;
        attribute float aDrip;
        flat varying float vDrip;                              // flat: the hash below must see the EXACT seed
        flat varying float vSeed;
        varying float vWet;
        varying vec2 vPuddleP;`)
                .replace("#include <begin_vertex>", `#include <begin_vertex>
        float age = uWetTime - aBirth;
        vWet = 1.0 - smoothstep(${hold.toFixed(3)}, ${(hold + dry).toFixed(3)}, age);
        vSeed = aSeed;
        vDrip = aDrip;
        vPuddleP = position.xy * 2.0;
        if (vWet <= 0.0) transformed *= 0.0;                 // dry: collapsed, no fragment`);
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", "#include <common>\nflat varying float vSeed;\nflat varying float vDrip;\nvarying float vWet;\nvarying vec2 vPuddleP;\n" + PUDDLE_GLSL)
                .replace("#include <color_fragment>", `#include <color_fragment>
        {
          // dries from the edge inward: the shape shrinks while it fades
          vec2 pp = vPuddleP / mix(0.6, 1.0, vWet);
          float m = puddle(pp, vSeed, vDrip);
          if (m * vWet < 0.01) discard;
          diffuseColor.a *= m * (0.42 * vWet + 0.12 * vWet * vWet);
        }`)
                .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.6, 0.08, vWet);");
        };
        mat.customProgramCacheKey = () => `wet-mark-v2-${hold}-${dry}`;
        this.surfaceMesh = new THREE.InstancedMesh(geo, mat, max);
        this.surfaceMesh.name = "WetMarks";
        this.surfaceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.surfaceMesh.count = 0;
        this.surfaceMesh.frustumCulled = false;
        this.surfaceMesh.castShadow = false;
        this.surfaceMesh.receiveShadow = true;
        this.surfaceMesh.matrixAutoUpdate = false;
        this.surfaceMesh.renderOrder = 1;
        this.surfaceMesh.raycast = () => { };
        this.surfaceMesh.visible = false;
        parent.add(this.surfaceMesh);
    }
    /** Game clock (s) used by every mark — advance it once per frame with update(dt). */
    get time(): number { return this.uTime.value; }
    /**
     * A wet mark on STATIC level geometry. normal = WORLD normal of the hit face. seed: the shot seed so every client
     * draws the same mark (shape / rotation / size). A jet landing on a still-wet mark refreshes and grows it.
     */
    markSurface(point: THREE.Vector3, normal: THREE.Vector3, size: number = this.size, seed?: number): number {
        const r = seed === undefined ? Math.random : rng(seed);
        const now = this.uTime.value;
        _n.copy(normal).normalize();
        // 1) refresh a mark that is still wet right there
        let best = -1, bestD = size * 0.45;
        const n = Math.min(this.live, this.max);
        for (let j = 0; j < n; j++) {
            if (now - this.birth.getX(j) > this.wetHold + this.dryTime * 0.5)
                continue;
            const j3 = j * 3;
            if (this.nor[j3] * _n.x + this.nor[j3 + 1] * _n.y + this.nor[j3 + 2] * _n.z < 0.9)
                continue;
            const d = Math.hypot(this.cen[j3] - point.x, this.cen[j3 + 1] - point.y, this.cen[j3 + 2] - point.z);
            if (d < bestD) {
                bestD = d;
                best = j;
            }
        }
        let i: number;
        if (best >= 0) {
            i = best;
            this.grow[i] = Math.min(1.7, this.grow[i] * 1.1 + 0.03);
        }
        else {
            i = this.next;
            this.next = (this.next + 1) % this.max;
            this.live = Math.min(this.live + 1, this.max);
            const i3 = i * 3;
            const lift = this.lift + (this.stamp++ % 128) * 2e-5;
            this.cen[i3] = point.x + _n.x * lift;
            this.cen[i3 + 1] = point.y + _n.y * lift;
            this.cen[i3 + 2] = point.z + _n.z * lift;
            this.nor[i3] = _n.x;
            this.nor[i3 + 1] = _n.y;
            this.nor[i3 + 2] = _n.z;
            this.base[i] = size * (0.85 + r() * 0.3);
            this.grow[i] = 1;
            const wallMark = Math.abs(_n.y) < 0.55;
            this.drips.setX(i, wallMark ? 1 : 0);
            this.rot[i] = wallMark ? (r() - 0.5) * 0.3 : r() * Math.PI * 2;
            this.seeds.setX(i, r() * 100);
        }
        this.birth.setX(i, now);
        this.lastBirth = now;
        this.writeMatrix(i);
        this.surfaceMesh.count = this.live;
        this.surfaceMesh.visible = true;
        const im = this.surfaceMesh.instanceMatrix;
        im.addUpdateRange(i * 16, 16);
        im.needsUpdate = true;
        this.birth.addUpdateRange(i, 1);
        this.birth.needsUpdate = true;
        this.seeds.addUpdateRange(i, 1);
        this.seeds.needsUpdate = true;
        this.drips.addUpdateRange(i, 1);
        this.drips.needsUpdate = true;
        return i;
    }
    writeMatrix(i: number): void {
        const i3 = i * 3;
        _n.set(this.nor[i3], this.nor[i3 + 1], this.nor[i3 + 2]);
        _q.setFromUnitVectors(_z, _n);
        if (this.drips.getX(i) > 0.5) {
            // turn the quad about the normal so its +Y is the world up projected on the wall (drips run DOWN)
            _a.set(0, 1, 0).applyQuaternion(_q);
            _b.set(0, 1, 0).addScaledVector(_n, -_n.y).normalize();
            const ang = Math.atan2(_c.crossVectors(_a, _b).dot(_n), _a.dot(_b));
            _q.multiply(_q2.setFromAxisAngle(_z, ang + this.rot[i]));
        }
        else
            _q.multiply(_q2.setFromAxisAngle(_z, this.rot[i]));
        const sz = this.base[i] * this.grow[i];
        _s.set(sz, sz * (this.drips.getX(i) > 0.5 ? 1.25 : 0.86), 1);
        _p.set(this.cen[i3], this.cen[i3 + 1], this.cen[i3 + 2]);
        this.surfaceMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    /** Make a (skinned) character mesh wettable (per-player geometry sharing the original attributes). */
    attach(mesh: THREE.SkinnedMesh): WettableMesh {
        let w = this.wet.get(mesh);
        if (!w) {
            w = new WettableMesh(mesh, this.uPlayerTime, this.playerWetHold, this.playerDryTime);
            this.wet.set(mesh, w);
        }
        return w;
    }
    /** Soak a character where a jet hit it (raycast hit of the jet: faceIndex + barycentric, see waterHitBarycentric). */
    wetHit(mesh: THREE.SkinnedMesh, faceIndex: number, bary: THREE.Vector3, radius = 0.11): void {
        this.attach(mesh).soak(faceIndex, bary, radius, this.uPlayerTime.value);
    }
    /** DEATH / respawn: dry everything a player carries (every wet mesh under his character root). */
    dryUnder(root: THREE.Object3D): void {
        root.traverse((o: THREE.Object3D) => { const w = this.wet.get(o); if (w)
            w.clear(); });
    }
    /** Remove every surface mark (new round). */
    clearSurfaces(): void {
        this.live = 0;
        this.next = 0;
        this.surfaceMesh.count = 0;
        this.surfaceMesh.visible = false;
        this.birth.array.fill(-1e9);
        this.birth.needsUpdate = true;
    }
    /** Stop tracking a character (despawn): restores its original geometry / material. */
    detach(mesh: THREE.SkinnedMesh): void {
        this.wet.get(mesh)?.dispose();
        this.wet.delete(mesh);
    }
    /** Once per frame: advances the drying clock (surfaces + players). */
    update(dt: number): void {
        this.uTime.value += dt;
        this.uPlayerTime.value += dt;
        if (this.surfaceMesh.visible && this.uTime.value - this.lastBirth > this.wetHold + this.dryTime + 0.1)
            this.surfaceMesh.visible = false;
    }
    dispose(): void {
        for (const w of this.wet.values())
            w.dispose();
        this.wet.clear();
        this.surfaceMesh.removeFromParent();
        this.surfaceMesh.geometry.dispose();
        (this.surfaceMesh.material as THREE.Material).dispose();
        this.surfaceMesh.dispose();
    }
}
/** Barycentric coordinates of `point` (world) on face `faceIndex` of the POSED mesh (skinning applied). */
export function waterHitBarycentric(mesh: THREE.Mesh, faceIndex: number, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const idx = mesh.geometry.index;
    const ia = idx ? idx.getX(faceIndex * 3) : faceIndex * 3;
    const ib = idx ? idx.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
    const ic = idx ? idx.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
    (mesh as THREE.SkinnedMesh).getVertexPosition(ia, _a).applyMatrix4(mesh.matrixWorld);
    (mesh as THREE.SkinnedMesh).getVertexPosition(ib, _b).applyMatrix4(mesh.matrixWorld);
    (mesh as THREE.SkinnedMesh).getVertexPosition(ic, _c).applyMatrix4(mesh.matrixWorld);
    return THREE.Triangle.getBarycoord(point, _a, _b, _c, out) ?? out.set(1 / 3, 1 / 3, 1 / 3);
}
/** Per-character wetness (see WetMarks). Attribute `wet` = (time of the last soak, amount 0..1). */
export class WettableMesh {
    mesh: THREE.SkinnedMesh;
    original: THREE.BufferGeometry;
    originalMaterial: THREE.Material | THREE.Material[];
    wetAttr: THREE.BufferAttribute;
    weld: Int32Array;
    members: Array<Int32Array | undefined>;
    nbr: Array<Int32Array | undefined>;
    pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    visited: Int32Array;
    queue: Int32Array;
    stamp = 1;
    hold: number;
    dry: number;
    constructor(mesh: THREE.SkinnedMesh, uTime: { value: number }, hold: number, dry: number) {
        this.mesh = mesh;
        this.hold = hold;
        this.dry = dry;
        this.original = mesh.geometry;
        this.originalMaterial = mesh.material;
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(this.original.attributes))
            g.setAttribute(name, attr); // shared
        g.setIndex(this.original.index);
        for (const grp of this.original.groups)
            g.addGroup(grp.start, grp.count, grp.materialIndex);
        g.boundingBox = this.original.boundingBox;
        g.boundingSphere = this.original.boundingSphere;
        const n = this.original.attributes.position.count;
        const arr = new Float32Array(n * 2);
        for (let i = 0; i < n; i++)
            arr[i * 2] = -1e9;
        this.wetAttr = new THREE.BufferAttribute(arr, 2);
        this.wetAttr.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("wet", this.wetAttr);
        mesh.geometry = g;
        const patch = (m: THREE.Material) => patchWetMaterial(m, uTime, hold, dry);
        mesh.material = Array.isArray(this.originalMaterial) ? this.originalMaterial.map(patch) : patch(this.originalMaterial);
        // weld UV-seam duplicates + vertex adjacency (once)
        this.pos = this.original.attributes.position;
        const key = new Map();
        this.weld = new Int32Array(n);
        const mem: number[][] = [];
        for (let i = 0; i < n; i++) {
            const k = `${Math.round(this.pos.getX(i) * 1e4)},${Math.round(this.pos.getY(i) * 1e4)},${Math.round(this.pos.getZ(i) * 1e4)}`;
            let r = key.get(k);
            if (r === undefined) {
                r = i;
                key.set(k, i);
            }
            this.weld[i] = r;
            (mem[r] ??= []).push(i);
        }
        this.members = [];
        for (let i = 0; i < n; i++)
            if (mem[i])
                this.members[i] = Int32Array.from(mem[i]);
        const nb: Array<Set<number> | undefined> = [];
        const index = this.original.index;
        const tri = index ? index.count : n;
        for (let t = 0; t < tri; t += 3) {
            const v0 = this.weld[index ? index.getX(t) : t], v1 = this.weld[index ? index.getX(t + 1) : t + 1], v2 = this.weld[index ? index.getX(t + 2) : t + 2];
            (nb[v0] ??= new Set()).add(v1).add(v2);
            (nb[v1] ??= new Set()).add(v0).add(v2);
            (nb[v2] ??= new Set()).add(v0).add(v1);
        }
        this.nbr = [];
        for (let i = 0; i < n; i++)
            if (nb[i])
                this.nbr[i] = Int32Array.from(nb[i]!);
        this.visited = new Int32Array(n);
        this.queue = new Int32Array(n);
    }
    /** Soak around the hit (bind space). Re-soaking refreshes the clock (stays wet longer). */
    soak(faceIndex: number, bary: THREE.Vector3, radius: number, now: number): void {
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
        for (const v of [ia, ib, ic]) {
            const r = this.weld[v];
            if (this.visited[r] !== st) {
                this.visited[r] = st;
                this.queue[tail++] = r;
            }
        }
        const a = this.wetAttr.array;
        while (head < tail) {
            const v = this.queue[head++];
            const dx = P.getX(v) - cx, dy = P.getY(v) - cy, dz = P.getZ(v) - cz;
            // water runs DOWN: the patch is longer below the hit than above it (bind space: +Y up)
            const d = Math.sqrt(dx * dx + dz * dz + (dy > 0 ? dy * dy * 2.2 : dy * dy * 0.45));
            if (d > radius * 1.2)
                continue;
            const w = Math.min(1, Math.max(0, 1.25 - d / radius));
            for (const m of this.members[v]!) {
                const o = m * 2;
                // current wetness of that vertex (so a light new soak never makes a soaked spot drier)
                a[o + 1] = Math.max(w, a[o + 1] * currentWet(now - a[o], this.hold, this.dry));
                a[o] = now;
            }
            const nn = this.nbr[v];
            if (nn)
                for (let k = 0; k < nn.length; k++) {
                    const u = nn[k];
                    if (this.visited[u] !== st) {
                        this.visited[u] = st;
                        this.queue[tail++] = u;
                    }
                }
        }
        this.wetAttr.needsUpdate = true;
    }
    clear(): void {
        const a = this.wetAttr.array;
        for (let i = 0; i < a.length; i += 2) {
            a[i] = -1e9;
            a[i + 1] = 0;
        }
        this.wetAttr.needsUpdate = true;
    }
    dispose(): void {
        const mats = this.mesh.material;
        this.mesh.geometry = this.original;
        this.mesh.material = this.originalMaterial;
        (Array.isArray(mats) ? mats : [mats]).forEach((m) => m.dispose());
    }
}
/** Rough CPU mirror of the shader's drying curve (used when re-soaking). */
function currentWet(age: number, hold: number, dry: number): number {
    return age < hold ? 1 : Math.max(0, 1 - (age - hold) / dry);
}
/** Clone a character material and make it dark / bluish / glossy where the `wet` attribute says so. */
export function patchWetMaterial<T extends THREE.Material>(src: T, uTime: { value: number }, hold: number, dry: number): T {
    const m = src.clone();
    const prev = src.onBeforeCompile; // chain an earlier patch (e.g. PaintSplats' paint)
    const prevKey = src.customProgramCacheKey?.bind(src);
    m.onBeforeCompile = (shader, renderer) => {
        prev?.call(m, shader, renderer);
        shader.uniforms.uWetTime = uTime;
        shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nattribute vec2 wet;\nuniform float uWetTime;\nvarying float vWetAmt;\nvarying vec3 vWetPos;")
            .replace("#include <begin_vertex>", `#include <begin_vertex>
      vWetAmt = wet.y * (1.0 - smoothstep(${hold.toFixed(3)}, ${(hold + dry).toFixed(3)}, uWetTime - wet.x));
      vWetPos = position;`);
        shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", `#include <common>
      varying float vWetAmt;
      varying vec3 vWetPos;
      float wetH(vec3 p) { return fract(sin(dot(floor(p), vec3(127.1, 311.7, 74.7))) * 43758.5453); }`)
            .replace("#include <color_fragment>", `#include <color_fragment>
      float wetM = smoothstep(0.08, 0.4, vWetAmt + (wetH(vWetPos * 60.0) - 0.5) * 0.18);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.6, 0.66, 0.76), wetM);`)
            .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.14, wetM);")
            .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      {
        // wet sheen: a cool fresnel glint that reads as "shiny" under any lighting
        float fr = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
        totalEmissiveRadiance += (vec3(0.02, 0.035, 0.05) + vec3(0.10, 0.15, 0.20) * fr) * wetM;
      }`);
    };
    m.customProgramCacheKey = () => (prevKey ? prevKey() : "") + `|wet-v2-${hold}-${dry}`;
    return m;
}
