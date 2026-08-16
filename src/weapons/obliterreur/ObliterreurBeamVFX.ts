import * as THREE from "three";
import { ObliterreurConfig as oc } from "./ObliterreurConfig";

/**
 * The huge curved black-vortex beam of the OBLITERREUR.
 *
 * Three tube shells are built along the anchor-to-anchor bezier curve:
 *  - a CORE tube: chaotic near-black matter (domain-warped fbm) crawled by
 *    thin ridged lightning filaments, ragged noise-displaced silhouette;
 *  - a GLOW shell: blotchy additive violet halo, also displaced;
 *  - an ARC shell: much larger, almost fully transparent — only sparse
 *    flickering lightning bolts survive the threshold, giving the wild
 *    "black lightning" electric arcs whipping around the beam.
 *
 * Appear/implode is done entirely in the vertex shader — tube vertices are
 * centerline + normal * radius, so collapsing along the vertex normal
 * (`position - normal * uRadius * (1 - uAppear)`) grows/shrinks the tube
 * from its spine without ever rebuilding geometry.
 */

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    v += 0.5 * vnoise(p);
    v += 0.25 * vnoise(p * 2.13 + 17.0);
    v += 0.125 * vnoise(p * 4.41 + 47.0);
    return v / 0.875;
  }
`;

/**
 * Shared vertex shader: appear/implode collapse + animated radial noise
 * displacement so the silhouette is ragged and alive, never a clean tube.
 * The angular noise input is periodic (cos/sin) — no seam at uv.y = 0/1.
 */
const TUBE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uAppear;
  uniform float uRadius;
  uniform float uNoiseAmp;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  ${""}
  ${NOISE_GLSL}
  void main() {
    vUv = uv;
    float ap = clamp(uAppear, 0.0, 1.0);
    float ang = uv.y * 6.2831853;
    vec2 ring = vec2(cos(ang), sin(ang)) * 1.6;
    // Two noise octaves: fast small ripples + slow large bulges.
    float n1 = vnoise(vec2(uv.x * 46.0 - uTime * 4.5 + ring.x, ring.y + uTime * 1.6));
    float n2 = vnoise(vec2(uv.x * 10.0 + uTime * 2.1 + ring.y, ring.x - uTime * 0.9));
    float disp = (n1 - 0.5) * 0.7 + (n2 - 0.5) * 1.1;
    vec3 p = position - normal * uRadius * (1.0 - uAppear);
    p += normal * disp * uNoiseAmp * uRadius * ap;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAppear;
  uniform float uLen;
  uniform float uRotSpeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  ${""}
  ${NOISE_GLSL}

  void main() {
    // Domain-warped turbulence: chaotic void matter, never regular bands.
    vec2 base = vec2(
      vUv.x * uLen * 0.4 - uTime * 1.6,
      vUv.y * 3.0 + vUv.x * uLen * 0.22 + uTime * uRotSpeed
    );
    vec2 q = vec2(
      fbm(base * 1.3 + uTime * 0.35),
      fbm(base * 1.3 + vec2(5.2, 1.3) - uTime * 0.28)
    );
    float n = fbm(base + q * 3.5);

    // Base: the void — essentially black.
    vec3 col = vec3(0.008);

    // Dark-purple turbulent filaments riding the warped ridges.
    float fil = smoothstep(0.5, 0.85, n);
    vec3 deepViolet = vec3(0.165, 0.032, 0.271); // #2a0845
    vec3 filament   = vec3(0.298, 0.114, 0.584); // #4c1d95
    col = mix(col, mix(deepViolet, filament, fil), fil * 0.85);

    // Ridged lightning: thin branching bolts crawling on the black core.
    float r1 = 1.0 - abs(2.0 * fbm(base * 1.7 + q * 4.0 + vec2(0.0, uTime * 2.2)) - 1.0);
    float bolt = pow(smoothstep(0.7, 1.0, r1), 3.0);
    float flick = 0.5 + 0.5 * hash(vec2(floor(uTime * 13.0), floor(vUv.x * 30.0)));
    vec3 boltCol = mix(vec3(0.486, 0.227, 0.929), vec3(0.914, 0.835, 1.0), bolt);
    col += boltCol * bolt * flick * 2.4;

    // Torn violet event-horizon rim (fresnel eroded by the turbulence).
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 2.2);
    col += vec3(0.486, 0.227, 0.929) * fres * (0.45 + n * 0.9);

    float alpha = 0.95 * clamp(uAppear, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAppear;
  uniform float uLen;
  uniform float uRotSpeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  ${""}
  ${NOISE_GLSL}

  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 2.0);
    vec2 base = vec2(
      vUv.x * uLen * 0.3 - uTime * 2.0,
      vUv.y * 2.0 + uTime * uRotSpeed * 0.7
    );
    float streaks = fbm(base + vec2(fbm(base * 1.4), fbm(base * 1.4 + 7.0)) * 2.5);
    // Blotchy irregular energy — patches of glow, not a uniform sleeve.
    float blotch = 0.35 + 0.65 * vnoise(vec2(vUv.x * uLen * 0.12 - uTime * 0.9, uTime * 0.5));
    float pulse = 0.8 + 0.2 * sin(uTime * 3.1);
    float alpha = fres * (0.25 + streaks * 0.65) * blotch * clamp(uAppear, 0.0, 1.0) * pulse;
    vec3 col = mix(vec3(0.486, 0.227, 0.929), vec3(0.659, 0.333, 0.969), streaks);
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Outer shell: sparse jagged lightning arcs whipping around the beam. */
const ARC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAppear;
  uniform float uLen;
  uniform float uRotSpeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  ${""}
  ${NOISE_GLSL}

  void main() {
    // Elongated warped ridges → thin bolts stretched along the beam.
    vec2 base = vec2(
      vUv.x * uLen * 0.22 - uTime * 2.6,
      vUv.y * 2.0 + vUv.x * uLen * 0.1 + uTime * uRotSpeed * 1.3
    );
    vec2 q = vec2(fbm(base * 1.6 + uTime * 0.5), fbm(base * 1.6 - uTime * 0.4 + 9.0));
    float r1 = 1.0 - abs(2.0 * fbm(base + q * 3.0) - 1.0);
    float bolt = pow(smoothstep(0.78, 1.0, r1), 2.0);

    // Hard stochastic flicker: whole arc segments blink in and out.
    float cell = hash(vec2(floor(uTime * 16.0), floor(vUv.x * 22.0 + vUv.y * 5.0)));
    float flick = step(0.42, cell);

    vec3 col = mix(vec3(0.659, 0.333, 0.969), vec3(0.914, 0.835, 1.0), bolt);
    float alpha = bolt * flick * clamp(uAppear, 0.0, 1.0) * 0.9;
    gl_FragColor = vec4(col, alpha);
  }
`;

