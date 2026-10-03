import * as THREE from "three";
import { rng, type PaintSplats } from "./PaintSplats";
import type { PaintHit } from "./PaintballProjectiles";
import { BODY_RINGS, NOSE_RINGS, PAINT_JET as K, RADIAL } from "./PaintJetSettings";

/**
 * Live muzzle of the shooter (WORLD), read every update while the jet is
 * still leaving the barrel. Returns false once the weapon is gone (switch,
 * death, hidden avatar): the jet then keeps its last start point.
 */
export type PaintballAnchor = (out: THREE.Vector3) => boolean;

export interface PaintJetsOptions {
  /** Jets alive at once, all players together (ring buffer = instances of the ONE jet mesh). Default 96. */
  maxJets?: number;
  /** Paint droplets alive at once (muzzle + shed + splashes). Default 1024. */
  maxDrops?: number;
  /** Mean head speed (m/s). Default PAINT_JET.speed. */
  speed?: number;
  /** Nominal jet radius (m). Default PAINT_JET.radius. */
  radius?: number;
  /** Minimum ON-SCREEN radius (radians seen from the camera). Default PAINT_JET.minAngularRadius. */
  minAngularRadius?: number;
  /** Built-in fill light on the paint (0 = scene lighting only; NOT a glow). Default PAINT_JET.glow. */
  fill?: number;
}

/** Impact pancakes alive at once (ring buffer), drawn with the droplet spheres. */
const MAX_IMPACTS = 48;
/** Max radius scale of the body while it drains into the impact (it squashes: shorter + fatter). */
const DRAIN_BULGE = 1.6;
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
// drop emitters scratch (never alias the caller's vectors nor _a / _d)
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _w3 = new THREE.Vector3();
const _w4 = new THREE.Vector3();
// splash() scratch
const _sn = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
// impact scratch
const _p2 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _c2 = new THREE.Color();
const _qi = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _ms = new THREE.Matrix4();
const _zero = new THREE.Vector3();
// drawn-axis scratch (FPS readability)
const _h = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _tc = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _dd = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

const f = (x: number): string => x.toFixed(5);

/**
 * Paint shine at the emissive stage: key-light fill (keeps colours saturated
 * on a dark map) + highlight. No glow. `wet` (the jets) adds the liquid look:
 * a thin dark edge on the silhouette (diffuse darkened where N·V → 0, before
 * the lights use it), a small sharp highlight and a thin sheen along the top.
 */
function paintShine(fill: number, wet: boolean): string {
  const k = KEY_DIR_VIEW;
  const edge = wet
    ? /* glsl */ `
    float pjNV = abs(dot(normal, pjV));
    diffuseColor.rgb *= 1.0 - ${f(K.rimDark)} * (1.0 - smoothstep(0.0, ${f(K.rimWidth)}, pjNV));`
    : "";
  const spec = wet
    ? /* glsl */ `
    float pjSpec = pow(max(dot(normal, normalize(pjK + pjV)), 0.0), 90.0);
    float pjSheen = smoothstep(0.72, 0.95, normal.y) * smoothstep(0.15, 0.45, pjNV);
    vec3 pjAdd = vec3(${f(K.wetSpecular)} * pjSpec + ${f(K.wetSheen)} * pjSheen);`
    : /* glsl */ `
    float pjSpec = pow(max(dot(normal, normalize(pjK + pjV)), 0.0), 48.0);
    vec3 pjAdd = vec3(0.2 * pjSpec);`;
  return /* glsl */ `
  {
    vec3 pjV = normalize(vViewPosition);
    vec3 pjK = vec3(${f(k.x)}, ${f(k.y)}, ${f(k.z)});${edge}
    float pjLam = 0.45 + 0.55 * max(dot(normal, pjK), 0.0);${spec}
    totalEmissiveRadiance += diffuseColor.rgb * ${f(fill)} * pjLam + pjAdd;
  }`;
}

/**
 * Vertex (pars). One instance = one whole jet; the instance matrix puts the
 * NOSE TIP at the origin with the drawn axis along +Z (no scale).
 * aJet = (seed, age, strain 0..1, nose radius m), aShape = (drawn length m, taper).
 */
const JET_VERTEX_PARS = /* glsl */ `
attribute vec4 aJet;
attribute vec2 aShape;
`;

/**
 * Vertex (replaces beginnormal_vertex): shapes the shared geometry into a
 * long liquid jet + its analytic normal. position.xy = ring direction,
 * position.z = t: 0 → 1 the body (pointed tail → nose base, radius
 * sin(u·π/2)^taper: thin needle that thickens progressively, no bulge),
 * 1 → 2 the lightly rounded nose (half ellipse, noseRound × radius long).
 * Elastic + asymmetric: the thin tail sways sideways (two frequencies, per-jet
 * phase, more while strained), the section breathes slightly oval. No
 * periodic ripples, no head blob.
 */
