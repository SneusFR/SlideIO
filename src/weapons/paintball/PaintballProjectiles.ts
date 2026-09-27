import * as THREE from "three";
import type { PaintSplats } from "./PaintSplats";

/**
 * Paintballs in flight — PURELY VISUAL (damage comes from the gameplay raycast of the shot).
 * ONE InstancedMesh for everybody (local player + remote players), reusing the hopper ball geometry /
 * material (Ball_Template, per-instance colour): 1 draw call, no per-frame allocation, idle = no work.
 * The SHOT is hitscan (instant raycast + damage in the gameplay code); this is the ball everybody SEES: it leaves
 * the muzzle (FP viewmodel or TP weapon), flies to the raycast impact (3.2 cm, stretched along the flight, 45 m/s,
 * slight arc exact at both ends), squashes on the
 * target and hands the paint to PaintSplats when it ARRIVES (surface splat or paint on the hit player).
 */
const ARC = 2.2;               // m/s² — sag that is zero at both ends
const SQUASH = 0.06;           // s — flattening on impact
const MISS_FADE = 0.1;

export interface PaintballProjectilesOptions {
  /** Balls in flight at once, all players together (ring buffer). Default 256. */
  max?: number;
  /** Visual speed (m/s). The SHOT is hitscan: damage is instant, this is only the ball you see. Default 45
   *  (slow enough to watch every ball leave the muzzle and fly to the impact, in FP and TP). */
  speed?: number;
  /** Ball radius (m). Default 0.016 (3.2 cm: clearly visible leaving the muzzle, in FP and in TP). */
  radius?: number;
  /** Stretch along the flight (1 = round). Reads as a fast ball. Default 1.8. */
  stretch?: number;
  /**
   * Ease-in of the flight (1 = constant speed). Seen from the shooter, a ball at constant speed covers ~70 % of its
   * on-screen path in its first metre (1-2 frames): it seems to pop at the crosshair. With 1.8 it leaves the muzzle
   * slowly then accelerates (same arrival time), so you SEE every ball leave your gun. Default 1.8.
   */
  easeIn?: number;
}

const St = { Free: 0, Flight: 1, Squash: 2, Miss: 3 } as const;

export interface PaintHit {
  /** Level geometry: world point / normal. */
  normal?: THREE.Vector3 | null;
  /** Shot seed: the surface splat is identical on every client (shape, rotation, size). */
  seed?: number;
  /** A player: the skinned mesh hit + face + barycentric (see hitBarycentric) — painted on arrival. */
  mesh?: THREE.SkinnedMesh | THREE.Mesh | null;
  faceIndex?: number;
  bary?: THREE.Vector3;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();

export class PaintballProjectiles {
  readonly mesh: THREE.InstancedMesh;
  private readonly max: number;
  private readonly speed: number;
  private readonly size: number;
  private readonly stretch: number;
  private readonly ease: number;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly dir: Float32Array;
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly t: Float32Array;
  private readonly dur: Float32Array;
  private readonly st: Uint8Array;
  private readonly hits: (PaintHit | null)[];
  private next = 0;
  private live = 0;
  splats: PaintSplats | null;

  /** template = the weapon's Ball_Template mesh (controller.hopper.ballMesh works too): shared geometry / material. */
  constructor(template: THREE.Mesh, parent: THREE.Object3D, splats: PaintSplats | null = null, options: PaintballProjectilesOptions = {}) {
    const MAX = (this.max = options.max ?? 256);
    this.speed = options.speed ?? 45;
    this.size = options.radius ?? 0.016;
    this.stretch = options.stretch ?? 1.8;
    this.ease = options.easeIn ?? 1.8;
    this.a = new Float32Array(MAX * 3); this.b = new Float32Array(MAX * 3); this.dir = new Float32Array(MAX * 3);
    this.nrm = new Float32Array(MAX * 3); this.col = new Float32Array(MAX * 3);
    this.t = new Float32Array(MAX); this.dur = new Float32Array(MAX); this.st = new Uint8Array(MAX);
    this.hits = new Array(MAX).fill(null);
    this.mesh = new THREE.InstancedMesh(template.geometry, template.material, MAX);
    this.mesh.name = "PaintballProjectiles";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.raycast = () => {};
    this.mesh.count = 0;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    parent.add(this.mesh);
    this.splats = splats;
  }

