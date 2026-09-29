import * as THREE from "three";
const N_SAMPLES = 384;
const _C = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const LIQUID_GLSL = /* glsl */ `
uniform vec4 uPlane;       // world normal xyz, height w
uniform float uLiqTime;
uniform float uRipple;     // amplitude, in tank radii
uniform float uLiqScale;   // world radius of the tank water
varying vec3 vLiqWorld;
float liqRipple(vec3 p) {
  vec3 q = p / uLiqScale;
  return uRipple * uLiqScale * (0.55 * sin(dot(q, vec3(2.3, 0.0, 1.7)) * 1.9 + uLiqTime * 7.1)
                              + 0.45 * sin(dot(q, vec3(-1.4, 0.0, 2.6)) * 2.4 - uLiqTime * 9.3));
}`;
function patchLiquid(m: THREE.MeshStandardMaterial, kind: "body" | "surface", uniforms: Record<string, THREE.IUniform>): void {
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vLiqWorld;")
            .replace("#include <project_vertex>", "#include <project_vertex>\nvLiqWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        let f = shader.fragmentShader
            .replace("#include <common>", "#include <common>\n" + LIQUID_GLSL)
            .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
      float liqH = dot(uPlane.xyz, vLiqWorld) - uPlane.w - liqRipple(vLiqWorld);
      if (liqH > 0.0) discard;`);
        if (kind === "body") {
            f = f.replace("#include <color_fragment>", `#include <color_fragment>
      diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(-2.2 * uLiqScale, 0.0, liqH));            // deeper = darker
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.95, 1.0), 0.65 * smoothstep(-0.16 * uLiqScale, 0.0, liqH));   // meniscus`);
        }
        else {
            f = f
                .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        {
          vec3 q = vLiqWorld / uLiqScale;
          vec3 wn = normalize(uPlane.xyz + uRipple * 2.2 * vec3(cos(dot(q, vec3(2.3, 0.0, 1.7)) * 1.9 + uLiqTime * 7.1), 0.0,
                                                               cos(dot(q, vec3(-1.4, 0.0, 2.6)) * 2.4 - uLiqTime * 9.3)));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
                .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * 0.18;`);
        }
        shader.fragmentShader = f;
    };
    m.customProgramCacheKey = () => "water-famas-liquid-" + kind;
}
/** k-th smallest of a[0..n) (in place, Hoare quickselect). */
function select(a: Float32Array, n: number, k: number): number {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const pivot = a[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
            while (a[i] < pivot)
                i++;
            while (a[j] > pivot)
                j--;
            if (i <= j) {
                const t = a[i];
                a[i] = a[j];
                a[j] = t;
                i++;
                j--;
            }
        }
        if (k <= j)
            hi = j;
        else if (k >= i)
            lo = i;
        else
            return a[k];
    }
    return a[k];
}
export interface WaterTankOptions {
    /** Tank "up" in the weapon root's space (default +Y). */
    up?: THREE.Vector3;
    sloshHz?: number;
    sloshDamping?: number;
    sloshGain?: number;
    maxTilt?: number;
    color?: THREE.ColorRepresentation;
    surfaceColor?: THREE.ColorRepresentation;
}
export interface WaterTankData {
    capacity: number;
    jetsPerShot: number;
    radius: number;
    xMin: number;
    xMax: number;
    glassRadius: number;
    emptyLevel: number;
}
type LiquidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
export class WaterTank {
    data: WaterTankData;
    /** The water body (front faces) — the original "Water" node of the GLB. */
    body: LiquidMesh;
    /** The free surface (back faces of the same geometry). */
    surface: LiquidMesh;
    /** Pour stream (reload), child of the weapon root. */
    stream: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
    /** Shown fill (0..1, smoothed toward `target`). */
    fill = 1;
    /** Fill the controller asks for (0..1). */
    target = 1;
    root: THREE.Object3D;
    uniforms: {
        uPlane: { value: THREE.Vector4 };
        uLiqTime: { value: number };
        uRipple: { value: number };
        uLiqScale: { value: number };
    };
    streamUniforms: { uLiqTime: { value: number }; uStreamOn: { value: number } };
    samples = new Float32Array(N_SAMPLES * 3);
    proj = new Float32Array(N_SAMPLES);
    up: THREE.Vector3;
    ex = new THREE.Vector3();
    ez = new THREE.Vector3();
    prevPos = new THREE.Vector3();
    prevVel = new THREE.Vector3();
    accF = new THREE.Vector3();
    tilt = new THREE.Vector2();
    tiltVel = new THREE.Vector2();
    first = true;
    K: number;
    Cd: number;
    gain: number;
    maxTilt: number;
    streamOn = 0;
    /** tankNode = the "Tank" node of the cloned weapon (its userData = the GLB extras); root = the weapon root. */
    constructor(tankNode: THREE.Object3D, root: THREE.Object3D, options: WaterTankOptions = {}) {
        const ex = tankNode.userData as Partial<WaterTankData>;
        this.data = {
            capacity: ex.capacity ?? 9, jetsPerShot: ex.jetsPerShot ?? 3, radius: ex.radius ?? 0.385,
            xMin: ex.xMin ?? -0.88, xMax: ex.xMax ?? 0.9, glassRadius: ex.glassRadius ?? 0.43, emptyLevel: ex.emptyLevel ?? 0.06,
        };
        this.root = root;
        this.up = (options.up ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
        this.ex.set(1, 0, 0).addScaledVector(this.up, -this.up.x).normalize();
        this.ez.crossVectors(this.ex, this.up).normalize();
        const w = 2 * Math.PI * (options.sloshHz ?? 1.6);
        this.K = w * w;
        this.Cd = 2 * (options.sloshDamping ?? 0.12) * w;
        this.gain = options.sloshGain ?? 1;
        this.maxTilt = options.maxTilt ?? 0.6;
        const found = tankNode.getObjectByName("Water");
        if (!found || !(found as THREE.Mesh).isMesh)
            throw new Error("WaterFamas GLB: Tank > Water mesh missing");
        const water = found as LiquidMesh;
        this.body = water;
        this.uniforms = {
            uPlane: { value: new THREE.Vector4(0, 1, 0, 1e6) },
            uLiqTime: { value: 0 },
            uRipple: { value: 0.02 },
            uLiqScale: { value: 0.03 },
        };
        const col = new THREE.Color(options.color ?? 0x3f9fe6);
        const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.8,
            side: THREE.FrontSide, depthWrite: true });
        patchLiquid(bodyMat, "body", this.uniforms);
        const surfMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(options.surfaceColor ?? 0x8fd0ff), roughness: 0.05, metalness: 0,
            transparent: true, opacity: 0.92, side: THREE.BackSide, depthWrite: true });
        patchLiquid(surfMat, "surface", this.uniforms);
        water.material = bodyMat;
        water.renderOrder = 2;
        this.surface = new THREE.Mesh(water.geometry, surfMat) as LiquidMesh;
        this.surface.name = "WaterSurface";
        this.surface.renderOrder = 1;
        this.surface.position.copy(water.position);
        this.surface.quaternion.copy(water.quaternion);
        this.surface.scale.copy(water.scale);
        this.surface.frustumCulled = water.frustumCulled;
        this.surface.raycast = () => { };
        water.parent!.add(this.surface);
        // fixed sample points of the water cylinder (Water-local), deterministic
        const { radius: R, xMin, xMax } = this.data;
        let s = 12345;
        const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < N_SAMPLES; i++) {
            const x = xMin + (xMax - xMin) * ((i + rnd()) / N_SAMPLES);
            const r = R * Math.sqrt(rnd()), a = rnd() * Math.PI * 2;
            this.samples[i * 3] = x;
            this.samples[i * 3 + 1] = r * Math.cos(a);
            this.samples[i * 3 + 2] = r * Math.sin(a);
        }
        // pour stream: open cylinder y 0..1, broken by a scrolling noise
        const sg = new THREE.CylinderGeometry(1, 0.75, 1, 8, 10, true);
        sg.translate(0, 0.5, 0);
        this.streamUniforms = { uLiqTime: this.uniforms.uLiqTime, uStreamOn: { value: 0 } };
        const sm = new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.25), roughness: 0.1,
            transparent: true, opacity: 0.85, depthWrite: false });
        sm.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.streamUniforms);
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\nvarying vec2 vSUv;")
                .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSUv = vec2(atan(position.z, position.x), position.y);");
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", "#include <common>\nuniform float uLiqTime;\nuniform float uStreamOn;\nvarying vec2 vSUv;")
                .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        float sb = sin(vSUv.y * 38.0 - uLiqTime * 26.0 + sin(vSUv.x * 3.0) * 1.3) * 0.5 + 0.5;
        if (vSUv.y > uStreamOn || sb < 0.45 * smoothstep(0.7, 1.0, vSUv.y)) discard;     // continuous, breaks up at the end`)
                .replace("#include <color_fragment>", `#include <color_fragment>
        diffuseColor.rgb *= 0.82 + 0.36 * sb;                                           // flowing highlights`);
        };
        sm.customProgramCacheKey = () => "water-famas-stream";
        this.stream = new THREE.Mesh(sg, sm);
        this.stream.name = "PourStream";
        this.stream.matrixAutoUpdate = false;
        this.stream.visible = false;
        this.stream.frustumCulled = false;
        this.stream.renderOrder = 4;
        this.stream.raycast = () => { };
        root.add(this.stream);
    }
    /** Ammo -> target fill (with the thin film at 0). */
    setAmmo(ammo: number): void {
        const f = Math.max(0, Math.min(1, ammo / this.data.capacity));
        this.target = this.data.emptyLevel + (1 - this.data.emptyLevel) * f;
    }
    /** Force the shown fill (respawn / network sync). */
    snap(): void { this.fill = this.target; }
    /** Extra slosh (world direction, strength ~0.5 = a firm shake). */
    impulse(dirWorld: THREE.Vector3, strength: number): void {
        this.tiltVel.x += dirWorld.dot(this.ex) * strength;
        this.tiltVel.y += dirWorld.dot(this.ez) * strength;
    }
    /** Forget the motion history (teleport / respawn / equip): no fake slosh on the next frame. */
    resetMotion(): void {
        this.first = true;
        this.tilt.set(0, 0);
        this.tiltVel.set(0, 0);
        this.accF.set(0, 0, 0);
    }
    /**
     * Pour stream (reload): from the bottle nozzle to the filler hole, both WORLD points of the same scene as the
     * weapon. amount 0..1 = how much of the stream is drawn (0 = hidden).
     */
    setPour(from: THREE.Vector3 | null, to: THREE.Vector3 | null, amount: number, widthUnits = 0.05): void {
        if (!from || !to || amount <= 0.001) {
            this.stream.visible = false;
            this.streamOn = 0;
            return;
        }
        this.streamOn = amount;
        this.root.updateWorldMatrix(true, false);
        const scale = _s.setFromMatrixScale(this.root.matrixWorld).x;
        _v.subVectors(to, from);
        const len = _v.length();
        if (len < 1e-5) {
            this.stream.visible = false;
            return;
        }
        _q.setFromUnitVectors(_y, _v.divideScalar(len));
        const r = widthUnits * scale;
        _m.compose(from, _q, _s.set(r, len, r));
        this.stream.matrix.copy(_inv.copy(this.root.matrixWorld).invert().multiply(_m));
        this.stream.matrixWorldNeedsUpdate = true;
        this.stream.visible = true;
    }
    /** Per frame, AFTER the weapon's final world pose (FP: after viewmodel.syncCamera; TP: after the character). */
    update(dt: number): void {
        const u = this.uniforms;
        u.uLiqTime.value += dt;
        this.body.updateWorldMatrix(true, false);
        const M = this.body.matrixWorld;
        const e = M.elements;
        const xc = 0.5 * (this.data.xMin + this.data.xMax);
        _C.set(xc, 0, 0).applyMatrix4(M);
        const sc = Math.hypot(e[0], e[1], e[2]);
        u.uLiqScale.value = this.data.radius * sc;
        // ---- slosh: the surface normal chases the effective gravity through a spring
        if (this.first || dt <= 1e-5) {
            if (this.first) {
                this.prevPos.copy(_C);
                this.prevVel.set(0, 0, 0);
                this.first = false;
            }
        }
        else {
            _v.subVectors(_C, this.prevPos).divideScalar(dt);
            _a.subVectors(_v, this.prevVel).divideScalar(dt);
            if (_a.length() > 40)
                _a.setLength(40);
            this.accF.lerp(_a, 1 - Math.exp(-dt / 0.035));
            this.prevPos.copy(_C);
            this.prevVel.copy(_v);
        }
        const ay = this.accF.dot(this.up);
        const denom = Math.max(3, 9.81 + ay);
        let tx = (this.accF.dot(this.ex) / denom) * this.gain;
        let tz = (this.accF.dot(this.ez) / denom) * this.gain;
        const tl = Math.hypot(tx, tz);
        if (tl > this.maxTilt) {
            tx *= this.maxTilt / tl;
            tz *= this.maxTilt / tl;
        }
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / steps;
        for (let k = 0; k < steps; k++) {
            this.tiltVel.x += (this.K * (tx - this.tilt.x) - this.Cd * this.tiltVel.x) * h;
            this.tiltVel.y += (this.K * (tz - this.tilt.y) - this.Cd * this.tiltVel.y) * h;
            this.tilt.x += this.tiltVel.x * h;
            this.tilt.y += this.tiltVel.y * h;
        }
        const tt = Math.hypot(this.tilt.x, this.tilt.y);
        if (tt > this.maxTilt * 1.3)
            this.tilt.multiplyScalar((this.maxTilt * 1.3) / tt);
        _n.copy(this.up).addScaledVector(this.ex, this.tilt.x).addScaledVector(this.ez, this.tilt.y).normalize();
        const energy = Math.hypot(this.tiltVel.x, this.tiltVel.y) * 0.08 + Math.hypot(tx - this.tilt.x, tz - this.tilt.y) * 0.25;
        u.uRipple.value = Math.min(0.12, 0.012 + energy);
        // ---- level: plane height so that `fill` of the sampled volume is under it
        this.fill += (this.target - this.fill) * (1 - Math.exp(-dt / 0.09));
        const f = this.fill;
        let hgt: number;
        if (f <= 0.002)
            hgt = -1e9;
        else {
            // dot(n, M s) = dot(M^T n, s)
            const nx = e[0] * _n.x + e[1] * _n.y + e[2] * _n.z;
            const ny = e[4] * _n.x + e[5] * _n.y + e[6] * _n.z;
            const nz = e[8] * _n.x + e[9] * _n.y + e[10] * _n.z;
            const S = this.samples, P = this.proj;
            for (let i = 0; i < N_SAMPLES; i++)
                P[i] = nx * S[i * 3] + ny * S[i * 3 + 1] + nz * S[i * 3 + 2];
            const off = _n.dot(_t.set(e[12], e[13], e[14]));
            if (f >= 0.998) {
                let mx = -Infinity;
                for (let i = 0; i < N_SAMPLES; i++)
                    mx = Math.max(mx, P[i]);
                hgt = mx + off + u.uLiqScale.value;
            }
            else {
                hgt = select(P, N_SAMPLES, Math.min(N_SAMPLES - 1, Math.floor(f * N_SAMPLES))) + off;
            }
        }
        u.uPlane.value.set(_n.x, _n.y, _n.z, hgt);
        this.streamUniforms.uStreamOn.value = this.streamOn;
    }
    dispose(): void {
        this.surface.removeFromParent();
        this.stream.removeFromParent();
        this.stream.geometry.dispose();
        this.stream.material.dispose();
        this.body.material.dispose();
        this.surface.material.dispose();
    }
}