function jetVertexShape(): string {
  return /* glsl */ `
float pjT = position.z;
float pjLd = max(aShape.x, 1e-3);
float pjRh = aJet.w;
float pjLn = min(${f(K.noseRound)} * pjRh, 0.3 * pjLd);
float pjLb = pjLd - pjLn;
float pjZ;
float pjRp;
vec2 pjNr;
float pjU;
if (pjT <= 1.0) {
  pjU = pjT;
  float pjSn = max(sin(pjU * 1.5707963), 1e-4);
  pjRp = pow(pjSn, aShape.y);
  float pjDu = aShape.y * pow(pjSn, aShape.y - 1.0) * cos(pjU * 1.5707963) * 1.5707963;
  // ONE thinner neck sliding from behind the nose toward the tail (the paint
  // pulls and thins), fading in / out over its slide: never periodic ripples.
  float pjNph = fract(aJet.y * ${f(K.neckHz)} + aJet.x * 3.7);
  float pjNd = (pjU - (0.7 - 0.5 * pjNph)) / 0.1;
  float pjNg = ${f(K.neck)} * (0.6 + 0.4 * aJet.z) * sin(pjNph * 3.1415927) * exp(-pjNd * pjNd);
  pjDu = pjDu * (1.0 - pjNg) + pjRp * pjNg * 20.0 * pjNd;
  pjRp *= 1.0 - pjNg;
  pjZ = -pjLd + pjU * pjLb;
  pjNr = vec2(1.0, -pjRh * pjDu / max(pjLb, 1e-4));
} else {
  float pjA = (pjT - 1.0) * 1.5707963;
  pjU = 1.0;
  pjRp = cos(pjA);
  pjZ = -pjLn * (1.0 - sin(pjA));
  pjNr = vec2(cos(pjA) / pjRh, sin(pjA) / max(pjLn, 1e-4));
}
#ifdef USE_INSTANCING
  vec3 pjC = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, pjZ, 1.0)).xyz;
#else
  vec3 pjC = (modelMatrix * vec4(0.0, 0.0, pjZ, 1.0)).xyz;
#endif
// Never wider than ${K.maxAngularRadius} rad right in front of the camera (FP muzzle).
float pjR = min(pjRh, distance(pjC, cameraPosition) * ${f(K.maxAngularRadius)}) * pjRp;
float pjPh = aJet.x * 6.2831853;
float pjW = (1.0 - pjU) * (1.0 - pjU);
float pjAmp = pjRh * ${f(K.sway)} * (0.3 + 0.7 * aJet.z) * pjW;
vec2 pjOff = pjAmp * vec2(sin(aJet.y * 31.0 + pjPh + pjU * 2.4), cos(aJet.y * 23.0 + pjPh * 1.7 + pjU * 1.9));
// Soft bow of the middle of the body (slow, per-jet direction): not a rigid spike.
float pjBow = pjRh * ${f(K.bow)} * (0.5 + 0.5 * aJet.z) * sin(pjU * 3.1415927) * sin(aJet.y * 9.0 + pjPh * 1.3);
pjOff += pjBow * vec2(cos(pjPh * 1.7), sin(pjPh * 1.7));
float pjO = ${f(K.ovality)} * (0.4 + 0.6 * aJet.z) * sin(aJet.y * 27.0 + pjPh * 2.3);
vec2 pjSc = vec2(1.0 + pjO, 1.0 - pjO);
vec3 pjXf = vec3(position.xy * pjSc * pjR + pjOff, pjZ);
vec3 objectNormal = normalize(vec3(position.xy / pjSc * pjNr.x, pjNr.y));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif
`;
}

/**
 * PAINT JETS (SlideIO) — what everybody SEES when the Paintball Rifle fires
 * (the damage / ammo logic is the unchanged hitscan): an elastic, stretched
 * jet of liquid paint in the colour of the ball that left the hopper.
 *   - SHAPE: a long, wide liquid jet (≈ 24 cm thick), 3.5-5.3× longer than thick: lightly rounded
 *     nose, body that tapers progressively to a pointed tail. ONE shared
 *     geometry, ONE instance per jet, shaped in the vertex shader (light
 *     elastic, asymmetric sway of the tail + slightly oval section, per-jet
 *     seed; no periodic ripples, no head blob). Wet look: small sharp
 *     highlight, thin top sheen, thin dark edge on the silhouette.
 *   - BORN STRETCHED, STAYS LONG: on its first frame the jet is already
 *     launchLength long, tail at the nozzle. The nose flies at jet speed along
 *     the hitscan ray; the body length is a damped spring (ζ = 0.6) that
 *     relaxes it slightly to its rest length, clamped to [minLength,
 *     maxLength]: it never contracts into a ball. Volume is conserved (r² · L
 *     constant). A fixed sub-step (1/180 s) with an accumulator makes it
 *     independent of the frame rate. Each jet has its own seed: speed, rest
 *     length, spring frequency, taper and sway differ.
 *   - FPS READABILITY (layout): seen along its flight (the shooter's view),
 *     the drawn axis turns around the nose in the plane (viewer, flight) until
 *     the jet is ≥ minScreenAspect × longer than wide on screen — it stays on
 *     the screen line muzzle → impact. Far away it never thins under
 *     minAngularRadius (and lengthens as much, same proportions).
 *   - IMPACT: the head is clamped on the hitscan end point (never tunnels,
 *     fires exactly once). At that very moment the jet is REPLACED by a paint
 *     pancake (same sphere mesh as the droplets) that flattens against the
 *     surface and spreads, a few droplets fly sideways, and when it ends the
 *     persistent splat appears (PaintSplats): same colour, same seeded
 *     rotation / aspect, size varied per seed. Paint on a character is applied
 *     at the collision moment itself.
 *   - DROPLETS: only a few small, discreet, short, stretched ones (2 tiny
 *     ones at the muzzle, at most a couple shed by a strained body, 5 thrown
 *     sideways on impact).
 *   - LOOK: opaque, saturated, slightly glossy (no glow, no bloom, no
 *     transparency).
 * The start follows the LIVE muzzle only while the tail is still leaving it
 * (first few cm); afterwards the jet flies free along its fixed ray.
 * 2 InstancedMeshes shared by every shooter (jets, droplets), no per-frame
 * allocation, zero work when nothing flies.
 */
