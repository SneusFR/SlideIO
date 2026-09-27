import * as THREE from "three";
import type { PaintSplats } from "./PaintSplats";
import type { PaintHit } from "./PaintballProjectiles";

/**
 * Live muzzle of the shooter (WORLD). Returns false once the weapon is gone
 * (switch, death, hidden avatar): the jet then keeps its last start point.
 */
export type PaintballAnchor = (out: THREE.Vector3) => boolean;

export interface PaintJetsOptions {
  /** Jets alive at once, all players together (ring buffer). Default 96. */
  maxJets?: number;
  /** Tube segments drawn at once, all jets together. Default 2048. */
  maxSegments?: number;
  /** Paint droplets alive at once (splashes + drips). Default 768. */
  maxDrops?: number;
  /** Head speed (m/s) — tracer speed: the splat lands practically with the hitscan. Default 700. */
  speed?: number;
  /** Stream radius (m). Default 0.045 (a 9 cm thick cartoon paint stream). */
  radius?: number;
  /** Minimum ON-SCREEN radius (radians seen from the camera): a far stream never thins to nothing. Default 0.0035. */
  minAngularRadius?: number;
  /** Ease-in of the head (1 = constant speed). Default 1.3 (same arrival time, the exit is seen). */
  easeIn?: number;
  /** Built-in key light (0 = scene lighting only): keeps the paint readable on a dark map. Default 0.2. */
  glow?: number;
}

/**
 * Head flight time bounds (s): ≥ 2 frames (a point-blank jet is still seen
 * leaving the barrel), ≤ 0.1 s whatever the distance (no weapon range).
 */
const MIN_FLIGHT = 2 / 60;
const MAX_FLIGHT = 0.1;
/** Updates during which the jet start follows the live muzzle (then: the fired ray). */
const ANCHOR_FRAMES = 2;
/** Time (s) the stream stays attached to the nozzle before its tail leaves (pulsed paint gun). */
const EMIT = 0.05;
/** Time (s) the detached tail takes to drain from the nozzle into the impact. */
const DRAIN = 0.14;
/** Length (m) of paint already out of the barrel on the spawn frame. */
const HEAD_START = 0.22;
/** Leading blob radius (× stream radius). */
const HEAD_BULGE = 1.4;
/** Max on-screen radius (rad) near the camera: at the FP muzzle the stream never fills the view. */
const MAX_ANGULAR_RADIUS = 0.04;
/** Ripples / beads travel along the stream at this speed (m/s, visual only). */
const FLOW = 14;
/** Tube segment length = distance to the viewer × this (constant on-screen detail), clamped. */
const SEG_PER_DIST = 0.08;
const SEG_MIN = 0.3;
const SEG_MAX = 8;
const MAX_SEG_PER_JET = 96;
/** Tube resolution of one segment. */
const RADIAL = 10;
const RINGS = 16;
/** Splash crown on arrival + small drips while the stream pours into the impact. */
const SPLASH_DROPS = 12;
const DRIP_INTERVAL = 0.02;
const GRAVITY = 9.8;
/** Droplets never shrink below this on-screen radius (rad). */
const DROP_MIN_ANGLE = 0.0015;
/** Paint radius on a character (m): 3× the pack's 7.5 cm (unchanged from the balls). */
const PAINT_RADIUS = 0.225;
/** Key-light direction of the built-in shading, in VIEW space (ViewmodelSystem key light). */
const KEY_DIR_VIEW = new THREE.Vector3(0.6, 1.0, 1.4).normalize();

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();
// splash() scratch (never aliases the caller's vectors)
const _sn = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

const f = (x: number): string => x.toFixed(5);

/** Value noise + height-gradient normal perturbation shared by the paint shaders (fragment). */
const PAINT_COMMON_GLSL = /* glsl */ `
float pjHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float pjNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 u = fract(x);
  u = u * u * (3.0 - 2.0 * u);
  return mix(
    mix(mix(pjHash(i), pjHash(i + vec3(1.0, 0.0, 0.0)), u.x),
        mix(pjHash(i + vec3(0.0, 1.0, 0.0)), pjHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(pjHash(i + vec3(0.0, 0.0, 1.0)), pjHash(i + vec3(1.0, 0.0, 1.0)), u.x),
        mix(pjHash(i + vec3(0.0, 1.0, 1.0)), pjHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
// Surface-gradient bump (Mikkelsen) with UN-normalized screen derivatives:
// the height is in METRES, so the relief keeps its real scale at any distance.
vec3 pjPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  if (abs(det) < 1e-14) return surfNorm;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(surfNorm - grad / abs(det));
}
`;