  /**
   * from: muzzle (WORLD). to: impact point (or the max-range point when nothing was hit). color: the ball's paint.
   * hit: what to paint on arrival (null = missed, the ball just disappears at range).
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, hit: PaintHit | null): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.st[i] === St.Free) this.live++;
    const i3 = i * 3;
    this.a[i3] = from.x; this.a[i3 + 1] = from.y; this.a[i3 + 2] = from.z;
    this.b[i3] = to.x; this.b[i3 + 1] = to.y; this.b[i3 + 2] = to.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    const nn = hit?.normal;
    if (nn) { this.nrm[i3] = nn.x; this.nrm[i3 + 1] = nn.y; this.nrm[i3 + 2] = nn.z; }
    else { _d.subVectors(from, to).normalize(); this.nrm[i3] = _d.x; this.nrm[i3 + 1] = _d.y; this.nrm[i3 + 2] = _d.z; }
    _d.subVectors(to, from).normalize();
    this.dir[i3] = _d.x; this.dir[i3 + 1] = _d.y; this.dir[i3 + 2] = _d.z;
    this.hits[i] = hit;
    this.dur[i] = Math.max(0.015, from.distanceTo(to) / this.speed);
    this.t[i] = 0;
    this.st[i] = St.Flight;
  }

  /** Once per frame, after the spawns of the frame. */
  update(dt: number): void {
    if (this.live === 0) {
      if (this.mesh.count !== 0) { this.mesh.count = 0; this.mesh.instanceMatrix.needsUpdate = true; }
      return;
    }
    let drawn = 0;
    const SIZE = this.size;
    for (let i = 0; i < this.max; i++) {
      const state = this.st[i];
      if (state === St.Free) continue;
      const i3 = i * 3;
      const t = (this.t[i] += dt);
      if (state === St.Flight) {
        const T = this.dur[i];
        const u0 = Math.min(1, t / T), tc = Math.min(t, T);
        const u = Math.pow(u0, this.ease);                       // slow out of the muzzle, then faster
        _p.set(this.a[i3] + (this.b[i3] - this.a[i3]) * u,
          this.a[i3 + 1] + (this.b[i3 + 1] - this.a[i3 + 1]) * u - 0.5 * ARC * tc * (T - tc),
          this.a[i3 + 2] + (this.b[i3 + 2] - this.a[i3 + 2]) * u);
        _d.set(this.dir[i3], this.dir[i3 + 1], this.dir[i3 + 2]);
        _q.setFromUnitVectors(_z, _d);                              // stretched along the flight: reads as a fast ball
        const g = SIZE * Math.min(1, 0.45 + t * 25);
        _s.set(g, g, g * (1 + (this.stretch - 1) * Math.min(1, t * 20)));
        if (u >= 1) {
          this.t[i] = 0;
          const hit = this.hits[i];
          if (hit) { this.st[i] = St.Squash; this.arrive(i, hit); } else this.st[i] = St.Miss;
        }
      } else if (state === St.Squash) {
        // flattened against the surface, spreading, then gone (the splat takes over)
        const u = t / SQUASH;
        if (u >= 1) { this.free(i); continue; }
        _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
        _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]).addScaledVector(_n, SIZE * 0.3);
        _q.setFromUnitVectors(_z, _n);
        _s.set(SIZE * (1 + 1.6 * u), SIZE * (1 + 1.6 * u), SIZE * Math.max(0.05, 0.5 * (1 - u)));
      } else {
        const u = t / MISS_FADE;
        if (u >= 1) { this.free(i); continue; }
        _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
        _q.identity();
        _s.setScalar(SIZE * (1 - u));
      }
      this.mesh.setMatrixAt(drawn, _m.compose(_p, _q, _s));
      this.mesh.setColorAt(drawn, _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]));
      drawn++;
    }
    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private arrive(i: number, hit: PaintHit): void {
    if (!this.splats) return;
    const i3 = i * 3;
    _col.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
    if (hit.mesh && hit.faceIndex !== undefined && hit.bary) {
      this.splats.paintHit(hit.mesh, hit.faceIndex, hit.bary, _col);
    } else {
      _p.set(this.b[i3], this.b[i3 + 1], this.b[i3 + 2]);
      _n.set(this.nrm[i3], this.nrm[i3 + 1], this.nrm[i3 + 2]);
      this.splats.splatSurface(_p, _n, _col, undefined, hit.seed);
    }
  }

  private free(i: number): void {
    this.st[i] = St.Free;
    this.hits[i] = null;
    this.live--;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