export class PaintJets {
  /** Jets (all shooters): one instance of the shared jet geometry per jet. */
  readonly mesh: THREE.InstancedMesh;
  /** Droplets. */
  readonly drops: THREE.InstancedMesh;
  readonly radius: number;
  readonly speed: number;
  /** Viewer position (camera) for the segment detail — set each frame. */
  readonly viewer = new THREE.Vector3();
  private hasViewer = false;
  private readonly minAngle: number;
  private readonly maxJets: number;
  // ---- jets ----
  private readonly a: Float32Array; // start (live until released)
  private readonly b: Float32Array; // impact
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly age: Float32Array;
  private readonly acc: Float64Array; // time not yet consumed by a fixed sub-step (s)
  private readonly dur: Float32Array; // head flight time (s)
  private readonly vh: Float32Array; // head speed (m/s)
  private readonly seed: Float32Array;
  private readonly rest: Float32Array; // rest length (m)
  private readonly omega: Float32Array; // spring angular frequency (rad/s)
  private readonly len: Float32Array; // body length (m): damped spring toward `rest`
  private readonly lenV: Float32Array; // its rate (m/s)
  private readonly h0: Float32Array; // head position at age 0 (m along the ray)
  private readonly head: Float32Array; // head position along the ray (m)
  private readonly shed: Float32Array;
  private readonly taper: Float32Array; // body profile exponent (per-jet)
  private readonly bw: Float32Array; // in-flight breathing angular frequency (rad/s)
  private readonly bph: Float32Array; // its phase (rad)
  private readonly drain: Float32Array; // time since the nose hit the surface (s), -1 = still flying
  private readonly len0: Float32Array; // body length when the nose hit (m)
  private readonly alive: Uint8Array;
  private readonly released: Uint8Array;
  private readonly frames: Uint8Array;
  private readonly hits: (PaintHit | null)[];
  private readonly anchors: (PaintballAnchor | null)[];
  private next = 0;
  private live = 0;
  private spawned = 0;
  // ---- per-jet instance data (one instance = one whole jet) ----
  private readonly jetAttr: THREE.InstancedBufferAttribute; // seed, age, strain 0..1, displayed nose radius (m)
  private readonly shapeAttr: THREE.InstancedBufferAttribute; // drawn length (m), taper
  private readonly instJet: Uint16Array; // instance → jet slot (this frame)
  private readonly tw: Float32Array; // drawn tail (WORLD)
  private readonly drawLen: Float32Array; // drawn length (m)
  private readonly drawRad: Float32Array; // drawn nose radius (m)
  // ---- droplets ----
  private readonly maxDrops: number;
  private readonly dp: Float32Array;
  private readonly dv: Float32Array;
  private readonly dc: Float32Array;
  private readonly dr: Float32Array;
  private readonly dage: Float32Array;
  private readonly dlife: Float32Array;
  private readonly ddrag: Float32Array;
  private dNext = 0;
  private dLive = 0;
  private dSpawned = 0;
  private dEmitted = 0;
  // ---- impact pancakes (the jet turned into paint squashed on the surface) ----
  private readonly ip = new Float32Array(MAX_IMPACTS * 3);
  private readonly inr = new Float32Array(MAX_IMPACTS * 3);
  private readonly ic = new Float32Array(MAX_IMPACTS * 3);
  private readonly iage = new Float32Array(MAX_IMPACTS);
  private readonly irot = new Float32Array(MAX_IMPACTS);
  private readonly iasp = new Float32Array(MAX_IMPACTS * 2);
  private readonly isize = new Float32Array(MAX_IMPACTS); // splat size (m) handed over at the end
  private readonly itarget = new Float32Array(MAX_IMPACTS); // final pancake radius (m)
  private readonly iseed = new Float64Array(MAX_IMPACTS);
  private readonly itan = new Float32Array(MAX_IMPACTS * 3); // travel direction along the surface (slanted hit)
  private readonly ismear = new Float32Array(MAX_IMPACTS); // forward smear share (0 = straight-on hit)
  private readonly isplat = new Int32Array(MAX_IMPACTS).fill(-1); // persistent splat being spread (-1 = none)
  private readonly ialive = new Uint8Array(MAX_IMPACTS);
  private readonly icommit = new Uint8Array(MAX_IMPACTS);
  private readonly ihit: (PaintHit | null)[] = new Array(MAX_IMPACTS).fill(null);
  private iNext = 0;
  private iLive = 0;
  /** Frame step being simulated, and the part of it elapsed since the current sub-step (s). */
  private frameDt = 0;
  private sinceHit = 0;
  splats: PaintSplats | null;