/** Wet paint shine at the emissive stage: key-light lambert share + sharp highlight + glossy rim. */
function wetShine(glow: number): string {
  const k = KEY_DIR_VIEW;
  return /* glsl */ `
  {
    vec3 pjV = normalize(vViewPosition);
    vec3 pjK = vec3(${f(k.x)}, ${f(k.y)}, ${f(k.z)});
    float pjNdV = clamp(dot(normal, pjV), 0.0, 1.0);
    float pjLam = 0.45 + 0.55 * max(dot(normal, pjK), 0.0);
    float pjSpec = pow(max(dot(normal, normalize(pjK + pjV)), 0.0), 64.0);
    float pjRim = pow(1.0 - pjNdV, 3.0);
    totalEmissiveRadiance += diffuseColor.rgb * ${f(glow)} * pjLam
      + vec3(0.5 * pjSpec)
      + mix(diffuseColor.rgb, vec3(1.0), 0.25) * (0.14 * pjRim);
  }`;
}

/**
 * Vertex (pars): stream radius along the jet, `s` = metres from the jet
 * start. Ripples travelling with the paint, rounded leading blob + neck,
 * rounded tail that breaks into beads while it drains (Rayleigh-Plateau),
 * nozzle narrowing. `pjDetail` fades the small-scale shape where the tube
 * rings get too sparse to carry it (far segments), never aliasing.
 */
const JET_VERTEX_PARS = /* glsl */ `
attribute vec4 aSeg; // sStart, segLen, sTail, sHead (m)
attribute vec4 aJet; // seed, age (s), detach (0..1), radius (m)
varying vec3 vPjPaint; // s (m), radius ratio, detach
varying vec2 vPjRing;  // position around the stream (unit circle)
varying vec2 vPjJet;   // seed, age
float pjRadius(float s, float rv, float detail) {
  float sTail = aSeg.z, sHead = aSeg.w;
  float dh = sHead - s, dt = s - sTail;
  if (dh <= 0.0 || dt <= 0.0) return 0.0;
  float ph = aJet.x * 6.2831853;
  float det = aJet.z;
  float w = s - aJet.y * ${f(FLOW)};
  // Ripples (varicose waves) moving with the paint.
  float r = rv * (1.0 + detail * (0.12 * sin(w * 15.7 + ph) + 0.06 * sin(w * 37.0 + ph * 2.3)));
  // Rounded leading blob, then a neck back to the stream.
  float rh = rv * ${f(HEAD_BULGE)};
  float cap = rh * 1.6;
  r = mix(r, rh, 1.0 - smoothstep(cap, cap + rv * 5.0, dh));
  if (dh < cap) { float x = 1.0 - dh / cap; r = rh * sqrt(max(0.0, 1.0 - x * x)); }
  // Tail: rounded taper, then the stream breaks into beads while draining.
  r *= sqrt(smoothstep(0.0, mix(0.03, 0.35, det), dt));
  float brk = det * (1.0 - smoothstep(0.0, mix(0.4, 3.0, det), dt)) + 0.9 * smoothstep(0.55, 1.0, det);
  brk = clamp(brk, 0.0, 1.0) * smoothstep(0.0, cap * 2.0, dh) * detail;
  float bead = sqrt(max(0.0, 0.5 + 0.5 * cos(w * 14.0 + ph * 3.1)));
  r *= mix(1.0, bead * 1.3, brk);
  r *= mix(1.0, 0.72, det);
  // Nozzle: the stream widens as it leaves the barrel.
  r *= 0.6 + 0.4 * smoothstep(0.0, 0.5, s);
  return r;
}
`;

