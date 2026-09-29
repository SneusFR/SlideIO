import * as THREE from "three";
import type { WetMarks } from "./WetMarks";
const RINGS = 72;
const SIDES = 12;
const G = 9.81;
const BUMP_WAVELENGTH = 0.55; // m, at cruise speed
const MAX_SAG = 0.35; // m, cap of the gravity sag (see spawn)
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _z = new THREE.Vector3(0, 0, 1);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
/** Rope radius factor at distance s (same law as jetGrow in the shader). */
const grow = (s: number): number => 1 + 1.8 * (1 - Math.exp(-s / 4)) + 0.03 * s;
const STREAM_GLSL = /* glsl */ `
uniform float uJetTime;
uniform vec4 uKin;         // cruise speed V, V - launch speed, accel time, flow frequency (rad/s)
attribute vec3 aA;
attribute vec3 aB;
attribute vec4 aTime;      // emission start, emission end, arrival time of the water, seed
attribute vec4 aSize;      // radius at the muzzle, sag (m), head slug (1) or cone (0), tail crossfade (s, 0 = taper)
attribute vec2 aRing;      // v along the rope (0 tail .. 1 head), angle around it
varying float vFlow;
varying float vDist;
varying float vAlpha;
varying float vAng;
float jetS(float tau) { return uKin.x * tau - uKin.y * uKin.z * (1.0 - exp(-tau / uKin.z)); }
float jetV(float tau) { return uKin.x - uKin.y * exp(-tau / uKin.z); }
float jetGrow(float s) { return 1.0 + 1.8 * (1.0 - exp(-s / 4.0)) + 0.03 * s; }
`;
const STREAM_VERTEX = /* glsl */ `
  float jt0 = aTime.x, jt1 = aTime.y, jT = aTime.z, jseed = aTime.w;
  float jage = uJetTime - jt0;
  float tauH = min(jage, jT);
  float tauT = clamp(uJetTime - jt1, 0.0, jT);
  bool jdead = jage < 0.0 || tauH - tauT < 1e-4;
  float jtau = mix(tauT, tauH, aRing.x);
  vec3 jAB = aB - aA;
  float jL = max(length(jAB), 1e-3);
  float js = min(jetS(jtau), jL);
  float sH = min(jetS(tauH), jL), sT = min(jetS(tauT), jL);
  float ju = js / jL;
  vec3 jtan = normalize(jAB - vec3(0.0, 1.0, 0.0) * aSize.y * 4.0 * (1.0 - 2.0 * ju));
  vec3 jn1 = cross(jtan, vec3(0.0, 1.0, 0.0));
  if (dot(jn1, jn1) < 1e-6) jn1 = cross(jtan, vec3(1.0, 0.0, 0.0));
  jn1 = normalize(jn1);
  vec3 jn2 = cross(jtan, jn1);
  float jang = aRing.y;
  // the water at this ring left the muzzle at te: its bulges travel with it
  float te = uJetTime - jtau;
  float flow = (jage - jtau) * uKin.w + jseed * 6.2831;   // = (te - t0) x F: small numbers, no float drift
  float r0 = aSize.x * jetGrow(js);
  float amp = 0.10 + 0.24 * smoothstep(0.0, 3.5, js);
  float ph2 = flow * 2.37 + 1.3 + jseed * 17.0;
  float wav = 0.62 * sin(flow) + 0.38 * sin(ph2);
  float wob = 0.07 * sin(jang * 2.0 + flow * 0.7 + jseed * 5.0) * smoothstep(0.5, 4.0, js);
  float bump = 1.0 + amp * wav + wob;
  float dHead = sH - js, dTail = js - sT;
  float headK = aSize.z > 0.5
    ? sqrt(clamp(dHead / (r0 * 1.7), 0.0, 1.0)) * (1.0 + 0.3 * exp(-dHead / (r0 * 2.2)))
    : sqrt(clamp(dHead / (r0 * 4.0), 0.0, 1.0));
  float tailK = 1.0, jalpha = 1.0;
  if (aSize.w > 0.0) jalpha = clamp((jt1 - te) / aSize.w, 0.0, 1.0);          // joined: fade out under the next jet
  else if (uJetTime > jt1) tailK = sqrt(clamp(dTail / (r0 * 3.0), 0.0, 1.0));  // last jet: the tail tapers off
  float jr = r0 * bump * headK * tailK;
  vec3 jradial = jn1 * cos(jang) + jn2 * sin(jang);
  vec3 jpos = aA + jAB * ju - vec3(0.0, 1.0, 0.0) * aSize.y * 4.0 * ju * (1.0 - ju) + jradial * jr;
  // lit normal follows the bulges: dr/ds = dr/dflow * dflow/ds, dflow/ds = -F / v
  float drds = r0 * headK * tailK * amp * (0.62 * cos(flow) + 0.38 * 2.37 * cos(ph2)) * (-uKin.w / max(jetV(jtau), 1.0));
  vec3 jnrm = normalize(jradial - jtan * clamp(drds, -1.5, 1.5));
  if (jdead) jpos = vec3(0.0);
  vFlow = flow; vDist = js; vAlpha = jdead ? 0.0 : jalpha; vAng = jang;
`;
const NOISE_GLSL = /* glsl */ `
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;
// WFLOW / WSTREAK / WBASE / WALPHA are substituted per material (rope: flowing streaks; droplets: none)
const WATER_FRAGMENT = /* glsl */ `
  {
    vec3 wV = normalize(vViewPosition);
    float wndv = clamp(abs(dot(normal, wV)), 0.0, 1.0);
    float wrim = pow(1.0 - wndv, 1.6);
    vec3 wbody = mix(uWaterCore, uWaterRim, wrim);
    // glints: sharp lines along the rope that break up on the bulges (sky above, ground bounce below)
    float wsh = smoothstep(-0.3, 0.7, sin(WFLOW + 0.8));
    float wg1 = smoothstep(0.90, 0.985, dot(normal, normalize(vec3(-0.28, 0.88, 0.38)))) * wsh;
    float wg2 = smoothstep(0.93, 0.995, dot(normal, normalize(vec3(0.40, -0.55, 0.50)))) * 0.5;
    float wg3 = smoothstep(0.55, 0.95, wrim) * smoothstep(0.1, 0.7, normal.y) * 0.35;   // bright upper edge
    // white streaks that ride with the water (stretched along the flow)
    float wst = WSTREAK;
    float wcore = smoothstep(0.80, 1.0, wndv) * (0.10 + 0.14 * wsh);                    // light focused through the middle
    float wglint = wg1 + wg2 + wg3 + wst;
    diffuseColor.rgb = wbody * 0.3;                 // water is lit by its reflections, not by diffuse light
    diffuseColor.a = clamp(WBASE + 0.50 * wrim + 0.6 * wglint + wcore, 0.0, 0.97) * WALPHA;
    totalEmissiveRadiance += wbody * 0.72 + vec3(0.92, 0.97, 1.0) * wglint * 1.05 + vec3(0.75, 0.95, 1.0) * wcore * 1.6;
  }