type Phase = "idle" | "appear" | "active" | "implode";

interface Shell {
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh | null;
  radius: number;
  renderOrder: number;
}

export class ObliterreurBeamVFX {
  private readonly shells: Shell[];
  private readonly lights: THREE.PointLight[] = [];

  private phase: Phase = "idle";
  private phaseTimer = 0;
  private implodeDuration: number = oc.obliterreurImplodeDuration;
  private appear = 0;

  constructor(private readonly scene: THREE.Scene) {
    const makeShell = (
      frag: string,
      radius: number,
      noiseAmp: number,
      blending: THREE.Blending,
      renderOrder: number,
    ): Shell => ({
      mat: new THREE.ShaderMaterial({
        vertexShader: TUBE_VERT,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uAppear: { value: 0 },
          uRadius: { value: radius },
          uNoiseAmp: { value: noiseAmp },
          uLen: { value: 1 },
          uRotSpeed: { value: oc.obliterreurVortexRotationSpeed },
        },
        transparent: true,
        depthWrite: false,
        blending,
        side: THREE.DoubleSide,
      }),
      mesh: null,
      radius,
      renderOrder,
    });

    const r = oc.obliterreurBeamRadius;
    this.shells = [
      makeShell(CORE_FRAG, r, oc.obliterreurCoreNoiseAmp, THREE.NormalBlending, 55),
      makeShell(
        GLOW_FRAG,
        r * oc.obliterreurGlowRadiusScale,
        oc.obliterreurGlowNoiseAmp,
        THREE.AdditiveBlending,
        56,
      ),
      makeShell(
        ARC_FRAG,
        r * oc.obliterreurArcRadiusScale,
        oc.obliterreurArcNoiseAmp,
        THREE.AdditiveBlending,
        57,
      ),
    ];

    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(
        0x7c3aed,
        0,
        oc.obliterreurEndpointLightDistance,
        2,
      );
      this.lights.push(light);
      scene.add(light);
    }
  }

  /** True while any beam mesh is alive (appearing, active or imploding). */
  get active(): boolean {
    return this.phase !== "idle";
  }

  /** Build the three tube shells along the curve and start APPEAR. */
  activate(curve: THREE.CubicBezierCurve3, length: number): void {
    this.disposeMeshes();

    const tubularSegments = Math.min(160, Math.max(32, Math.ceil(length * 6)));

    for (const shell of this.shells) {
      const geom = new THREE.TubeGeometry(curve, tubularSegments, shell.radius, 20, false);
      const mesh = new THREE.Mesh(geom, shell.mat);
      mesh.renderOrder = shell.renderOrder;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      shell.mesh = mesh;
      shell.mat.uniforms.uLen.value = length;
    }

    // Endpoint void lights.
    this.lights[0].position.copy(curve.v0);
    this.lights[1].position.copy(curve.v3);
    for (const l of this.lights) l.intensity = oc.obliterreurEndpointLightIntensity;

    this.phase = "appear";
    this.phaseTimer = 0;
    this.appear = 0;
  }

  /** Start the implosion (fast = RMB cancel, slow = natural expiry). */
  deactivate(fast: boolean): void {
    if (this.phase === "idle" || this.phase === "implode") return;
    this.implodeDuration = fast
      ? oc.obliterreurCancelImplodeDuration
      : oc.obliterreurImplodeDuration;
    this.phase = "implode";
    this.phaseTimer = 0;
  }

  update(dt: number, time: number): void {
    if (this.phase === "idle") return;

    this.phaseTimer += dt;

    if (this.phase === "appear") {
      const k = Math.min(1, this.phaseTimer / oc.obliterreurAppearDuration);
      // easeOutBack: slight overshoot for a violent snap-open.
      const c1 = 1.70158;
      const c3 = c1 + 1;
      this.appear = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
      if (k >= 1) {
        this.phase = "active";
        this.phaseTimer = 0;
      }
    } else if (this.phase === "implode") {
      const k = Math.min(1, this.phaseTimer / this.implodeDuration);
      this.appear = (1 - k) * (1 - k); // ease-in collapse
      const fade = 1 - k;
      for (const l of this.lights) {
        l.intensity = oc.obliterreurEndpointLightIntensity * fade;
      }
      if (k >= 1) {
        this.phase = "idle";
        this.appear = 0;
        for (const l of this.lights) l.intensity = 0;
        this.disposeMeshes();
      }
    } else {
      this.appear = 1;
      // Subtle unstable flicker on the endpoint lights.
      const flicker = 0.85 + 0.15 * Math.sin(time * 23) * Math.sin(time * 7.7);
      for (const l of this.lights) {
        l.intensity = oc.obliterreurEndpointLightIntensity * flicker;
      }
    }

    for (const shell of this.shells) {
      shell.mat.uniforms.uTime.value = time;
      shell.mat.uniforms.uAppear.value = this.appear;
    }
  }

  private disposeMeshes(): void {
    for (const shell of this.shells) {
      if (shell.mesh) {
        this.scene.remove(shell.mesh);
        shell.mesh.geometry.dispose();
        shell.mesh = null;
      }
    }
  }

  /**
   * Full teardown: meshes, endpoint lights and shader materials removed
   * from the scene/GPU. Used by REMOTE beam replicas when their owner
   * leaves the room (the local weapon lives for the whole session).
   */
  dispose(): void {
    this.phase = "idle";
    this.appear = 0;
    this.disposeMeshes();
    for (const light of this.lights) {
      light.intensity = 0;
      this.scene.remove(light);
      light.dispose();
    }
    for (const shell of this.shells) shell.mat.dispose();
  }
}