/** Vertex (replaces beginnormal_vertex): shape the unit tube + its analytic normal. */
function jetVertexShape(minAngle: number): string {
  return /* glsl */ `
float pjZ = position.z;
float pjS = aSeg.x + pjZ * aSeg.y;
#ifdef USE_INSTANCING
  vec3 pjC = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, pjZ, 1.0)).xyz;
#else
  vec3 pjC = (modelMatrix * vec4(0.0, 0.0, pjZ, 1.0)).xyz;
#endif
float pjDist = distance(pjC, cameraPosition);
// Readable at any distance: never thinner than ${minAngle} rad, never wider than ${MAX_ANGULAR_RADIUS} rad.
float pjRv = min(max(aJet.w, pjDist * ${f(minAngle)}), pjDist * ${f(MAX_ANGULAR_RADIUS)});
float pjDetail = 1.0 - smoothstep(0.03, 0.08, aSeg.y / ${RINGS.toFixed(1)});
float pjR = pjRadius(pjS, pjRv, pjDetail);
float pjDr = (pjRadius(pjS + 0.004, pjRv, pjDetail) - pjRadius(pjS - 0.004, pjRv, pjDetail)) / 0.008;
float pjPh = aJet.x * 6.2831853;
// Slight liquid wobble, none at the nozzle.
vec2 pjOff = pjRv * (0.2 + 0.5 * aJet.z) * smoothstep(0.0, 0.6, pjS)
  * vec2(sin(pjS * 3.1 + pjPh), cos(pjS * 2.3 + pjPh * 1.7));
vec3 pjXf = vec3(position.xy * pjR + pjOff, pjZ);
vPjPaint = vec3(pjS, pjR / max(pjRv, 1e-5), aJet.z);
vPjRing = position.xy * pjRv; // metres around the stream
vPjJet = aJet.xy;
// Object normal of r(z): radial + profile slope (z is scaled by segLen in the instance matrix).
vec3 objectNormal = vec3(position.xy, -pjDr * aSeg.y);
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif
`;
}

/**
 * Fragment (colour stage): procedural wet paint — flow streaks + fine
 * bubbles moving WITH the paint (relief height pjH in metres), pigment
 * variation (richer where thick, lighter film where thin). pjFine drives
 * the roughness; the normal is perturbed from pjH later.
 */
const JET_FRAGMENT_COLOR = /* glsl */ `
// Paint coordinates in METRES: along the flow (moving with the paint) and
// around the stream (vPjRing is already scaled by the stream radius).
float pjFlow = vPjPaint.x - vPjJet.y * ${f(FLOW)};
vec3 pjQ = vec3(pjFlow, vPjRing);
vec3 pjO = vec3(vPjJet.x * 37.0, vPjJet.x * 11.0, vPjJet.x * 23.0);
float pjN1 = pjNoise(pjQ * vec3(8.0, 30.0, 30.0) + pjO);
float pjN2 = pjNoise(pjQ * vec3(25.0, 60.0, 60.0) + pjO + 11.0);
float pjFine = pjNoise(pjQ * vec3(70.0, 110.0, 110.0) + pjO + 23.0);
// Anti-aliasing: each octave fades out once it gets under ~3 pixels.
float pjPix = max(fwidth(vPjPaint.x), 1e-6);
float pjAA2 = 1.0 - smoothstep(0.12, 0.3, pjPix * 60.0);
float pjAA3 = 1.0 - smoothstep(0.12, 0.3, pjPix * 110.0);
float pjMix = 0.55 * pjN1 + 0.3 * mix(0.5, pjN2, pjAA2) + 0.15 * mix(0.5, pjFine, pjAA3);
float pjH = ((pjN1 - 0.5) * 0.55 + (pjN2 - 0.5) * 0.3 * pjAA2 + (pjFine - 0.5) * 0.15 * pjAA3) * 0.006;
pjFine = mix(0.5, pjFine, pjAA3);
// Pigment: raised / thick paint slightly richer, a thin film slightly lighter (subtle: the colour stays the ball's).
diffuseColor.rgb *= 0.88 + 0.24 * pjMix;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 1.4, 0.12 * pjN1);
diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * 1.15 + 0.02, vec3(1.0)), 0.2 * (1.0 - smoothstep(0.35, 0.8, vPjPaint.y)));
`;