  constructor(parent: THREE.Object3D, splats: PaintSplats | null, options: PaintJetsOptions = {}) {
    const J = (this.maxJets = options.maxJets ?? 96);
    const D = (this.maxDrops = options.maxDrops ?? 1024);
    this.speed = options.speed ?? K.speed;
    this.radius = options.radius ?? K.radius;
    this.minAngle = options.minAngularRadius ?? K.minAngularRadius;
    const fill = options.fill ?? K.glow;
    this.splats = splats;

    this.a = new Float32Array(J * 3);
    this.b = new Float32Array(J * 3);
    this.nrm = new Float32Array(J * 3);
    this.col = new Float32Array(J * 3);
    this.age = new Float32Array(J);
    this.acc = new Float64Array(J);
    this.dur = new Float32Array(J);
    this.vh = new Float32Array(J);
    this.seed = new Float32Array(J);
    this.rest = new Float32Array(J);
    this.omega = new Float32Array(J);
    this.len = new Float32Array(J);
    this.lenV = new Float32Array(J);
    this.h0 = new Float32Array(J);
    this.head = new Float32Array(J);
    this.shed = new Float32Array(J);
    this.taper = new Float32Array(J);
    this.bw = new Float32Array(J);
    this.bph = new Float32Array(J);
    this.drain = new Float32Array(J).fill(-1);
    this.len0 = new Float32Array(J);
    this.instJet = new Uint16Array(J);
    this.tw = new Float32Array(J * 3);
    this.drawLen = new Float32Array(J);
    this.drawRad = new Float32Array(J);
    this.alive = new Uint8Array(J);
    this.released = new Uint8Array(J);
    this.frames = new Uint8Array(J);
    this.hits = new Array(J).fill(null);
    this.anchors = new Array(J).fill(null);

    // ---- Jets: ONE shared jet geometry (pointed tail → rounded nose), ONE
    // instance per jet; the vertex shader shapes it from the jet parameters.
    const geo = buildJetGeometry();
    this.jetAttr = new THREE.InstancedBufferAttribute(new Float32Array(J * 4), 4);
    this.shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(J * 2), 2);
    this.jetAttr.setUsage(THREE.DynamicDrawUsage);
    this.shapeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aJet", this.jetAttr);
    geo.setAttribute("aShape", this.shapeAttr);
    const jetMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: K.roughness, metalness: 0 });
    const shape = jetVertexShape();
    jetMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n" + JET_VERTEX_PARS)
        .replace("#include <beginnormal_vertex>", shape)
        .replace("#include <begin_vertex>", "vec3 transformed = pjXf;");
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n" + paintShine(fill, true),
      );
    };
    jetMat.customProgramCacheKey = () => `paint-jet-v4-${fill.toFixed(3)}`;
    this.mesh = makeInstanced(geo, jetMat, J, "PaintJets");
    parent.add(this.mesh);

    // ---- Droplets: smooth spheres, same shading.
    this.dp = new Float32Array(D * 3);
    this.dv = new Float32Array(D * 3);
    this.dc = new Float32Array(D * 3);
    this.dr = new Float32Array(D);
    this.dage = new Float32Array(D);
    this.dlife = new Float32Array(D);
    this.ddrag = new Float32Array(D);
    const dropMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: K.roughness * 0.8, metalness: 0 });
    dropMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n" + paintShine(fill, false),
      );
    };
    dropMat.customProgramCacheKey = () => `paint-drop-v2-${fill.toFixed(3)}`;
    // Droplets + impact pancakes share ONE mesh (same sphere geometry, same material).
    this.drops = makeInstanced(new THREE.SphereGeometry(1, 12, 8), dropMat, D + MAX_IMPACTS, "PaintDrops");
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

  /** Droplets emitted since creation (muzzle + shed + splash): lets tests / profiling check the amount per shot. */
  get dropsEmitted(): number {
    return this.dEmitted;
  }

  /** Impact pancakes currently alive (squashing against a surface). */
  get impactCount(): number {
    return this.iLive;
  }

  /** Upper bound (s) of a jet's life incl. its impact effect: longest flight + impact. */
  get lifetime(): number {
    return K.maxFlight + Math.max(K.impactDrain, K.impactLife);
  }

  /** Viewer (camera) world position — segment detail follows it. Call before update(). */
  setViewer(position: THREE.Vector3): void {
    this.viewer.copy(position);
    this.hasViewer = true;
  }

  /** Head flight time over `distance` (bounded). */
  flightTime(distance: number): number {
    return Math.min(K.maxFlight, Math.max(K.minFlight, distance / this.speed));
  }

  /**
   * Displayed jet radius at `position` (CPU mirror of the shader clamp): the
   * real radius, never thinner than the minimum on-screen size far away,
   * never wider than maxAngularRadius right in front of the camera.
   */
  displayRadius(position: THREE.Vector3): number {
    if (!this.hasViewer) return this.radius;
    const d = position.distanceTo(this.viewer);
    return Math.min(Math.max(this.radius, d * this.minAngle), d * K.maxAngularRadius);
  }

  /**
   * from: muzzle (WORLD) at the shot. to: the hitscan impact (or the
   * max-range point). color: the ball's paint (kept until the impact). hit:
   * what to paint on arrival (null = miss). anchor: the shooter's live muzzle.
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

    // Per-jet irregularity (deterministic hash, no Math.random).
    const n = (this.spawned = (this.spawned + 1) >>> 0);
    this.seed[i] = hash01(n, 11);
    const L = from.distanceTo(to);
    const speed = this.speed * (1 + (hash01(n, 12) * 2 - 1) * K.speedJitter);
    const dur = Math.min(K.maxFlight, Math.max(K.minFlight, L / speed));
    // BORN STRETCHED: on frame 0 the nose is already `launchLength` out of the
    // barrel and the tail sits at the nozzle — a long liquid jet with its
    // rounded nose, never a ball growing at the muzzle.
    const h0 = Math.min(K.launchLength, L * 0.5);
    this.dur[i] = dur;
    this.vh[i] = (L - h0) / dur;
    this.h0[i] = h0;
    this.rest[i] = Math.min(h0, K.restLength * (1 + (hash01(n, 13) * 2 - 1) * K.restJitter));
    this.omega[i] = Math.PI * 2 * K.springHz * (1 + (hash01(n, 14) * 2 - 1) * K.springHzJitter);
    this.taper[i] = K.taper * (1 + (hash01(n, 15) * 2 - 1) * K.taperJitter);
    this.bw[i] = Math.PI * 2 * K.breatheHz * (1 + (hash01(n, 16) * 2 - 1) * K.breatheHzJitter);
    this.bph[i] = hash01(n, 17) * Math.PI * 2;
    this.drain[i] = -1;
    this.len0[i] = h0;
    this.age[i] = 0;
    this.acc[i] = 0;
    this.len[i] = h0;
    this.lenV[i] = 0;
    this.head[i] = h0;
    this.shed[i] = 0;
    this.frames[i] = 0;
    this.released[i] = 0;
    this.alive[i] = 1;

    // Muzzle feedback: a few droplets thrown out of the barrel.
    if (L > 1e-4) {
      _w1.subVectors(to, from).divideScalar(L);
      this.emitMuzzle(from, _w1, color, n);
    }
  }

  /**
   * Splash crown of `count` droplets at `point` around `normal` (also used
   * by the GPU warm-up so the droplet program compiles at load).
   */
  splash(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count: number = K.splashDrops, strength = 1): void {
    _sn.copy(normal).normalize();
    if (Math.abs(_sn.y) < 0.9) _t1.set(0, 1, 0).cross(_sn).normalize();
    else _t1.set(1, 0, 0).cross(_sn).normalize();
    _t2.crossVectors(_sn, _t1);
    for (let k = 0; k < count; k++) {
      const h = (this.dSpawned = (this.dSpawned + 1) >>> 0);
      const phi = ((k + hash01(h, 1)) / count) * Math.PI * 2;
      // Mostly LATERAL (along the surface), only a little off it: the paint is thrown sideways.
      const side = (2.2 + 3.6 * hash01(h, 2)) * strength;
      const up = (0.3 + 0.9 * hash01(h, 3)) * strength;
      _sv.copy(_t1).multiplyScalar(Math.cos(phi) * side).addScaledVector(_t2, Math.sin(phi) * side).addScaledVector(_sn, up);
      _sp.copy(point).addScaledVector(_sn, 0.02);
      const r = (0.008 + 0.014 * hash01(h, 4)) * (0.6 + 0.4 * strength);
      this.addDrop(_sp, _sv, color, r, 0.16 + 0.16 * hash01(h, 5), 2.5);
    }
  }

  /** Once per frame, AFTER the camera / weapons moved (anchors read final poses). */
  update(dt: number): void {
    // A long hitch (tab switch, GC) is absorbed in sub-steps: the impact is
    // never skipped. Beyond 0.5 s the jets are simply finished.
    const step = Math.min(Math.max(dt, 0), 0.5);
    this.frameDt = step;
    if (this.live > 0) this.updateJets(step);
    else if (this.mesh.count !== 0) {
      this.mesh.count = 0;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.dLive > 0 || this.iLive > 0) this.updateDrops(step);
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
    // A splat still spreading keeps its final shape (it is persistent).
    for (let k = 0; k < MAX_IMPACTS; k++) if (this.ialive[k]) this.settleSplat(k);
    this.ialive.fill(0);
    this.ihit.fill(null);
    this.iLive = 0;
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
    const jet = this.jetAttr.array as Float32Array;
    const shp = this.shapeAttr.array as Float32Array;
    let drawn = 0;
    for (let i = 0; i < this.maxJets; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;
      // The start follows the LIVE muzzle only while the tail is still
      // leaving the barrel; afterwards the jet flies free on its fixed ray.
      if (!this.released[i]) {
        const anchor = this.anchors[i];
        if (anchor && anchor(_a)) {
          this.a[i3] = _a.x; this.a[i3 + 1] = _a.y; this.a[i3 + 2] = _a.z;
        }
      }
      _a.set(this.a[i3], this.a[i3 + 1], this.a[i3 + 2]);
      _d.set(this.b[i3] - _a.x, this.b[i3 + 1] - _a.y, this.b[i3 + 2] - _a.z);
      const L = _d.length();
      if (L > 1e-5) _d.divideScalar(L);
      else _d.set(0, 0, -1);

      // The spawn frame is drawn at age 0 (AT the muzzle): the shot happened
      // earlier in the same frame, advancing it now would show the jet already
      // metres away from the gun.
      if (this.frames[i] > 0 && !this.step(i, dt, L)) {
        this.free(i);
        continue;
      }
      if (this.frames[i] < 255) this.frames[i]++;
      const head = this.head[i];
      const len = this.len[i];
      const tail = head - len;
      if (!this.released[i] && tail > K.anchorRelease) this.released[i] = 1;
      if (len < 1e-3) continue;

      // Volume conservation: stretched = thinner, relaxed = a bit thicker
      // (the length stays 3.5-5.3× the thickness: never a ball). While draining
      // into the impact it squashes: shorter and fatter (bounded).
      const r = this.radius * this.radiusScale(i, len);
      _h.copy(_a).addScaledVector(_d, head); // nose tip (WORLD)
      _tc.copy(_a).addScaledVector(_d, tail); // physical tail → drawn tail (in place)
      const rd = this.layout(_h, _tc, _a, len, r, this.drain[i] >= 0);
      _dd.subVectors(_h, _tc);
      const ld = Math.max(1e-3, _dd.length());
      _dd.divideScalar(ld);
      this.tw[i3] = _tc.x; this.tw[i3 + 1] = _tc.y; this.tw[i3 + 2] = _tc.z;
      this.drawLen[i] = ld;
      this.drawRad[i] = rd;

      // ONE instance per jet: nose tip at the origin, drawn axis along +Z, no scale.
      _q.setFromUnitVectors(_z, _dd);
      _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]); // exact ball colour
      this.mesh.setMatrixAt(drawn, _m.compose(_h, _q, _one));
      this.mesh.setColorAt(drawn, _col);
      const strain = Math.min(1, Math.abs(len - this.rest[i]) / Math.max(1e-3, K.maxLength - this.rest[i]));
      const k4 = drawn * 4;
      jet[k4] = this.seed[i]; jet[k4 + 1] = this.age[i]; jet[k4 + 2] = strain; jet[k4 + 3] = rd;
      shp[drawn * 2] = ld; shp[drawn * 2 + 1] = this.taper[i];
      this.instJet[drawn] = i;
      drawn++;
    }
    commit(this.mesh, drawn);
    publish(this.jetAttr, drawn, 4);
    publish(this.shapeAttr, drawn, 2);
  }

  /**
   * FPS READABILITY. Returns the drawn nose radius and moves `tail` (the
   * physical tail, WORLD) to the drawn tail. Far away the radius never drops
   * under minAngularRadius on screen. Seen almost along its flight (the
   * shooter's own view: it leaves the gun toward the crosshair), the jet would
   * collapse to a dot: the drawn axis is then turned around the NOSE, only in
   * the plane (viewer, nose, flight), keeping the tail at the depth of the
   * physical tail, until the jet is minScreenAspect × longer than wide on
   * screen. That plane holds the viewer, so the jet stays exactly on the
   * screen line muzzle → impact, and the tail never goes past the muzzle.
   * Seen from the side nothing changes (the real geometry is already long).
   */
  private layout(head: THREE.Vector3, tail: THREE.Vector3, start: THREE.Vector3, len: number, r: number, draining = false): number {
    if (!this.hasViewer) return r;
    _vc.subVectors(head, this.viewer);
    const D = _vc.length();
    if (D < 1e-4) return r;
    _vc.divideScalar(D);
    const rd = Math.max(r, D * this.minAngle);
    // Sinking into the impact: drawn as it really is (short + fat), never re-stretched.
    if (draining) return rd;
    const rScreen = Math.min(rd, D * K.maxAngularRadius); // the shader clamp, at the nose
    // Plane basis: v (viewer → nose), p (⊥ v, toward the tail side).
    _dd.subVectors(tail, head);
    const along = _dd.dot(_vc);
    _pp.copy(_dd).addScaledVector(_vc, -along);
    let side = _pp.length();
    if (side < 1e-6) {
      // Exactly along the view: turn toward the muzzle side, else toward the ground.
      _pp.subVectors(start, head);
      _pp.addScaledVector(_vc, -_pp.dot(_vc));
      if (_pp.lengthSq() < 1e-12) _pp.set(0, -1, 0).addScaledVector(_vc, _vc.y);
      if (_pp.lengthSq() < 1e-12) _pp.set(1, 0, 0).addScaledVector(_vc, -_vc.x);
      side = 0;
    }
    _pp.normalize();
    const xt = Math.max(0.1 * D, D + along); // physical tail depth
    const bTail = Math.atan2(side, xt);
    _w1.subVectors(start, head);
    const bMuzzle = Math.atan2(_w1.dot(_pp), D + _w1.dot(_vc));
    const bNeed = Math.atan((K.minScreenAspect * 2 * rScreen) / D);
    const b = Math.max(bTail, Math.min(bNeed, bMuzzle));
    const cap = Math.max(len, K.maxDrawLength);
    if (b > bTail + 1e-6) {
      tail.copy(this.viewer).addScaledVector(_vc, xt).addScaledVector(_pp, xt * Math.tan(b));
      _w1.subVectors(tail, head);
      const ld = _w1.length();
      if (ld > cap) tail.copy(head).addScaledVector(_w1, cap / ld);
    } else if (rd > r) {
      // Seen from the side but thickened far away: lengthen as much (same proportions).
      _w1.subVectors(tail, head);
      const ld = _w1.length();
      const want = Math.min(cap, len * (rd / r), head.distanceTo(start)); // never behind the muzzle
      if (ld > 1e-6 && want > ld) tail.copy(head).addScaledVector(_w1, want / ld);
    }
    return rd;
  }

  /**
   * Drawn state of instance `k` of `mesh` (tests / tools — allocates).
   * start / dir: the jet's ray; head / len (m along it): the physical body;
   * radius: physical nose radius; drawRadius / drawLength / headWorld /
   * tailWorld: what is actually drawn (FPS readability applied).
   */
  sampleInstance(k: number): {
    start: THREE.Vector3; dir: THREE.Vector3; head: number; len: number; radius: number;
    drawRadius: number; drawLength: number; headWorld: THREE.Vector3; tailWorld: THREE.Vector3;
    /** The nose hit: the body is sinking into the impact. */
    draining: boolean;
  } | null {
    if (k < 0 || k >= this.mesh.count) return null;
    const i = this.instJet[k];
    const i3 = i * 3;
    const start = new THREE.Vector3(this.a[i3], this.a[i3 + 1], this.a[i3 + 2]);
    const end = new THREE.Vector3(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
    const dir = end.sub(start);
    if (dir.lengthSq() > 1e-10) dir.normalize();
    else dir.set(0, 0, -1);
    const len = this.len[i];
    return {
      start, dir, head: this.head[i], len, radius: this.radius * this.radiusScale(i, len),
      drawRadius: this.drawRad[i], drawLength: this.drawLen[i],
      headWorld: start.clone().addScaledVector(dir, this.head[i]),
      tailWorld: new THREE.Vector3(this.tw[i3], this.tw[i3 + 1], this.tw[i3 + 2]),
      draining: this.drain[i] >= 0,
    };
  }

  /** Radius scale of jet `i` at body length `len`: volume conserved in flight, squashed (fatter) while draining. */
  private radiusScale(i: number, len: number): number {
    const v = Math.sqrt(K.refLength / Math.max(len, 0.05));
    if (this.drain[i] >= 0) return Math.min(DRAIN_BULGE, Math.max(K.minRadiusScale, v));
    return Math.min(K.maxRadiusScale, Math.max(K.minRadiusScale, v));
  }

  /**
   * Advance one jet by `dt` in fixed sub-steps (frame-rate independent).
   * Returns false when the jet is finished. Uses the module scratch _a
   * (start) and _d (direction) set by updateJets.
   */
  private step(i: number, dt: number, L: number): boolean {
    // Accumulator: every advance() is EXACTLY springStep long (the leftover is
    // carried to the next frame), so 20 fps and 240 fps integrate identically.
    let acc = this.acc[i] + dt;
    while (acc >= K.springStep - 1e-9) {
      acc -= K.springStep;
      // Real time elapsed in this frame AFTER the sub-step that may hit: an
      // impact created now must only age by that much (not by the whole frame).
      this.sinceHit = Math.max(0, acc);
      if (!this.advance(i, K.springStep, L)) return false;
    }
    this.acc[i] = Math.max(0, acc);
    return true;
  }

  /**
   * One fixed sub-step of a jet. The head is analytic on the ray (clamped at
   * the impact): a slow frame can never skip the collision. The body length
   * is a damped spring from its launch length down to its rest length:
   * stretched at birth, one soft contraction, no ringing.
   * Returns false when the jet is finished (it hit something and was replaced
   * by the impact effect, or it flew out of range into the sky).
   */
  private advance(i: number, h: number, L: number): boolean {
    const age = (this.age[i] += h);
    // DRAINING: the nose is stopped on the surface, the rest of the body keeps
    // coming and sinks into the impact blob (shorter + fatter each step).
    if (this.drain[i] >= 0) {
      const u = Math.min(1, (this.drain[i] += h) / K.impactDrain);
      this.head[i] = L;
      this.len[i] = this.len0[i] * (1 - u) * (1 - 0.35 * u); // the tail accelerates into the blob
      this.lenV[i] = 0;
      return u < 1;
    }
    const head = Math.min(L, this.h0[i] + this.vh[i] * age);
    this.head[i] = head;

    // In-flight elasticity: the rest length BREATHES slightly (per-jet rate +
    // phase, faded in after the launch relaxation): the body keeps stretching
    // and thinning a little, the silhouette stays long (clamped below).
    const breathe = K.breathe * smooth(0, 0.06, age) * Math.sin(this.bw[i] * age + this.bph[i]);
    const w = this.omega[i];
    let len = this.len[i];
    let lv = this.lenV[i];
    lv += (-w * w * (len - this.rest[i] * (1 + breathe)) - 2 * K.damping * w * lv) * h;
    len += lv * h;
    const lo = Math.min(K.minLength, head);
    const hi = Math.min(K.maxLength, head);
    if (len < lo) { len = lo; lv = Math.max(lv, 0); }
    if (len > hi) { len = hi; lv = Math.min(lv, 0); }
    this.len[i] = len;
    this.lenV[i] = lv;

    // The real collision moment: the impact starts NOW (paint squashes, splash,
    // character paint); the body then drains into it over impactDrain.
    if (head >= L) {
      if (!this.hits[i]) return false; // miss (sky): simply gone
      this.arrive(i);
      this.drain[i] = 0;
      this.len0[i] = len;
      return true;
    }
    // A few droplets torn off while the body is still strained.
    const strain = Math.min(1, Math.max(0, (len - this.rest[i]) / (K.maxLength - this.rest[i])));
    if (strain > K.shedMinStretch) {
      this.shed[i] += h * K.shedRate * strain;
      while (this.shed[i] >= 1) {
        this.shed[i] -= 1;
        const i3 = i * 3;
        _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
        this.emitShed(head - len, this.vh[i] - lv);
      }
    }
    return true;
  }

  /**
   * The nose reached the impact (the real collision moment). SQUASH →
   * SPREAD → TRACE: the body drains into the surface (advance), a paint
   * pancake slams flat there and spreads past its size before settling
   * (smeared forward on a slanted hit), a few droplets fly sideways, and the
   * persistent splat appears under it as a small puddle that SPREADS out to
   * its seeded shape while the pancake sinks into it (updateImpacts). Same
   * colour, same seeded shape / size / rotation on every client. Paint on a
   * character lands right now.
   */
  private arrive(i: number): void {
    const hit = this.hits[i];
    if (!hit) return; // miss (sky): nothing to splash
    const i3 = i * 3;
    _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]); // exact ball colour
    _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
    _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);

    const k = this.iNext;
    this.iNext = (this.iNext + 1) % MAX_IMPACTS;
    if (this.ialive[k]) {
      // ring overflow: hand over early (splat fully spread)
      this.commitImpact(k);
      this.settleSplat(k);
    } else this.iLive++;
    // Slanted hit: the travel direction projected on the surface → forward smear.
    _w1.set(this.b[i3] - this.a[i3], this.b[i3 + 1] - this.a[i3 + 1], this.b[i3 + 2] - this.a[i3 + 2]);
    if (_w1.lengthSq() > 1e-12) _w1.normalize();
    const cosI = Math.min(1, Math.abs(_w1.dot(_n)));
    _w1.addScaledVector(_n, -_w1.dot(_n));
    const tl = _w1.length();
    if (tl > 1e-4) _w1.divideScalar(tl);
    else _w1.set(0, 0, 0);
    this.itan[k * 3] = _w1.x; this.itan[k * 3 + 1] = _w1.y; this.itan[k * 3 + 2] = _w1.z;
    this.ismear[k] = tl > 1e-4 ? K.impactSmear * Math.sqrt(Math.max(0, 1 - cosI * cosI)) : 0;
    this.isplat[k] = -1;
    const onBody = !!(hit.mesh && hit.faceIndex !== undefined && hit.bary);
    const sd = hit.seed !== undefined ? hit.seed >>> 0 : (this.seed[i] * 4294967295) >>> 0;
    const r = rng(sd); // SAME sequence as PaintSplats.splatSurface: rotation, then aspect x / y
    this.irot[k] = r() * Math.PI * 2;
    this.iasp[k * 2] = 0.8 + r() * 0.45;
    this.iasp[k * 2 + 1] = 0.8 + r() * 0.45;
    const base = this.splats ? this.splats.surfaceBase : 0.96;
    const size = base * (1 + (hash01(sd, 31) - 0.5) * K.splatSizeVariation);
    this.isize[k] = onBody ? 0 : size;
    // The splat blob is ~0.26 × its quad size wide; the pancake spreads to ~that.
    this.itarget[k] = onBody ? K.paintRadius * 0.7 : 0.26 * size * K.impactFill;
    this.iseed[k] = sd;
    const k3 = k * 3;
    this.ip[k3] = _p.x; this.ip[k3 + 1] = _p.y; this.ip[k3 + 2] = _p.z;
    this.inr[k3] = _n.x; this.inr[k3 + 1] = _n.y; this.inr[k3 + 2] = _n.z;
    this.ic[k3] = _col.r; this.ic[k3 + 1] = _col.g; this.ic[k3 + 2] = _col.b;
    // updateImpacts() adds the whole frame step right after: start negative so
    // the pancake is exactly `sinceHit` old at the end of this frame.
    this.iage[k] = this.sinceHit - this.frameDt;
    this.ihit[k] = hit;
    this.icommit[k] = 0;
    this.ialive[k] = 1;
    // Paint on a CHARACTER lands at the exact collision moment (a death can
    // clear it right after — it must never be applied late). Only the splat on
    // the level waits for the end of the pancake so it does not cover it.
    if (onBody) this.commitImpact(k);
    this.splash(_p, _n, _col);
  }

  /**
   * Leave the paint: on a character right away (full), on the level as a
   * persistent splat that starts as a small puddle (spread = `spread`) and is
   * spread out by updateImpacts.
   */
  private commitImpact(k: number, spread = 1): void {
    if (this.icommit[k]) return;
    this.icommit[k] = 1;
    const hit = this.ihit[k];
    this.ihit[k] = null;
    if (!hit || !this.splats) return;
    const k3 = k * 3;
    const col = _c2.setRGB(this.ic[k3], this.ic[k3 + 1], this.ic[k3 + 2]);
    if (hit.mesh && hit.faceIndex !== undefined && hit.bary) {
      this.splats.paintHit(hit.mesh, hit.faceIndex, hit.bary, col, K.paintRadius);
    } else {
      _p2.set(this.ip[k3], this.ip[k3 + 1], this.ip[k3 + 2]);
      _n2.set(this.inr[k3], this.inr[k3 + 1], this.inr[k3 + 2]);
      const s = this.splats.splatSurface(_p2, _n2, col, this.isize[k], this.iseed[k], spread);
      this.isplat[k] = spread < 1 ? s : -1;
    }
  }

  /** The splat of impact `k` reaches its final shape (impact over / evicted / cleared). */
  private settleSplat(k: number): void {
    const s = this.isplat[k];
    if (s >= 0 && this.splats) this.splats.setSpread(s, 1);
    this.isplat[k] = -1;
  }

  /** Droplets out of the barrel: forward cone, small, short-lived. dir = unit shot direction. */
  private emitMuzzle(from: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, n: number): void {
    if (Math.abs(dir.y) < 0.9) _w2.set(0, 1, 0).cross(dir).normalize();
    else _w2.set(1, 0, 0).cross(dir).normalize();
    _w3.crossVectors(dir, _w2);
    for (let k = 0; k < K.muzzleDrops; k++) {
      const hs = n * 31 + k;
      const phi = hash01(hs, 21) * Math.PI * 2;
      const side = 0.8 + 2.4 * hash01(hs, 22);
      const fwd = 4 + 9 * hash01(hs, 23);
      _w4.copy(dir).multiplyScalar(fwd)
        .addScaledVector(_w2, Math.cos(phi) * side)
        .addScaledVector(_w3, Math.sin(phi) * side);
      _sp.copy(from).addScaledVector(dir, 0.05);
      this.addDrop(_sp, _w4, color, K.dropRadius + K.dropRadiusJitter * hash01(hs, 24), 0.1 + 0.1 * hash01(hs, 25), 4);
    }
  }

  /** One droplet torn off the strained tail (colour in _col, jet start _a, direction _d). */
  private emitShed(tailPos: number, tailSpeed: number): void {
    const h = (this.dSpawned = (this.dSpawned + 1) >>> 0);
    if (Math.abs(_d.y) < 0.9) _w2.set(0, 1, 0).cross(_d).normalize();
    else _w2.set(1, 0, 0).cross(_d).normalize();
    _w3.crossVectors(_d, _w2);
    const phi = hash01(h, 6) * Math.PI * 2;
    const side = 0.5 + 1.6 * hash01(h, 7);
    _w4.copy(_d).multiplyScalar(Math.max(0, tailSpeed) * (0.12 + 0.18 * hash01(h, 8)))
      .addScaledVector(_w2, Math.cos(phi) * side)
      .addScaledVector(_w3, Math.sin(phi) * side);
    _w1.copy(_a).addScaledVector(_d, tailPos);
    this.addDrop(_w1, _w4, _col, K.dropRadius + K.dropRadiusJitter * hash01(h, 9), 0.1 + 0.12 * hash01(h, 10), 4);
  }

  private updateDrops(dt: number): void {
    let drawn = 0;
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
      const drag = Math.exp(-this.ddrag[i] * dt);
      this.dv[i3 + 1] -= K.gravity * dt;
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
      if (this.hasViewer) r = Math.max(r, _p.distanceTo(this.viewer) * K.dropMinAngle);
      r *= Math.min(1, age * 40) * (1 - smooth(0.55, 1, age / life));
      this.drops.setMatrixAt(drawn, _m.compose(_p, _q, _s.set(r, r, r * (1 + Math.min(1.8, sp * 0.1)))));
      this.drops.setColorAt(drawn, _col.setRGB(this.dc[i3], this.dc[i3 + 1], this.dc[i3 + 2]));
      drawn++;
    }
    if (this.iLive > 0) drawn = this.updateImpacts(dt, drawn);
    commit(this.drops, drawn);
  }

  /**
   * Impact pancakes — SQUASH → SPREAD → TRACE:
   *   - squash: a dome of paint taller than wide (the jet's end, its body
   *     draining into it) SLAMS flat — radius easeOutBack: fast start, spreads
   *     ~10 % past its size then recoils; thickness ∝ 1/r² (volume kept);
   *   - smear: on a slanted hit it is stretched + pushed along the travel
   *     direction on the surface (the paint keeps sliding forward);
   *   - trace: impactSplatAt after the hit the persistent splat appears UNDER
   *     it as a small round puddle and spreads out (core → fingers → satellite
   *     drops) until the end, while the pancake thins and sinks into it.
   * Appended to the droplet instances (same sphere geometry + material).
   * Returns the new draw count.
   */
  private updateImpacts(dt: number, drawn: number): number {
    for (let k = 0; k < MAX_IMPACTS; k++) {
      if (!this.ialive[k]) continue;
      const age = Math.max(0, (this.iage[k] += dt));
      const life = K.impactLife;
      // The trace: the splat starts as a puddle under the pancake, then spreads out.
      if (!this.icommit[k] && age >= K.impactSplatAt) this.commitImpact(k, 0);
      if (this.isplat[k] >= 0 && this.splats) {
        const g = Math.min(1, Math.max(0, (age - K.impactSplatAt) / K.impactGrow));
        this.splats.setSpread(this.isplat[k], 1 - (1 - g) * (1 - g) * (1 - g)); // fast, then settles
      }
      if (age >= life) {
        this.commitImpact(k);
        this.settleSplat(k);
        this.ialive[k] = 0;
        this.iLive--;
        continue;
      }
      const k3 = k * 3;
      // Squash: easeOutBack radius (it SLAMS, overshoots, recoils), volume kept.
      const u = Math.min(1, age / K.impactSpread);
      const c = K.impactOvershoot;
      const e = 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2;
      const r0 = K.impactStartRadius;
      const r = Math.max(r0 * 0.5, r0 + (this.itarget[k] - r0) * e);
      const flat = Math.max(0.008, K.impactStartHeight * (r0 * r0) / (r * r));
      const h = flat * (1 - smooth(0.45, 1, age / life)); // thins and sinks into the trace
      _n2.set(this.inr[k3], this.inr[k3 + 1], this.inr[k3 + 2]);
      _qi.setFromUnitVectors(_z, _n2);
      _qr.setFromAxisAngle(_z, this.irot[k]);
      _qi.multiply(_qr);
      _m.compose(_zero, _qi, _s.set(r * this.iasp[k * 2], r * this.iasp[k * 2 + 1], h));
      // Smear (slanted hit): stretch along the surface travel direction t (S = I + s·t·tᵀ) + push forward.
      const sm = this.ismear[k] * Math.min(1, e);
      _p2.set(this.ip[k3], this.ip[k3 + 1], this.ip[k3 + 2]).addScaledVector(_n2, 0.002);
      if (sm > 1e-4) {
        const tx = this.itan[k3], ty = this.itan[k3 + 1], tz = this.itan[k3 + 2];
        _ms.set(
          1 + sm * tx * tx, sm * tx * ty, sm * tx * tz, 0,
          sm * ty * tx, 1 + sm * ty * ty, sm * ty * tz, 0,
          sm * tz * tx, sm * tz * ty, 1 + sm * tz * tz, 0,
          0, 0, 0, 1,
        );
        _m.premultiply(_ms);
        _p2.x += tx * sm * r * 0.5; _p2.y += ty * sm * r * 0.5; _p2.z += tz * sm * r * 0.5;
      }
      _m.setPosition(_p2);
      this.drops.setMatrixAt(drawn, _m);
      this.drops.setColorAt(drawn, _col.setRGB(this.ic[k3], this.ic[k3 + 1], this.ic[k3 + 2]));
      drawn++;
    }
    return drawn;
  }

  /** Impact `k`: persistent splat index being spread (-1 = none) — tests / tools. */
  impactSplat(k: number): number {
    return k >= 0 && k < MAX_IMPACTS ? this.isplat[k] : -1;
  }

  private addDrop(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, radius: number, life: number, drag: number): void {
    this.dEmitted++;
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
    this.ddrag[i] = drag;
  }

  private free(i: number): void {
    this.alive[i] = 0;
    this.hits[i] = null;
    this.anchors[i] = null;
    this.live--;
  }
}

