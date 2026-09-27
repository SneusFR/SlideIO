import * as THREE from "three";
import type { PaintSplats } from "./PaintSplats";
import type { PaintHit } from "./PaintballProjectiles";

/**
 * Live muzzle of the shooter (WORLD). Returns false once the weapon is gone
 * (switch, death, hidden avatar): the ball then keeps its last start point.
 */
export type PaintballAnchor = (out: THREE.Vector3) => boolean;

export interface PaintballBallsOptions {
  /** Balls in flight at once, all players together (ring buffer). Default 256. */
  max?: number;
  /** Flight speed (m/s). Tracer speed: the impact reads as instant, the ball is still seen. Default 400. */
  speed?: number;
  /** Ball radius (m). Default 0.09 (18 cm — a big, readable cartoon paintball). */
  radius?: number;
  /**
   * Minimum ON-SCREEN size (radians of radius seen from the viewer): a far
   * ball is scaled up so it never shrinks to a dot (at 400 m/s it is 20 m
   * away after 3 frames). Default 0.007 (≈ 0.4° — the ball's size at ~13 m).
   */
  minAngularRadius?: number;
  /**
   * Ease-in (1 = constant speed). Default 2 — SAME arrival time, but the
   * first frames stay close to the gun: at 20 m the ball is drawn at the
   * muzzle, then ~1.2 m, ~5 m, ~11 m, then the impact — its exit is SEEN.
   */
  easeIn?: number;
  /**
   * Built-in key light of the ball (0 = scene lighting only). Default 0.5:
   * the same shading direction as the in-hand viewmodel light, so a flying
   * ball keeps the facets / highlight of the hopper balls and still reads on
   * a dark (night) map — no flat self-glow.
   */
  glow?: number;
  /** Trail length behind the ball (m, 0 = no trail). Default 0.3 — a discreet direction cue. */
  trailLength?: number;
  /** Additive halo around the ball (× radius, 0 = none). Default 0 — a paintball, not an energy orb. */
  halo?: number;
  /** Tumble speed of the ball in flight (rad/s). Default 22. */
  spin?: number;
}

/**
 * Flight time bounds (s): ≥ 4 frames (the ball is always seen leaving the
 * barrel: muzzle → ~1 m out → mid → impact), ≤ 6 frames (45 m).
 */
const MIN_FLIGHT = 4 / 60;
const MAX_FLIGHT = 0.1;
/** Updates during which the line start follows the live muzzle (then: the fired ray). */
const ANCHOR_FRAMES = 2;
/** Max on-screen radius (rad) near the camera: a big ball at the muzzle never fills the view. */
const MAX_ANGULAR_RADIUS = 0.045;
/** The ball starts this many radii AHEAD of the muzzle: fully out of the drawn barrel. */
const MUZZLE_CLEARANCE = 1.15;
const SQUASH = 0.07; // s — flattening on the target
const MISS_FADE = 0.06; // s — end of range: shrink away
/** Trail radius at the ball, as a share of the ball radius. */
const TRAIL_WIDTH = 0.45;
const TRAIL_OPACITY = 0.4;
/** The trail is the ball colour lifted this much toward white (reads as motion, not as a second object). */
const TRAIL_LIGHTEN = 0.25;
const HALO_OPACITY = 0.2;
/**
 * The hopper ball material (GLB `PaintballRifle_Ball`): glossy, non-metal.
 * The flying ball uses the SAME values + the EXACT hopper palette colour.
 */
const BALL_ROUGHNESS = 0.32;
/**
 * Key-light direction of the built-in shading, in VIEW space: the
 * ViewmodelSystem key light (position 0.6 / 1.0 / 0.4, target 0 / 0 / -1).
 */