/**
 * PAINT JETS (SlideIO) — what everybody SEES when the Paintball Rifle
 * fires, for a HITSCAN weapon (the damage already happened): a real stream
 * of liquid paint in the EXACT colour of the ball that left the hopper.
 *   - SHAPE: one straight stream muzzle → hitscan impact, drawn as a chain
 *     of instanced tube segments whose radius is computed in the vertex
 *     shader: a rounded blob at the front, ripples travelling with the
 *     paint, a slight wobble, a tapered tail that BREAKS INTO BEADS while
 *     it drains. Segment length follows the distance to the viewer.
 *   - TIMING: the front reaches the impact at tracer speed (700 m/s, ≥ 2
 *     frames, ≤ 0.1 s — the splat still lands practically on the click);
 *     the stream stays attached to the nozzle 50 ms, then its tail drains
 *     into the impact in 0.14 s. At 600 shots/min the pulses overlap: a
 *     pulsing paint hose while the trigger is held.
 *   - LOOK: wet, glossy liquid paint — low roughness, procedural relief
 *     (flow streaks + fine bubbles, no texture) flowing with the paint,
 *     pigment variation, sharp highlight + glossy rim from a built-in key
 *     light (reads on a dark map too). Opaque (no transparent sorting).
 *   - IMPACT: splash crown of droplets (stretched along their velocity,
 *     falling under gravity), drips while the stream pours in, and the
 *     persistent splat / character paint exactly like the balls did
 *     (PaintSplats, seeded → identical on every client).
 *   - GLUED TO THE GUN: the first updates read the shooter's LIVE muzzle,
 *     then the stream stays on the fired ray (a camera turn never bends it).
 * 2 InstancedMeshes shared by every shooter (stream, droplets): 2 draw
 * calls, no per-frame allocation, zero work when nothing flies.
 */
export class PaintJets {
  /** Stream tube segments (all jets). */
  readonly mesh: THREE.InstancedMesh;
  /** Splash droplets. */
  readonly drops: THREE.InstancedMesh;
  readonly radius: number;
  readonly speed: number;
  /** Viewer position (camera) for the segment detail — set each frame. */
  readonly viewer = new THREE.Vector3();
  private hasViewer = false;
  private readonly minAngle: number;
  private readonly ease: number;
  private readonly maxJets: number;
  private readonly maxSeg: number;
  // ---- jets ----
  private readonly a: Float32Array; // start (refreshed from the anchor)
  private readonly b: Float32Array; // impact
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly t: Float32Array;
  private readonly dur: Float32Array;
  private readonly seed: Float32Array;
  private readonly drip: Float32Array;
  private readonly alive: Uint8Array;
  private readonly arrived: Uint8Array;
  private readonly frames: Uint8Array;
  private readonly hits: (PaintHit | null)[];
  private readonly anchors: (PaintballAnchor | null)[];
  private next = 0;
  private live = 0;
  private spawned = 0;
  // ---- per-segment instance data ----
  private readonly segAttr: THREE.InstancedBufferAttribute; // sStart, segLen, sTail, sHead (m)
  private readonly jetAttr: THREE.InstancedBufferAttribute; // seed, age, detach, radius
  // ---- droplets ----
  private readonly maxDrops: number;
  private readonly dp: Float32Array;
  private readonly dv: Float32Array;
  private readonly dc: Float32Array;
  private readonly dr: Float32Array;
  private readonly dage: Float32Array;
  private readonly dlife: Float32Array;
  private dNext = 0;
  private dLive = 0;
  private dSpawned = 0;
  splats: PaintSplats | null;

