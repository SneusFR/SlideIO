/**
 * PAINTBALL HOPPER SOLVER — pure data, no three.js (unit-testable, zero allocation per frame).
 *
 * Position-based Verlet spheres living in the HOPPER node's local space (weapon units, the same space as the
 * GLB `Hopper.extras` layouts): a horizontal cylinder (axis X) with a shallow V floor that funnels the balls
 * toward the feed hole (like a real hopper agitator). Sphere/sphere contacts (sort-and-sweep on X, insertion
 * sort ≈ O(n)), wall friction, per-ball states (active → fed → hidden).
 *
 * COST: 32 balls, 8 relaxation iterations, fixed 60 Hz substeps (max 3 per frame): ~0.05 ms per step.
 * The solver SLEEPS when nothing moves and the effective acceleration is stable (no work, no GPU upload).
 */

export const BState = { Hidden: 0, Active: 1, Fed: 2 } as const;
export type BState = (typeof BState)[keyof typeof BState];

export interface PaintballHopperSimConfig {
  capacity: number;
  ballRadius: number;
  innerRadius: number;
  xMin: number;
  xMax: number;
  feedX: number;
  /** V floor slope toward the feed (tan of the angle). */
  vSlope: number;
}

const FEED_DUR = 0.07;               // s — a ball sucked into the feed (10 shots/s -> must stay short)
const SLEEP_WINDOW = 12;
const SLEEP_DRIFT = 2e-3;
const REST_V2 = 0.02 * 0.02;

export class PaintballHopperSim {
  readonly n: number;
  readonly r: number;
  readonly R: number;
  readonly x0: number;
  readonly x1: number;
  readonly feedX: number;
  readonly vSlope: number;

  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly ox: Float32Array; readonly oy: Float32Array; readonly oz: Float32Array;
  readonly state: Uint8Array;
  readonly age: Float32Array;
  readonly qx: Float32Array; readonly qy: Float32Array; readonly qz: Float32Array; readonly qw: Float32Array;
  readonly wx: Float32Array; readonly wy: Float32Array; readonly wz: Float32Array;
  readonly fx: Float32Array; readonly fy: Float32Array; readonly fz: Float32Array;   // feed animation start

  friction = 0.35;
  wallFriction = 0.45;
  restitution = 0.25;
  damping = 0.99;
  iterations = 8;

  awake = true;
  private windowStep = 0;
  private readonly sx: Float32Array; private readonly sy: Float32Array; private readonly sz: Float32Array;
  private readonly order: Int32Array;
  private lastAx = 0; private lastAy = 0; private lastAz = 0;
  private rng = 0x2545f491;

  constructor(cfg: PaintballHopperSimConfig) {
    const n = cfg.capacity;
    this.n = n; this.r = cfg.ballRadius; this.R = cfg.innerRadius;
    this.x0 = cfg.xMin; this.x1 = cfg.xMax; this.feedX = cfg.feedX; this.vSlope = cfg.vSlope;
    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f(); this.ox = f(); this.oy = f(); this.oz = f();
    this.age = f();
    this.qx = f(); this.qy = f(); this.qz = f(); this.qw = f().fill(1);
    this.wx = f(); this.wy = f(); this.wz = f();
    this.fx = f(); this.fy = f(); this.fz = f();
    this.state = new Uint8Array(n);
    this.order = new Int32Array(n);
    this.sx = f(); this.sy = f(); this.sz = f();
  }

  rand(): number {
    let x = this.rng | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }

  wake(): void { this.awake = true; this.windowStep = 0; }