// ---------------------------------------------------------------------------

/**
 * The ONE jet geometry shared by every jet (shaped per jet in the vertex
 * shader). Rings of RADIAL vertices: position.xy = unit ring direction,
 * position.z = profile parameter t. Body rings t = 0 → 1 (pointed tail →
 * nose base) are packed toward the tail (u = 1 - (1 - j/n)^1.6) where the
 * radius changes fastest; nose rings t = 1 → 2 are spread by angle over the
 * rounded cap. The cap closes on the tip (t = 2, radius 0); the tail ends in
 * a point (radius 0 at t = 0). Closed surface, no seams.
 */
function buildJetGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const ts: number[] = [];
  for (let j = 0; j <= BODY_RINGS; j++) ts.push(1 - Math.pow(1 - j / BODY_RINGS, 1.6));
  for (let j = 1; j <= NOSE_RINGS; j++) ts.push(1 + j / NOSE_RINGS);
  for (const t of ts) {
    for (let i = 0; i < RADIAL; i++) {
      const th = (i / RADIAL) * Math.PI * 2;
      pos.push(Math.cos(th), Math.sin(th), t);
      nor.push(Math.cos(th), Math.sin(th), 0); // rebuilt analytically in the shader
    }
  }
  for (let j = 0; j < ts.length - 1; j++) {
    for (let i = 0; i < RADIAL; i++) {
      const a = j * RADIAL + i;
      const b = j * RADIAL + ((i + 1) % RADIAL);
      const c = (j + 1) * RADIAL + ((i + 1) % RADIAL);
      const d = (j + 1) * RADIAL + i;
      idx.push(a, b, d, b, c, d); // CCW seen from outside (+z = toward the nose)
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.name = "PaintJetGeometry";
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