  constructor(parent: THREE.Object3D, splats: PaintSplats | null, options: PaintJetsOptions = {}) {
    const J = (this.maxJets = options.maxJets ?? 96);
    const S = (this.maxSeg = options.maxSegments ?? 2048);
    const D = (this.maxDrops = options.maxDrops ?? 768);
    this.speed = options.speed ?? 700;
    this.radius = options.radius ?? 0.045;
    this.minAngle = options.minAngularRadius ?? 0.0035;
    this.ease = options.easeIn ?? 1.3;
    const glow = options.glow ?? 0.2;
    this.splats = splats;

    this.a = new Float32Array(J * 3);
    this.b = new Float32Array(J * 3);
    this.nrm = new Float32Array(J * 3);
    this.col = new Float32Array(J * 3);
    this.t = new Float32Array(J);
    this.dur = new Float32Array(J);
    this.seed = new Float32Array(J);
    this.drip = new Float32Array(J);
    this.alive = new Uint8Array(J);
    this.arrived = new Uint8Array(J);
    this.frames = new Uint8Array(J);
    this.hits = new Array(J).fill(null);
    this.anchors = new Array(J).fill(null);

    // ---- Stream: unit open tube along +Z (z = 0 → 1, radius 1); the vertex
    // shader shapes every segment from its jet parameters.
    const tube = buildTube();
    this.segAttr = new THREE.InstancedBufferAttribute(new Float32Array(S * 4), 4);
    this.jetAttr = new THREE.InstancedBufferAttribute(new Float32Array(S * 4), 4);
    this.segAttr.setUsage(THREE.DynamicDrawUsage);
    this.jetAttr.setUsage(THREE.DynamicDrawUsage);
    tube.setAttribute("aSeg", this.segAttr);
    tube.setAttribute("aJet", this.jetAttr);
    const jetMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0 });
    const shape = jetVertexShape(this.minAngle);
    jetMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n" + JET_VERTEX_PARS)
        .replace("#include <beginnormal_vertex>", shape)
        .replace("#include <begin_vertex>", "vec3 transformed = pjXf;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vPjPaint;\nvarying vec2 vPjRing;\nvarying vec2 vPjJet;\n" + PAINT_COMMON_GLSL)
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + JET_FRAGMENT_COLOR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.07, 0.3, pjFine * pjFine);")
        .replace(
          "#include <normal_fragment_maps>",
          "#include <normal_fragment_maps>\nnormal = pjPerturb(-vViewPosition, normal, vec2(dFdx(pjH), dFdy(pjH)), faceDirection);",
        )
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + wetShine(glow));
    };
    jetMat.customProgramCacheKey = () => `paint-jet-v1-${glow.toFixed(3)}-${this.minAngle}`;
    this.mesh = makeInstanced(tube, jetMat, S, "PaintJets");
    parent.add(this.mesh);

    // ---- Droplets: smooth spheres, the same wet paint shine.
    this.dp = new Float32Array(D * 3);
    this.dv = new Float32Array(D * 3);
    this.dc = new Float32Array(D * 3);
    this.dr = new Float32Array(D);
    this.dage = new Float32Array(D);
    this.dlife = new Float32Array(D);
    const dropMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0 });
    dropMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n" + wetShine(glow),
      );
    };
    dropMat.customProgramCacheKey = () => `paint-drop-v1-${glow.toFixed(3)}`;
    this.drops = makeInstanced(new THREE.SphereGeometry(1, 12, 8), dropMat, D, "PaintDrops");
    parent.add(this.drops);
  }

  /** Jets currently alive (flying / draining). */
  get activeCount(): number {
    return this.live;
  }

  /** Droplets currently alive. */
  get dropCount(): number {
    return this.dLive;
  }

  /** Total life of a jet (s) after the front arrived at the latest: attached, then drained. */
  get lifetime(): number {
    return EMIT + DRAIN;
  }

  /** Viewer (camera) world position — segment detail follows it. Call before update(). */
  setViewer(position: THREE.Vector3): void {
    this.viewer.copy(position);
    this.hasViewer = true;
  }

  /** Front flight time over `distance` (tracer speed, bounded). */
  flightTime(distance: number): number {
    return Math.min(MAX_FLIGHT, Math.max(MIN_FLIGHT, distance / this.speed));
  }

  /**
   * Displayed stream radius at `position` (CPU mirror of the shader clamp):
   * the real radius, never thinner than the minimum on-screen size far
   * away, never wider than MAX_ANGULAR_RADIUS right in front of the camera.
   */
  displayRadius(position: THREE.Vector3): number {
    if (!this.hasViewer) return this.radius;
    const d = position.distanceTo(this.viewer);
    return Math.min(Math.max(this.radius, d * this.minAngle), d * MAX_ANGULAR_RADIUS);
  }

  /**
   * from: muzzle (WORLD) at the shot. to: the hitscan impact (or the
   * max-range point). color: the ball's paint. hit: what to paint on arrival
   * (null = miss). anchor: the shooter's live muzzle — null = fixed start.
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, hit: PaintHit | null, anchor: PaintballAnchor | null = null): void {
    const i = this.next;
    this.next = (this.next + 1) % this.maxJets;
    if (!this.alive[i]) this.live++;
    const i3 = i * 3;
    this.a[i3] = from.x; this.a[i3 + 1] = from.y; this.a[i3 + 2] = from.z;
    this.b[i3] = to.x; this.b[i3 + 1] = to.y; this.b[i3 + 2] = to.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    const nn = hit?.normal;
    if (nn) _n.copy(nn).normalize();
    else _n.subVectors(from, to).normalize();
    this.nrm[i3] = _n.x; this.nrm[i3 + 1] = _n.y; this.nrm[i3 + 2] = _n.z;
    this.hits[i] = hit;
    this.anchors[i] = anchor;
    this.dur[i] = this.flightTime(from.distanceTo(to));
    this.spawned = (this.spawned + 1) >>> 0;
    this.seed[i] = hash01(this.spawned, 11);
    this.t[i] = 0;
    this.drip[i] = 0;
    this.frames[i] = 0;
    this.arrived[i] = 0;
    this.alive[i] = 1;
  }

  /**
   * Splash crown of `count` droplets at `point` around `normal` (also used
   * by the GPU warm-up so the droplet program compiles at load).
   */
  splash(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count = SPLASH_DROPS, strength = 1): void {
    _sn.copy(normal).normalize();
    if (Math.abs(_sn.y) < 0.9) _t1.set(0, 1, 0).cross(_sn).normalize();
    else _t1.set(1, 0, 0).cross(_sn).normalize();
    _t2.crossVectors(_sn, _t1);
    for (let k = 0; k < count; k++) {
      const h = (this.dSpawned = (this.dSpawned + 1) >>> 0);
      const phi = ((k + hash01(h, 1)) / count) * Math.PI * 2;
      const side = (1.4 + 3.0 * hash01(h, 2)) * strength;
      const up = (0.8 + 2.4 * hash01(h, 3)) * strength;
      _sv.copy(_t1).multiplyScalar(Math.cos(phi) * side).addScaledVector(_t2, Math.sin(phi) * side).addScaledVector(_sn, up);
      _sp.copy(point).addScaledVector(_sn, 0.03);
      const r = (0.012 + 0.022 * hash01(h, 4)) * (0.6 + 0.4 * strength);
      this.addDrop(_sp, _sv, color, r, 0.3 + 0.3 * hash01(h, 5));
    }
  }

  /** Once per frame, AFTER the camera / weapons moved (anchors read final poses). */
  update(dt: number): void {
    if (this.live > 0) this.updateJets(dt);
    else if (this.mesh.count !== 0) {
      this.mesh.count = 0;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.dLive > 0) this.updateDrops(dt);
    else if (this.drops.count !== 0) {
      this.drops.count = 0;
      this.drops.instanceMatrix.needsUpdate = true;
    }
  }

  /** Drop every jet + droplet (session change). */
  clear(): void {
    this.alive.fill(0);
    this.hits.fill(null);
    this.anchors.fill(null);
    this.live = 0;
    this.dlife.fill(0);
    this.dLive = 0;
    for (const m of [this.mesh, this.drops]) {
      m.count = 0;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of [this.mesh, this.drops]) {
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
      m.dispose();
    }
  }

  private updateJets(dt: number): void {
    const seg = this.segAttr.array as Float32Array;
    const jet = this.jetAttr.array as Float32Array;
    let drawn = 0;
    for (let i = 0; i < this.maxJets; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;
      // The spawn frame is drawn at t = 0 (AT the muzzle): the shot happens
      // earlier in the same frame, advancing it now would first show the
      // stream already metres away from the gun.
      const t = this.frames[i] === 0 ? this.t[i] : (this.t[i] += dt);
      // First updates: the stream starts at the LIVE muzzle — it never lags
      // behind a moving shooter. Then it stays on the fired ray.
      const anchor = this.anchors[i];
      if (anchor) {
        if (this.frames[i] < ANCHOR_FRAMES && anchor(_a)) {
          this.a[i3] = _a.x; this.a[i3 + 1] = _a.y; this.a[i3 + 2] = _a.z;
        }
        if (this.frames[i] + 1 >= ANCHOR_FRAMES) this.anchors[i] = null;
      }
      if (this.frames[i] < 255) this.frames[i]++;

      _a.set(this.a[i3], this.a[i3 + 1], this.a[i3 + 2]);
      _d.set(this.b[i3] - _a.x, this.b[i3 + 1] - _a.y, this.b[i3 + 2] - _a.z);
      const len = _d.length();
      if (len > 1e-5) _d.divideScalar(len);
      else _d.set(0, 0, -1);

      // Front: tracer speed, same arrival time as the hitscan balls had.
      const h0 = Math.min(HEAD_START, len * 0.5);
      const u = Math.min(1, t / this.dur[i]);
      const sHead = h0 + (len - h0) * Math.pow(u, this.ease);
      if (u >= 1 && !this.arrived[i]) {
        this.arrived[i] = 1;
        this.anchors[i] = null;
        this.arrive(i);
      }
      // Tail: attached to the nozzle, then drains into the impact.
      const detach = Math.min(1, Math.max(0, (t - EMIT) / DRAIN));
      const sTail = Math.min(len * Math.pow(detach, 1.35), Math.max(0, sHead - 0.02));
      if (detach >= 1 && this.arrived[i]) {
        this.free(i);
        continue;
      }
      // The stream pours into the impact: small drips while it drains.
      if (this.arrived[i] && this.hits[i] && detach < 0.85) {
        this.drip[i] += dt;
        while (this.drip[i] >= DRIP_INTERVAL) {
          this.drip[i] -= DRIP_INTERVAL;
          _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
          _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
          _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
          this.splash(_p, _n, _col, 2, 0.5);
        }
      }

      // Tube segments tail → front; constant on-screen detail.
      _q.setFromUnitVectors(_z, _d);
      _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]); // EXACT hopper colour
      const sd = this.seed[i];
      let s = sTail;
      let count = 0;
      while (s < sHead - 1e-4 && drawn < this.maxSeg) {
        _p.copy(_a).addScaledVector(_d, s);
        const dist = this.hasViewer ? _p.distanceTo(this.viewer) : 4;
        let step = Math.min(SEG_MAX, Math.max(SEG_MIN, dist * SEG_PER_DIST));
        if (sHead - s < step * 3) step *= 0.5; // resolve the rounded front blob
        let e = count === MAX_SEG_PER_JET - 1 ? sHead : Math.min(sHead, s + step);
        if (sHead - e < step * 0.3) e = sHead;
        const segLen = Math.max(1e-3, e - s);
        this.mesh.setMatrixAt(drawn, _m.compose(_p, _q, _s.set(1, 1, segLen)));
        this.mesh.setColorAt(drawn, _col);
        const k4 = drawn * 4;
        seg[k4] = s; seg[k4 + 1] = segLen; seg[k4 + 2] = sTail; seg[k4 + 3] = sHead;
        jet[k4] = sd; jet[k4 + 1] = t; jet[k4 + 2] = detach; jet[k4 + 3] = this.radius;
        drawn++;
        count++;
        s = e;
      }
    }
    commit(this.mesh, drawn);
    publish(this.segAttr, drawn, 4);
    publish(this.jetAttr, drawn, 4);
  }

  private updateDrops(dt: number): void {
    let drawn = 0;
    const drag = Math.max(0, 1 - 1.5 * dt);
    for (let i = 0; i < this.maxDrops; i++) {
      const life = this.dlife[i];
      if (life <= 0) continue;
      const age = (this.dage[i] += dt);
      if (age >= life) {
        this.dlife[i] = 0;
        this.dLive--;
        continue;
      }
      const i3 = i * 3;
      this.dv[i3 + 1] -= GRAVITY * dt;
      this.dv[i3] *= drag; this.dv[i3 + 1] *= drag; this.dv[i3 + 2] *= drag;
      this.dp[i3] += this.dv[i3] * dt; this.dp[i3 + 1] += this.dv[i3 + 1] * dt; this.dp[i3 + 2] += this.dv[i3 + 2] * dt;
      _v.set(this.dv[i3], this.dv[i3 + 1], this.dv[i3 + 2]);
      const sp = _v.length();
      if (sp > 1e-4) _q.setFromUnitVectors(_z, _v.divideScalar(sp));
      else _q.identity();
      _p.set(this.dp[i3], this.dp[i3 + 1], this.dp[i3 + 2]);
      // Pop in, stretched along the velocity (liquid), shrink away at the end;
      // never smaller than a readable dot far away.
      let r = this.dr[i];
      if (this.hasViewer) r = Math.max(r, _p.distanceTo(this.viewer) * DROP_MIN_ANGLE);
      r *= Math.min(1, age * 40) * (1 - smooth(0.55, 1, age / life));
      this.drops.setMatrixAt(drawn, _m.compose(_p, _q, _s.set(r, r, r * (1 + Math.min(1.6, sp * 0.12)))));
      this.drops.setColorAt(drawn, _col.setRGB(this.dc[i3], this.dc[i3 + 1], this.dc[i3 + 2]));
      drawn++;
    }
    commit(this.drops, drawn);
  }

  /** The front reached the impact: persistent paint + splash crown. */
  private arrive(i: number): void {
    const hit = this.hits[i];
    if (!hit) return; // miss (sky): the stream just pours into the void
    const i3 = i * 3;
    _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]); // exact hopper colour
    _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
    _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
    if (this.splats) {
      if (hit.mesh && hit.faceIndex !== undefined && hit.bary) {
        this.splats.paintHit(hit.mesh, hit.faceIndex, hit.bary, _col, PAINT_RADIUS);
      } else {
        this.splats.splatSurface(_p, _n, _col, undefined, hit.seed);
      }
    }
    this.splash(_p, _n, _col);
  }

  private addDrop(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, radius: number, life: number): void {
    const i = this.dNext;
    this.dNext = (this.dNext + 1) % this.maxDrops;
    if (this.dlife[i] <= 0) this.dLive++;
    const i3 = i * 3;
    this.dp[i3] = p.x; this.dp[i3 + 1] = p.y; this.dp[i3 + 2] = p.z;
    this.dv[i3] = v.x; this.dv[i3 + 1] = v.y; this.dv[i3 + 2] = v.z;
    this.dc[i3] = color.r; this.dc[i3 + 1] = color.g; this.dc[i3 + 2] = color.b;
    this.dr[i] = radius;
    this.dage[i] = 0;
    this.dlife[i] = life;
  }

  private free(i: number): void {
    this.alive[i] = 0;
    this.hits[i] = null;
    this.anchors[i] = null;
    this.live--;
  }
}