const KEY_DIR_VIEW = new THREE.Vector3(0.6, 1.0, 1.4).normalize();
const St = { Free: 0, Flight: 1, Squash: 2, Miss: 3 } as const;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();
const _ball = new THREE.Color();
const _trailCol = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _qId = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * PAINTBALLS IN FLIGHT (SlideIO) — the REAL balls everybody sees, for a
 * HITSCAN weapon: the damage already happened (instant raycast); this is the
 * ball travelling along that exact ray, like a tracer round:
 *   - the SAME ball as in the hopper: Ball_Template geometry (faceted
 *     sphere), the hopper material values (glossy, roughness 0.32) and the
 *     EXACT palette colour, tumbling from a random orientation; a built-in
 *     key light (viewmodel light direction) keeps its facets / highlight
 *     readable on a dark map — no flat self-glow, no halo by default;
 *   - BIG (18 cm), never smaller on screen than ≈ 0.4° (a far ball is
 *     scaled up);
 *   - TRACER SPEED (400 m/s) with a bounded flight time: ≥ 4 frames (a
 *     point-blank ball is still seen leaving the barrel), ≤ 0.1 s (a 45 m
 *     shot lands in 6 frames) — the splat appears practically with the hit;
 *   - a short, faint tapered trail (0.3 m, lighter ball colour), never
 *     longer than the path already flown (never pokes into the gun / camera);
 *   - GLUED TO THE GUN, THEN STRAIGHT: on its first update the line start is
 *     the shooter's LIVE muzzle (strafing never leaves the ball behind the
 *     gun), then it flies the FIRED ray (a camera turn never bends it),
 *     always ending exactly on the hitscan impact;
 *   - on arrival it squashes and hands the paint to PaintSplats (seeded
 *     surface splat or per-vertex paint on the hit player).
 * InstancedMeshes shared by every shooter (balls, trails, + halos if
 * enabled): 2 draw calls by default, no per-frame allocation, zero work
 * when nothing flies.
 */
export class PaintballBalls {
  readonly mesh: THREE.InstancedMesh;
  /** Additive glow sphere around each flying ball (null when halo = 0). */
  readonly halo: THREE.InstancedMesh | null;
  /** Tapered trails behind the balls in flight (null when trailLength = 0). */
  readonly trail: THREE.InstancedMesh | null;
  readonly radius: number;
  readonly speed: number;
  /** Viewer position (camera) for the minimum on-screen size — set each frame. */
  readonly viewer = new THREE.Vector3();
  private hasViewer = false;
  private readonly minAngle: number;
  private readonly haloScale: number;
  private readonly max: number;
  private readonly ease: number;
  private readonly trailLength: number;
  private readonly spin: number;
  private readonly rot0: Float32Array; // random start orientation (quaternion xyzw)
  private readonly axis: Float32Array; // tumble axis (unit)
  private spawned = 0;
  private readonly a: Float32Array; // start (refreshed from the anchor)
  private readonly b: Float32Array; // impact
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly t: Float32Array;
  private readonly dur: Float32Array;
  private readonly st: Uint8Array;
  private readonly frames: Uint8Array;
  private readonly hits: (PaintHit | null)[];
  private readonly anchors: (PaintballAnchor | null)[];
  private next = 0;
  private live = 0;
  splats: PaintSplats | null;