  count(s: BState): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === s) c++;
    return c;
  }

  /** Lowest point of the V floor at x (hopper-local). */
  floorY(x: number): number {
    return -this.R + Math.abs(x - this.feedX) * this.vSlope;
  }

  place(i: number, x: number, y: number, z: number): void {
    this.px[i] = this.ox[i] = x; this.py[i] = this.oy[i] = y; this.pz[i] = this.oz[i] = z;
    this.state[i] = BState.Active;
    this.age[i] = 10;
    this.wx[i] = this.wy[i] = this.wz[i] = 0;
    this.wake();
  }

  hide(i: number): void { this.state[i] = BState.Hidden; }

  /** The active ball closest to the feed hole (bottom of the V, relative to the current "down"). */
  nearestToFeed(ax: number, ay: number, az: number): number {
    const al = Math.hypot(ax, ay, az) || 1;
    const dx = ax / al, dy = ay / al, dz = az / al;
    // feed point = the floor bottom; with the gun tilted the "lowest" ball near the feed wins
    let best = -1, bestS = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== BState.Active) continue;
      const ex = this.px[i] - this.feedX, ey = this.py[i] + this.R, ez = this.pz[i];
      const s = Math.hypot(ex, ey, ez) - 0.35 * (this.px[i] * dx + this.py[i] * dy + this.pz[i] * dz);
      if (s < bestS) { bestS = s; best = i; }
    }
    return best;
  }

  /** A shot: the ball nearest to the feed is sucked in (visual only; collisions stop at once). */
  feed(i: number): void {
    if (i < 0 || this.state[i] !== BState.Active) return;
    this.state[i] = BState.Fed;
    this.age[i] = 0;
    this.fx[i] = this.px[i]; this.fy[i] = this.py[i]; this.fz[i] = this.pz[i];
    this.wake();
  }

  /** Random velocity kick on every ball (recoil, slap, seating). amount in units/s. */
  shake(amount: number, upx = 0, upy = 1, upz = 0, dt = 1 / 60): void {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== BState.Active) continue;
      const k = amount * (0.4 + this.rand() * 0.6);
      this.ox[i] -= ((this.rand() - 0.5) * 0.8 + upx) * k * dt;
      this.oy[i] -= ((this.rand() - 0.5) * 0.8 + upy) * k * dt;
      this.oz[i] -= ((this.rand() - 0.5) * 0.8 + upz) * k * dt;
    }
    this.wake();
  }

  /** Visual scale multiplier (feed suction shrink). */
  visualScale(i: number): number {
    if (this.state[i] === BState.Fed) return Math.max(0, 1 - this.age[i] / FEED_DUR);
    return 1;
  }

  /** Feed animations only (all the work for remote / TP hoppers). Returns true while one runs. */
  animate(dt: number): boolean {
    let animating = false;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== BState.Fed) continue;
      this.age[i] += dt;
      const u = Math.min(1, this.age[i] / FEED_DUR), e = u * u;
      this.px[i] = this.fx[i] + (this.feedX - this.fx[i]) * e;
      this.py[i] = this.fy[i] + (-this.R - this.r - this.fy[i]) * e;
      this.pz[i] = this.fz[i] * (1 - e);
      this.ox[i] = this.px[i]; this.oy[i] = this.py[i]; this.oz[i] = this.pz[i];
      if (u >= 1) this.state[i] = BState.Hidden; else animating = true;
    }
    return animating;
  }

  /** One fixed substep; (ax, ay, az) = effective acceleration in HOPPER-LOCAL units/s². */
  step(dt: number, ax: number, ay: number, az: number): boolean {
    const dax = ax - this.lastAx, day = ay - this.lastAy, daz = az - this.lastAz;
    if (dax * dax + day * day + daz * daz > 1.5 * 1.5) {
      this.lastAx = ax; this.lastAy = ay; this.lastAz = az;
      this.wake();
    }
    const animating = this.animate(dt);
    if (animating) this.wake();
    if (!this.awake) return false;
    return this.solve(dt, ax, ay, az, animating);
  }

  private solve(dt: number, ax: number, ay: number, az: number, animating: boolean): boolean {
    const n = this.n;
    const { px, py, pz, ox, oy, oz, state } = this;
    const dt2 = dt * dt, damp = this.damping;
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (state[i] !== BState.Active) continue;
      const vx = (px[i] - ox[i]) * damp, vy = (py[i] - oy[i]) * damp, vz = (pz[i] - oz[i]) * damp;
      ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i];
      px[i] += vx + ax * dt2; py[i] += vy + ay * dt2; pz[i] += vz + az * dt2;
      this.order[len++] = i;
    }
    const ord = this.order;
    const r = this.r, rr = 2 * r, Rw = this.R - r;
    const fr = this.friction * 0.5, wf = this.wallFriction * 0.5, rest = this.restitution;
    const xl = this.x0 + r, xh = this.x1 - r;
    for (let it = 0; it < this.iterations; it++) {
      for (let a = 1; a < len; a++) {
        const k = ord[a]; const kx = px[k];
        let b = a - 1;
        while (b >= 0 && px[ord[b]] > kx) { ord[b + 1] = ord[b]; b--; }
        ord[b + 1] = k;
      }
      for (let a = 0; a < len; a++) {
        const i = ord[a];
        for (let b = a + 1; b < len; b++) {
          const j = ord[b];
          const dx = px[j] - px[i];
          if (dx > rr) break;
          const dy = py[j] - py[i], dz = pz[j] - pz[i];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-12) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d, nz = dz / d;
          const c = (rr - d) * 0.5;
          px[i] -= nx * c; py[i] -= ny * c; pz[i] -= nz * c;
          px[j] += nx * c; py[j] += ny * c; pz[j] += nz * c;
          const rvx = (px[j] - ox[j]) - (px[i] - ox[i]);
          const rvy = (py[j] - oy[j]) - (py[i] - oy[i]);
          const rvz = (pz[j] - oz[j]) - (pz[i] - oz[i]);
          const vn = rvx * nx + rvy * ny + rvz * nz;
          const tx = (rvx - nx * vn) * fr, ty = (rvy - ny * vn) * fr, tz = (rvz - nz * vn) * fr;
          ox[i] -= tx; oy[i] -= ty; oz[i] -= tz;
          ox[j] += tx; oy[j] += ty; oz[j] += tz;
        }
      }
      for (let a = 0; a < len; a++) {
        const i = ord[a];
        // tube wall (radius in YZ)
        const rad = Math.hypot(py[i], pz[i]);
        if (rad > Rw) {
          const nyr = py[i] / rad, nzr = pz[i] / rad;
          py[i] = nyr * Rw; pz[i] = nzr * Rw;
          const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
          const vn = vy * nyr + vz * nzr;
          const tvx = vx, tvy = vy - nyr * vn, tvz = vz - nzr * vn;
          const bounce = vn * vn > REST_V2 && vn > 0 ? -vn * rest : 0;
          ox[i] = px[i] - tvx * (1 - wf); oy[i] = py[i] - (tvy * (1 - wf) + nyr * bounce); oz[i] = pz[i] - (tvz * (1 - wf) + nzr * bounce);
        }
        // V floor (funnels toward the feed)
        const fy = this.floorY(px[i]) + r;
        if (py[i] < fy) {
          const s = px[i] > this.feedX ? 1 : -1;
          const nl = Math.hypot(this.vSlope, 1);
          const nx = -s * this.vSlope / nl, ny = 1 / nl;
          const pen = (fy - py[i]) * ny;
          px[i] += nx * pen; py[i] += ny * pen;
          const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
          const vn = vx * nx + vy * ny;
          if (vn < 0) { ox[i] += nx * vn * (1 + (vn * vn > REST_V2 ? rest : 0)); oy[i] += ny * vn * (1 + (vn * vn > REST_V2 ? rest : 0)); }
          ox[i] += (vx - nx * Math.min(vn, 0)) * wf * 0.5; oz[i] += vz * wf * 0.5;
        }
        // end caps
        if (px[i] < xl || px[i] > xh) {
          const t = px[i] < xl ? xl : xh;
          const vx = px[i] - ox[i];
          px[i] = t; ox[i] = vx * vx > REST_V2 ? t + vx * rest : t;
        }
      }
    }
    // rolling spin (facets roll with the balls)
    const gl = Math.hypot(ax, ay, az) || 1;
    const gx = ax / gl, gy = ay / gl, gz = az / gl;
    for (let a = 0; a < len; a++) {
      const i = ord[a];
      const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
      if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 1e-4) continue;
      const inv = 1 / (r * dt);
      this.wx[i] = (gy * vz - gz * vy) * inv; this.wy[i] = (gz * vx - gx * vz) * inv; this.wz[i] = (gx * vy - gy * vx) * inv;
      integrateQuat(this, i, dt);
    }
    if (animating) {
      this.windowStep = 0;
    } else if (this.windowStep === 0) {
      this.sx.set(px); this.sy.set(py); this.sz.set(pz);
      this.windowStep = 1;
    } else if (++this.windowStep > SLEEP_WINDOW) {
      let drift = 0;
      for (let a = 0; a < len; a++) {
        const i = ord[a];
        const d = Math.abs(px[i] - this.sx[i]) + Math.abs(py[i] - this.sy[i]) + Math.abs(pz[i] - this.sz[i]);
        if (d > drift) drift = d;
      }
      if (drift < SLEEP_DRIFT) {
        this.awake = false;
        for (let a = 0; a < len; a++) { const i = ord[a]; ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i]; }
      }
      this.windowStep = 0;
    }
    return true;
  }
}

function integrateQuat(s: PaintballHopperSim, i: number, dt: number): void {
  const wx = s.wx[i], wy = s.wy[i], wz = s.wz[i];
  const ang = Math.hypot(wx, wy, wz) * dt;
  if (ang < 1e-5) return;
  const h = ang * 0.5, sn = Math.sin(h) / (ang / dt);
  const dx = wx * sn, dy = wy * sn, dz = wz * sn, dw = Math.cos(h);
  const x = s.qx[i], y = s.qy[i], z = s.qz[i], w = s.qw[i];
  let nx = dw * x + dx * w + dy * z - dz * y;
  let ny = dw * y - dx * z + dy * w + dz * x;
  let nz = dw * z + dx * y - dy * x + dz * w;
  let nw = dw * w - dx * x - dy * y - dz * z;
  const l = 1 / Math.hypot(nx, ny, nz, nw);
  nx *= l; ny *= l; nz *= l; nw *= l;
  s.qx[i] = nx; s.qy[i] = ny; s.qz[i] = nz; s.qw[i] = nw;
}