// ---------------------------------------------------------------------------

/** Unit open tube along +Z: (RINGS + 1) rings of RADIAL vertices at z = 0 … 1, radius 1. */
function buildTube(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= RINGS; j++) {
    const z = j / RINGS;
    for (let i = 0; i < RADIAL; i++) {
      const th = (i / RADIAL) * Math.PI * 2;
      pos.push(Math.cos(th), Math.sin(th), z);
      nor.push(Math.cos(th), Math.sin(th), 0);
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < RADIAL; i++) {
      const a = j * RADIAL + i;
      const b = j * RADIAL + ((i + 1) % RADIAL);
      const c = (j + 1) * RADIAL + ((i + 1) % RADIAL);
      const d = (j + 1) * RADIAL + i;
      idx.push(a, b, d, b, c, d); // CCW seen from outside
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.name = "PaintJetTube";
  return g;
}

function smooth(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
}

/** Deterministic hash → [0, 1) (counter × channel), no Math.random in the render loop. */
function hash01(n: number, channel: number): number {
  let x = (Math.imul(n, 0x9e3779b1) ^ Math.imul(channel, 0x85ebca77)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Shared InstancedMesh setup (dynamic, never culled / raycast, colour buffer allocated). */
function makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, max: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.raycast = () => {};
  mesh.count = 0;
  mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** Upload only the first `count` items of a dynamic attribute. */
function publish(attr: THREE.BufferAttribute, count: number, itemSize: number): void {
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count * itemSize);
  attr.needsUpdate = true;
}

/** Publish `count` instances (matrix + colour) of a pool — only the used range is uploaded. */
function commit(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  publish(mesh.instanceMatrix, count, 16);
  if (mesh.instanceColor) publish(mesh.instanceColor, count, 3);
}