`;
const STREAK_GLSL = "smoothstep(0.62, 0.9, wNoise(vec2(vFlow * 0.16, cos(vAng) * 1.7 + 3.1)) * 0.55 + wNoise(vec2(vFlow * 0.33 + 9.0, sin(vAng) * 2.3 + 5.7)) * 0.45) * 0.55";
function makeStreamGeometry() {
    const g = new THREE.BufferGeometry();
    const ring = new Float32Array((RINGS + 1) * (SIDES + 1) * 2);
    const pos = new Float32Array((RINGS + 1) * (SIDES + 1) * 3);
    let k = 0;
    for (let i = 0; i <= RINGS; i++) {
        const x = i / RINGS;
        const v = x < 0.5 ? 0.5 * Math.pow(2 * x, 1.4) : 1 - 0.5 * Math.pow(2 * (1 - x), 1.4); // denser rings at both ends
        for (let j = 0; j <= SIDES; j++) {
            const a = (j / SIDES) * Math.PI * 2;
            ring[k * 2] = v;
            ring[k * 2 + 1] = a;
            pos[k * 3] = Math.cos(a);
            pos[k * 3 + 1] = Math.sin(a);
            pos[k * 3 + 2] = v;
            k++;
        }
    }
    const idx = [];
    for (let i = 0; i < RINGS; i++)
        for (let j = 0; j < SIDES; j++) {
            const a = i * (SIDES + 1) + j, b = a + SIDES + 1;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    g.setIndex(idx);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    g.setAttribute("aRing", new THREE.BufferAttribute(ring, 2));
    return g;
}
/** What a jet wets when its head arrives (null = missed). */
export interface WaterJetHit {
    /** World normal of a static surface (wet mark). */
    normal?: THREE.Vector3;
    /** Shot seed: the same wet mark on every client. */
    seed?: number;
    /** Character mesh + face + barycentric (WetMarks.wetHit). */
    mesh?: THREE.SkinnedMesh;
    faceIndex?: number;
    bary?: THREE.Vector3;
}
export interface WaterJetsOptions {
    maxStreams?: number;
    maxDroplets?: number;
    speed?: number;
    launchSpeed?: number;
    accelTime?: number;
    radius?: number;
    emitDuration?: number;
    joinOverlap?: number;
    gravity?: number;
    color?: THREE.ColorRepresentation;
}
export interface WaterJetSpawnOptions {
    /** Live muzzle position (re-read every frame while the water leaves the barrel). */
    source?: (() => THREE.Vector3 | null) | null;
    duration?: number;
    /** Never use for the FAMAS: it merges the 3 jets into one continuous stream. */
    join?: boolean;
}
interface StreamState {
    t0: number;
    t1: number;
    T: number;
    L: number;
    hit: WaterJetHit | null;
    splashed: boolean;
    source: (() => THREE.Vector3 | null) | null;
    lastShed: number;
}
export class WaterJets {
    streams: THREE.InstancedMesh;
    droplets: THREE.InstancedMesh;
    marks: WetMarks | null;
    uTime = { value: 0 };
    V: number;
    dV: number;
    tau0: number;
    maxS: number;
    radius: number;
    emit: number;
    overlap: number;
    gravity: number;
    aA: THREE.InstancedBufferAttribute;
    aB: THREE.InstancedBufferAttribute;
    aTime: THREE.InstancedBufferAttribute;
    aSize: THREE.InstancedBufferAttribute;
    state: Array<StreamState | null>;
    nextS = 0;
    usedS = 0;
    liveS = 0;
    // droplets (ballistic)
    maxD: number;
    dPos: Float32Array;
    dVel: Float32Array;
    dAge: Float32Array;
    dLife: Float32Array;
    dRad: Float32Array;
    nextD = 0;
    liveD = 0;
    seed = 1;
    constructor(parent: THREE.Object3D, marks: WetMarks | null = null, options: WaterJetsOptions = {}) {
        const MS = (this.maxS = options.maxStreams ?? 64);
        this.V = options.speed ?? 30;
        this.dV = this.V * (1 - (options.launchSpeed ?? 0.35));
        this.tau0 = Math.max(1e-3, options.accelTime ?? 0.06);
        this.radius = options.radius ?? 0.02;
        this.emit = options.emitDuration ?? 0.04;
        this.overlap = options.joinOverlap ?? 0.015;
        this.gravity = options.gravity ?? 3;
        this.marks = marks;
        const rim = new THREE.Color(options.color ?? 0x1f86e8);
        const core = rim.clone().lerp(new THREE.Color(0.62, 0.92, 1.0), 0.42);
        const uniforms = {
            uWaterCore: { value: new THREE.Vector3(core.r, core.g, core.b) },
            uWaterRim: { value: new THREE.Vector3(rim.r, rim.g, rim.b) },
        };
        const WATER_UNIFORMS = "uniform vec3 uWaterCore;\nuniform vec3 uWaterRim;\n";
        // ---- streams
        const geo = makeStreamGeometry();
        this.aA = new THREE.InstancedBufferAttribute(new Float32Array(MS * 3), 3);
        this.aB = new THREE.InstancedBufferAttribute(new Float32Array(MS * 3), 3);
        this.aTime = new THREE.InstancedBufferAttribute(new Float32Array(MS * 4).fill(-1e6), 4);
        this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MS * 4), 4);
        for (const a of [this.aA, this.aB, this.aTime, this.aSize])
            a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("aA", this.aA);
        geo.setAttribute("aB", this.aB);
        geo.setAttribute("aTime", this.aTime);
        geo.setAttribute("aSize", this.aSize);
        const mat = new THREE.MeshStandardMaterial({ color: rim, roughness: 0.06, metalness: 0.0, transparent: true,
            depthWrite: false, side: THREE.FrontSide });
        const uKin = { value: new THREE.Vector4(this.V, this.dV, this.tau0, (2 * Math.PI * this.V) / BUMP_WAVELENGTH) };
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uJetTime = this.uTime;
            shader.uniforms.uKin = uKin;
            shader.uniforms.uWaterCore = uniforms.uWaterCore;
            shader.uniforms.uWaterRim = uniforms.uWaterRim;
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\n" + STREAM_GLSL)
                .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n" + STREAM_VERTEX + "\nobjectNormal = jnrm;")
                .replace("#include <begin_vertex>", "vec3 transformed = jpos;");
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", "#include <common>\n" + WATER_UNIFORMS + "varying float vFlow;\nvarying float vDist;\nvarying float vAlpha;\nvarying float vAng;\n" + NOISE_GLSL)
                .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vAlpha < 0.004) discard;")
                .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" +
                WATER_FRAGMENT.replace(/WFLOW/g, "vFlow").replace(/WSTREAK/g, STREAK_GLSL).replace(/WBASE/g, "0.46").replace(/WALPHA/g, "vAlpha * min(1.0, 0.25 + vDist * 6.0)"));
        };
        mat.customProgramCacheKey = () => "water-jet-stream-v3";
        this.streams = new THREE.InstancedMesh(geo, mat, MS);
        this.streams.name = "WaterJetStreams";
        for (let i = 0; i < MS; i++)
            this.streams.setMatrixAt(i, _m.identity());
        this.streams.count = 0;
        this.streams.frustumCulled = false;
        this.streams.castShadow = false;
        this.streams.renderOrder = 5;
        this.streams.raycast = () => { };
        this.streams.matrixAutoUpdate = false;
        parent.add(this.streams);
        this.state = new Array(MS).fill(null);
        // ---- droplets
        const MD = (this.maxD = options.maxDroplets ?? 1024);
        this.dPos = new Float32Array(MD * 3);
        this.dVel = new Float32Array(MD * 3);
        this.dAge = new Float32Array(MD).fill(1e9);
        this.dLife = new Float32Array(MD);
        this.dRad = new Float32Array(MD);
        const dmat = new THREE.MeshStandardMaterial({ color: rim, roughness: 0.06, metalness: 0, transparent: true, depthWrite: false });
        dmat.onBeforeCompile = (shader) => {
            shader.uniforms.uWaterCore = uniforms.uWaterCore;
            shader.uniforms.uWaterRim = uniforms.uWaterRim;
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", "#include <common>\n" + WATER_UNIFORMS)
                .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" +
                WATER_FRAGMENT.replace(/WFLOW/g, "0.0").replace(/WSTREAK/g, "0.0").replace(/WBASE/g, "0.72").replace(/WALPHA/g, "1.0"));
        };
        dmat.customProgramCacheKey = () => "water-jet-drop-v3";
        this.droplets = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dmat, MD);
        this.droplets.name = "WaterJetDroplets";
        this.droplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.droplets.frustumCulled = false;
        this.droplets.castShadow = false;
        this.droplets.raycast = () => { };
        this.droplets.count = 0;
        this.droplets.renderOrder = 6;
        parent.add(this.droplets);
    }
    rnd(): number { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
    /** Distance flown by water emitted tau seconds ago (same law as the shader). */
    sAt(tau: number): number { return this.V * tau - this.dV * this.tau0 * (1 - Math.exp(-tau / this.tau0)); }
    /** Flight time to distance L. */
    arrival(L: number): number {
        let t = (L + this.dV * this.tau0) / this.V;
        for (let k = 0; k < 6; k++)
            t -= (this.sAt(t) - L) / (this.V - this.dV * Math.exp(-t / this.tau0));
        return Math.max(0.01, t);
    }
    /**
     * One jet. from: muzzle (WORLD â€” FP: ViewmodelSystem.socketWorldForGameCamera(muzzle, gameCam, out)). to: raycast
     * impact (or the max-range point). hit: what gets wet when the head arrives (null = missed: the rope just flies to
     * range). strength 0..1 thins the rope (a nearly empty tank). Returns the stream slot.
     */
    spawn(from: THREE.Vector3, to: THREE.Vector3, hit: WaterJetHit | null, strength = 1, opts: WaterJetSpawnOptions = {}): number {
        const now = this.uTime.value;
        const src = opts.source ?? null;
        // join: the previous jet of this gun is still pouring (or stopped less than 2 frames ago)
        let prev = -1;
        if (src && opts.join === true) {
            let best = -Infinity;
            for (let j = 0; j < this.maxS; j++) {
                const s = this.state[j];
                if (s && s.source === src && now >= s.t0 && now <= s.t1 + 0.035 && s.t0 > best) {
                    best = s.t0;
                    prev = j;
                }
            }
        }
        if (prev >= 0) {
            const p = this.state[prev]!;
            p.t1 = now + this.overlap;
            this.aTime.setY(prev, p.t1);
            this.aSize.setW(prev, this.overlap);
            this.touch(prev);
        }
        const i = this.nextS;
        this.nextS = (this.nextS + 1) % this.maxS;
        this.usedS = Math.min(this.usedS + 1, this.maxS);
        if (!this.state[i])
            this.liveS++;
        const L = Math.max(0.05, from.distanceTo(to));
        const T = this.arrival(L);
        const dur = opts.duration ?? this.emit;
        this.state[i] = { t0: now, t1: now + dur, T, L, hit, splashed: false, source: src, lastShed: now };
        this.aA.setXYZ(i, from.x, from.y, from.z);
        this.aB.setXYZ(i, to.x, to.y, to.z);
        this.aTime.setXYZW(i, now, now + dur, T, this.rnd());
        // Gravity sag of the rope (m). SlideIO: capped at what the pack's 28 m range gave (~0.35 m) —
        // without a range limit the sag grows with T² and a far / sky shot would arc by many metres
        // although the hitscan is a straight line.
        const sag = Math.min(0.5 * this.gravity * T * T * 0.25, MAX_SAG);
        this.aSize.setXYZW(i, this.radius * (0.55 + 0.45 * strength), sag, prev >= 0 ? 0 : 1, 0);
        this.touch(i);
        this.streams.count = this.usedS;
        // muzzle mist
        _d.subVectors(to, from).normalize();
        this.frame(_d);
        const nMist = prev >= 0 ? 3 : 7;
        for (let k = 0; k < nMist; k++) {
            const sp = 2.5 + this.rnd() * 3.5, c = 0.3;
            const u = (this.rnd() - 0.5) * 2 * c, v = (this.rnd() - 0.5) * 2 * c;
            _a.copy(_d).addScaledVector(_t1, u).addScaledVector(_t2, v).multiplyScalar(sp);
            this.drop(from, _a, 0.12 + this.rnd() * 0.12, this.radius * (0.2 + this.rnd() * 0.25));
        }
        return i;
    }
    touch(i: number): void {
        for (const [a, n] of [[this.aA, 3], [this.aB, 3], [this.aTime, 4], [this.aSize, 4]] as Array<[THREE.InstancedBufferAttribute, number]>) {
            a.addUpdateRange(i * n, n);
            a.needsUpdate = true;
        }
    }
    frame(d: THREE.Vector3): void {
        _t1.set(0, 1, 0).cross(d);
        if (_t1.lengthSq() < 1e-6)
            _t1.set(1, 0, 0);
        _t1.normalize();
        _t2.crossVectors(d, _t1);
    }
    drop(p: THREE.Vector3, v: THREE.Vector3, life: number, r: number): void {
        const i = this.nextD;
        this.nextD = (this.nextD + 1) % this.maxD;
        if (this.dAge[i] >= this.dLife[i])
            this.liveD++;
        this.dPos[i * 3] = p.x;
        this.dPos[i * 3 + 1] = p.y;
        this.dPos[i * 3 + 2] = p.z;
        this.dVel[i * 3] = v.x;
        this.dVel[i * 3 + 1] = v.y;
        this.dVel[i * 3 + 2] = v.z;
        this.dAge[i] = 0;
        this.dLife[i] = life;
        this.dRad[i] = r;
    }
    /** Path point of stream i at parameter u (same formula as the shader). */
    pathAt(i: number, u: number, out: THREE.Vector3): THREE.Vector3 {
        const sag = this.aSize.getY(i);
        out.set(this.aA.getX(i), this.aA.getY(i), this.aA.getZ(i)).lerp(_b.set(this.aB.getX(i), this.aB.getY(i), this.aB.getZ(i)), u);
        out.y -= sag * 4 * u * (1 - u);
        return out;
    }
    splash(i: number, s: StreamState, n: number, first: boolean): void {
        const hit = s.hit;
        _p.set(this.aB.getX(i), this.aB.getY(i), this.aB.getZ(i));
        if (hit && hit.normal)
            _d.copy(hit.normal).normalize();
        else
            _d.set(this.aA.getX(i), this.aA.getY(i), this.aA.getZ(i)).sub(_p).normalize();
        this.frame(_d);
        const r = this.radius * grow(s.L); // rope radius at the impact
        for (let k = 0; k < n; k++) {
            const ang = this.rnd() * Math.PI * 2, out = 0.6 + this.rnd() * 1.9, up = 0.5 + this.rnd() * 2.0;
            _a.copy(_d).multiplyScalar(up).addScaledVector(_t1, Math.cos(ang) * out).addScaledVector(_t2, Math.sin(ang) * out);
            _s.copy(_p).addScaledVector(_d, 0.01).addScaledVector(_t1, Math.cos(ang) * r).addScaledVector(_t2, Math.sin(ang) * r);
            this.drop(_s, _a, 0.22 + this.rnd() * 0.25, r * (0.12 + this.rnd() * 0.22));
        }
        if (first && hit && this.marks) {
            if (hit.mesh && hit.faceIndex !== undefined && hit.bary)
                this.marks.wetHit(hit.mesh, hit.faceIndex, hit.bary);
            else if (hit.normal)
                this.marks.markSurface(_p, hit.normal, undefined, hit.seed);
        }
    }
    /** Once per frame, after the spawns of the frame. */
    update(dt: number): void {
        const now = (this.uTime.value += dt);
        // ---- streams: follow the muzzle while pouring, shed drops, splash while the rope pours on the target
        if (this.liveS > 0) {
            for (let i = 0; i < this.maxS; i++) {
                const s = this.state[i];
                if (!s)
                    continue;
                if (now > s.t1 + s.T + 0.02) {
                    this.state[i] = null;
                    this.liveS--;
                    continue;
                }
                if (s.source && now <= s.t1) {
                    const m = s.source();
                    if (m) {
                        this.aA.setXYZ(i, m.x, m.y, m.z);
                        this.aA.addUpdateRange(i * 3, 3);
                        this.aA.needsUpdate = true;
                    }
                }
                const tauH = Math.min(now - s.t0, s.T), tauT = Math.min(Math.max(0, now - s.t1), s.T);
                // drops falling off the rope (mostly the beaded, far part)
                if (tauH - tauT > 0.01 && now - s.lastShed > 0.014) {
                    s.lastShed = now;
                    const sd = this.sAt(tauT + (tauH - tauT) * (0.35 + 0.65 * this.rnd()));
                    const u = Math.min(1, sd / s.L);
                    this.pathAt(i, u, _p);
                    _d.set(this.aB.getX(i) - this.aA.getX(i), this.aB.getY(i) - this.aA.getY(i), this.aB.getZ(i) - this.aA.getZ(i)).normalize();
                    this.frame(_d);
                    const sp = this.V * (0.3 + 0.3 * this.rnd());
                    _a.copy(_d).multiplyScalar(sp).addScaledVector(_t1, (this.rnd() - 0.5) * 1.4).addScaledVector(_t2, (this.rnd() - 0.5) * 1.4);
                    const rr = this.radius * grow(sd);
                    this.drop(_p, _a, 0.16 + this.rnd() * 0.16, rr * (0.15 + this.rnd() * 0.25));
                }
                // splash: when the head arrives (+ the wet mark), then while the rope keeps pouring on the target
                const headIn = now >= s.t0 + s.T, tailIn = now >= s.t1 + s.T;
                if (s.hit && headIn && !s.splashed) {
                    s.splashed = true;
                    this.splash(i, s, 14, true);
                }
                else if (s.hit && headIn && !tailIn && this.rnd() < dt * 150)
                    this.splash(i, s, 3, false);
            }
        }
        // ---- droplets
        if (this.liveD === 0) {
            if (this.droplets.count !== 0) {
                this.droplets.count = 0;
                this.droplets.instanceMatrix.needsUpdate = true;
            }
            return;
        }
        let drawn = 0, live = 0;
        for (let i = 0; i < this.maxD; i++) {
            const age = this.dAge[i];
            if (age >= this.dLife[i])
                continue;
            const a = (this.dAge[i] += dt);
            if (a >= this.dLife[i])
                continue;
            live++;
            const i3 = i * 3;
            this.dVel[i3 + 1] -= G * dt;
            this.dPos[i3] += this.dVel[i3] * dt;
            this.dPos[i3 + 1] += this.dVel[i3 + 1] * dt;
            this.dPos[i3 + 2] += this.dVel[i3 + 2] * dt;
            _p.set(this.dPos[i3], this.dPos[i3 + 1], this.dPos[i3 + 2]);
            _d.set(this.dVel[i3], this.dVel[i3 + 1], this.dVel[i3 + 2]);
            const sp = _d.length();
            if (sp > 1e-4)
                _q.setFromUnitVectors(_z, _d.divideScalar(sp));
            else
                _q.identity();
            const g = this.dRad[i] * (1 - 0.5 * (a / this.dLife[i]));
            _s.set(g, g, g * (1 + Math.min(1.6, sp * 0.25)));
            this.droplets.setMatrixAt(drawn++, _m.compose(_p, _q, _s));
        }
        this.liveD = live;
        for (let k = drawn; k < this.droplets.count; k++)
            this.droplets.setMatrixAt(k, _hidden);
        this.droplets.count = drawn;
        this.droplets.instanceMatrix.needsUpdate = true;
    }
    dispose(): void {
        for (const m of [this.streams, this.droplets]) {
            m.removeFromParent();
            m.geometry.dispose();
            (m.material as THREE.Material).dispose();
            m.dispose();
        }
    }
}