  constructor(geometry: THREE.BufferGeometry, parent: THREE.Object3D, splats: PaintSplats | null, options: PaintballBallsOptions = {}) {
    const MAX = (this.max = options.max ?? 256);
    this.speed = options.speed ?? 400;
    this.radius = options.radius ?? 0.09;
    this.minAngle = options.minAngularRadius ?? 0.007;
    this.ease = options.easeIn ?? 2;
    this.trailLength = options.trailLength ?? 0.3;
    this.haloScale = options.halo ?? 0;
    this.spin = options.spin ?? 22;
    const glow = options.glow ?? 0.5;
    this.rot0 = new Float32Array(MAX * 4);
    this.axis = new Float32Array(MAX * 3);
    this.a = new Float32Array(MAX * 3);
    this.b = new Float32Array(MAX * 3);
    this.nrm = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.t = new Float32Array(MAX);
    this.dur = new Float32Array(MAX);
    this.st = new Uint8Array(MAX);
    this.frames = new Uint8Array(MAX);
    this.hits = new Array(MAX).fill(null);
    this.anchors = new Array(MAX).fill(null);

    // The hopper ball material (same roughness / metalness, exact instance
    // colour), lit by the scene + a built-in KEY LIGHT in view space (the
    // viewmodel key-light direction): ambient share + lambert on the flat
    // facet normal — the facets and the lit side read like in the hopper,
    // even on a dark night map (the instance colour is already in
    // diffuseColor and `normal` is the view-space facet normal here).
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: BALL_ROUGHNESS, metalness: 0 });
    const g = glow.toFixed(3);
    const k = KEY_DIR_VIEW;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n" +
          `totalEmissiveRadiance += diffuseColor.rgb * ${g} * ` +
          `(0.45 + 0.55 * max(dot(normal, vec3(${k.x.toFixed(4)}, ${k.y.toFixed(4)}, ${k.z.toFixed(4)})), 0.0));`,
      );
    };
    material.customProgramCacheKey = () => `paintball-ball-key-${g}`;
    this.mesh = makeInstanced(geometry, material, MAX, "PaintballBalls");
    parent.add(this.mesh);

    // Halo: the same sphere, bigger, additive + fresnel-soft edge (unlit).
    if (this.haloScale > 0) {
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: HALO_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      haloMat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vRim;")
          .replace(
            "#include <project_vertex>",
            "#include <project_vertex>\nvec3 vn = normalize(normalMatrix * mat3(instanceMatrix) * objectNormal);\nvRim = abs(dot(vn, normalize(-mvPosition.xyz)));",
          );
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vRim;")
          .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vRim * vRim;");
      };
      haloMat.customProgramCacheKey = () => "paintball-halo-v1";
      this.halo = makeInstanced(geometry, haloMat, MAX, "PaintballHalos");
      this.halo.renderOrder = 2;
      parent.add(this.halo);
    } else {
      this.halo = null;
    }


    // Trail: a tapered cone (tip behind, base at the ball) along +Z, unit
    // length — scaled per instance; unlit flashy colour fading to the tail.
    if (this.trailLength > 0) {
      const cone = new THREE.ConeGeometry(1, 1, 8, 1, true);
      cone.rotateX(-Math.PI / 2); // apex toward -Z (behind), base toward +Z
      cone.translate(0, 0, -0.5); // base at z = 0 (the ball), tip at z = -1
      const pos = cone.getAttribute("position");
      const fade = new Float32Array(pos.count);
      for (let k = 0; k < pos.count; k++) fade[k] = 1 + pos.getZ(k); // 1 at the ball, 0 at the tip
      cone.setAttribute("aFade", new THREE.BufferAttribute(fade, 1));
      const trailMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: TRAIL_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      trailMat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float aFade;\nvarying float vFade;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFade = aFade;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vFade;")
          .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vFade * vFade;");
      };
      trailMat.customProgramCacheKey = () => "paintball-trail-v1";
      this.trail = makeInstanced(cone, trailMat, MAX, "PaintballTrails");
      this.trail.renderOrder = 1;
      parent.add(this.trail);
    } else {
      this.trail = null;
    }
    this.splats = splats;
  }

  /** Balls currently alive (flying / squashing). */
  get activeCount(): number {
    return this.live;
  }

  /** Viewer (camera) world position — keeps far balls at a readable size. Call before update(). */
  setViewer(position: THREE.Vector3): void {
    this.viewer.copy(position);
    this.hasViewer = true;
  }

  /** Flight time of a ball over `distance` (tracer speed, bounded). */
  flightTime(distance: number): number {
    return Math.min(MAX_FLIGHT, Math.max(MIN_FLIGHT, distance / this.speed));
  }

  /**
   * Displayed radius of a ball at `position`: the real size, never smaller
   * than the minimum on-screen size far away, never larger than
   * MAX_ANGULAR_RADIUS right in front of the camera (at the FP muzzle).
   */
  displayRadius(position: THREE.Vector3): number {
    if (!this.hasViewer) return this.radius;
    const d = position.distanceTo(this.viewer);
    return Math.min(Math.max(this.radius, d * this.minAngle), d * MAX_ANGULAR_RADIUS);
  }

  /**
   * from: muzzle (WORLD) at the shot. to: the hitscan impact (or the max-range
   * point). color: the ball's paint. hit: what to paint on arrival (null =
   * miss). anchor: the shooter's live muzzle (keeps the ball on the gun line
   * while the shooter moves) — null = fixed start.
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, hit: PaintHit | null, anchor: PaintballAnchor | null = null): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.st[i] === St.Free) this.live++;
    const i3 = i * 3;
    this.a[i3] = from.x; this.a[i3 + 1] = from.y; this.a[i3 + 2] = from.z;
    this.b[i3] = to.x; this.b[i3 + 1] = to.y; this.b[i3 + 2] = to.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    const nn = hit?.normal;
    if (nn) _n.copy(nn);
    else _n.subVectors(from, to).normalize();
    this.nrm[i3] = _n.x; this.nrm[i3 + 1] = _n.y; this.nrm[i3 + 2] = _n.z;
    this.hits[i] = hit;
    this.anchors[i] = anchor;
    this.dur[i] = this.flightTime(from.distanceTo(to));
    // Random (hashed) start orientation + tumble axis: every ball shows its
    // facets differently, like the loose balls rolling in the hopper.
    const h = (this.spawned = (this.spawned + 1) >>> 0);
    // Uniform random rotation (Shoemake) from 3 hashed numbers.
    const u1 = hash01(h, 1), u2 = hash01(h, 2) * Math.PI * 2, u3 = hash01(h, 3) * Math.PI * 2;
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    _q.set(s1 * Math.sin(u2), s1 * Math.cos(u2), s2 * Math.sin(u3), s2 * Math.cos(u3));
    const i4 = i * 4;
    this.rot0[i4] = _q.x; this.rot0[i4 + 1] = _q.y; this.rot0[i4 + 2] = _q.z; this.rot0[i4 + 3] = _q.w;
    _axis.set(hash01(h, 5) - 0.5, hash01(h, 6) - 0.5, hash01(h, 7) - 0.5);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    this.axis[i3] = _axis.x; this.axis[i3 + 1] = _axis.y; this.axis[i3 + 2] = _axis.z;
    this.t[i] = 0;
    this.frames[i] = 0;
    this.st[i] = St.Flight;
  }


  /** Once per frame, AFTER the camera / weapons moved (anchors read final poses). */
  update(dt: number): void {
    const trail = this.trail;
    const halo = this.halo;
    if (this.live === 0) {
      for (const m of [this.mesh, halo, trail]) {
        if (m && m.count !== 0) {
          m.count = 0;
          m.instanceMatrix.needsUpdate = true;
        }
      }
      return;
    }
    let drawn = 0;
    let halos = 0;
    let trails = 0;
    for (let i = 0; i < this.max; i++) {
      const state = this.st[i];
      if (state === St.Free) continue;
      const i3 = i * 3;
      // The spawn frame is drawn at t = 0 (AT the muzzle): the shot happens
      // earlier in the same frame, advancing it now would first show the
      // ball already metres away from the gun.
      const fresh = state === St.Flight && this.frames[i] === 0;
      const t = fresh ? this.t[i] : (this.t[i] += dt);
      // EXACT hopper colour (same as the balls in the hopper / the splats).
      _ball.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
      let flying = false;
      let R = this.radius;
      if (state === St.Flight) {
        flying = true;
        // First update: the line starts at the LIVE muzzle — the ball never
        // lags behind a moving shooter. Then it flies the fired ray.
        const anchor = this.anchors[i];
        if (anchor) {
          if (this.frames[i] < ANCHOR_FRAMES && anchor(_a)) {
            this.a[i3] = _a.x; this.a[i3 + 1] = _a.y; this.a[i3 + 2] = _a.z;
          }
          if (this.frames[i] + 1 >= ANCHOR_FRAMES) this.anchors[i] = null;
        }
        if (this.frames[i] < 255) this.frames[i]++;
        const u0 = Math.min(1, t / this.dur[i]);
        const u = Math.pow(u0, this.ease);
        _a.set(this.a[i3], this.a[i3 + 1], this.a[i3 + 2]);
        _d.set(this.b[i3] - _a.x, this.b[i3 + 1] - _a.y, this.b[i3 + 2] - _a.z);
        const len = _d.length();
        // Size from the muzzle distance, then the start is pushed ONE ball
        // ahead of the muzzle (fully out of the drawn barrel, which is
        // rendered over the world in FP) — the path still ends on the impact.
        R = this.displayRadius(_a);
        const clear = Math.min(R * MUZZLE_CLEARANCE, len * 0.5);
        if (len > 1e-4) _p.copy(_a).addScaledVector(_d, (clear + (len - clear) * u) / len);
        else _p.copy(_a);
        // Big + never a dot: at least ≈ 0.4° on screen far away, capped near the camera.
        R = this.displayRadius(_p);
        // Trail: never longer than the path already flown (no poke into the gun).
        if (trail && len > 1e-4) {
          const tl = Math.min(this.trailLength * (R / this.radius), (len - clear) * u);
          if (tl > R * 0.5) {
            _d.divideScalar(len);
            _q.setFromUnitVectors(_z, _d);
            const w = R * TRAIL_WIDTH;
            trail.setMatrixAt(trails, _m.compose(_p, _q, _s.set(w, w, tl)));
            trail.setColorAt(trails, _trailCol.copy(_ball).lerp(_white, TRAIL_LIGHTEN));
            trails++;
          }
        }
        // Random start orientation, tumbling around its own axis.
        const i4 = i * 4;
        _q.set(this.rot0[i4], this.rot0[i4 + 1], this.rot0[i4 + 2], this.rot0[i4 + 3]);
        _axis.set(this.axis[i3], this.axis[i3 + 1], this.axis[i3 + 2]);
        _q.premultiply(_qSpin.setFromAxisAngle(_axis, this.spin * t));
        _s.setScalar(R);
        if (u0 >= 1) {
          this.t[i] = 0;
          this.anchors[i] = null;
          const hit = this.hits[i];
          if (hit) {
            this.st[i] = St.Squash;
            this.arrive(i, hit);
          } else {
            this.st[i] = St.Miss;
          }
        }
      } else if (state === St.Squash) {
        // Flattened against the surface, spreading, then gone (the splat takes over).
        const u = t / SQUASH;
        if (u >= 1) {
          this.free(i);
          continue;
        }
        _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
        _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]).addScaledVector(_n, R * 0.3);
        _q.setFromUnitVectors(_z, _n);
        _s.set(R * (1 + 1.4 * u), R * (1 + 1.4 * u), R * Math.max(0.05, 0.45 * (1 - u)));
      } else {
        const u = t / MISS_FADE;
        if (u >= 1) {
          this.free(i);
          continue;
        }
        _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
        R = this.displayRadius(_p) * (1 - u);
        _q.identity();
        _s.setScalar(R);
      }
      this.mesh.setMatrixAt(drawn, _m.compose(_p, _q, _s));
      this.mesh.setColorAt(drawn, _ball);
      drawn++;
      if (halo && flying) {
        const h = R * this.haloScale;
        halo.setMatrixAt(halos, _m.compose(_p, _qId, _s.set(h, h, h)));
        halo.setColorAt(halos, _ball);
        halos++;
      }
    }
    commit(this.mesh, drawn);
    if (halo) commit(halo, halos);
    if (trail) commit(trail, trails);
  }


  /** Drop every ball (session change). */
  clear(): void {
    this.st.fill(St.Free);
    this.hits.fill(null);
    this.anchors.fill(null);
    this.live = 0;
    for (const m of [this.mesh, this.halo, this.trail]) {
      if (!m) continue;
      m.count = 0;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  private arrive(i: number, hit: PaintHit): void {
    if (!this.splats) return;
    const i3 = i * 3;
    _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]); // exact hopper colour
    if (hit.mesh && hit.faceIndex !== undefined && hit.bary) {
      this.splats.paintHit(hit.mesh, hit.faceIndex, hit.bary, _col, PAINT_RADIUS);
    } else {
      _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
      _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
      this.splats.splatSurface(_p, _n, _col, undefined, hit.seed);
    }
  }

  private free(i: number): void {
    this.st[i] = St.Free;
    this.hits[i] = null;
    this.anchors[i] = null;
    this.live--;
  }

  dispose(): void {
    for (const m of [this.mesh, this.halo, this.trail]) {
      if (!m) continue;
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.trail?.geometry.dispose();
  }
}

/** Paint radius on a character (m): 3× the pack's 7.5 cm. */
const PAINT_RADIUS = 0.225;

/** Deterministic hash → [0, 1) (ball index × channel), no Math.random in the render loop. */
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

/** Publish `count` instances (matrix + colour) of a pool. */
function commit(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

