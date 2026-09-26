/**
 * POPCORN TANK SOLVER — pure data, no three.js (unit-testable, zero allocation per frame).
 *
 * Position-based Verlet particles living in the TANK node's local space (weapon units, the same
 * space as the GLB `Tank.extras` layouts). Sphere/sphere contacts (sort-and-sweep on X, the index
 * list stays almost sorted between steps → insertion sort ≈ O(n)), box walls with restitution and
 * Coulomb-like friction, per-particle life states (kernel → popping → popcorn → consumed).
 *
 * COST: ≤ 72 particles, 4 relaxation iterations, fixed 60 Hz substeps (max 3 per frame) — well under
 * 0.2 ms per frame on desktop. The solver SLEEPS when nothing moves and the effective acceleration
 * is stable (full / empty tank at rest → no work at all, no instance-buffer upload).
 */

/** Particle life state (plain const object: no TS enum, erasable-syntax friendly). */
export const PState = { Hidden: 0, Kernel: 1, Popcorn: 2, Consumed: 3 } as const;
export type PState = (typeof PState)[keyof typeof PState];

export interface PopcornTankSimConfig {
  halfExtents: readonly [number, number, number];
  capacity: number;
  popcornRadius: number;
  kernelRadius: number;
}

const POP_GROW = 0.08; // s — kernel radius → popcorn radius
const POP_SCALE_DUR = 0.16; // s — visual squash & stretch of a pop
const CONSUME_DUR = 0.11; // s — popcorn sucked into the feed
const KERNEL_IN = 0.09; // s — kernel materialising (scale-in)
/** Sleep test: max displacement over a window of steps (PBD stacks keep a tiny velocity jitter,
 * so the test is positional, not velocity based). */
const SLEEP_WINDOW = 12;
const SLEEP_DRIFT = 2e-3; // units over the window (≈ 0.15 mm on screen)
/** Below this normal speed (units/step)² a wall contact is resting: no bounce (kills jitter). */
const REST_V2 = 0.02 * 0.02;

export class PopcornTankSim {
  readonly n: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly rPop: number;
  readonly rKernel: number;

  // position (current / previous) — Verlet
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly ox: Float32Array; readonly oy: Float32Array; readonly oz: Float32Array;
  /** Collision radius (animated while popping). */
  readonly r: Float32Array;
  readonly state: Uint8Array;
  /** Seconds since the last state change (pop / consume animations). */
  readonly age: Float32Array;
  /** Visual rotation (quaternion) + angular velocity (rad/s, local). */
  readonly qx: Float32Array; readonly qy: Float32Array; readonly qz: Float32Array; readonly qw: Float32Array;
  readonly wx: Float32Array; readonly wy: Float32Array; readonly wz: Float32Array;
  /** Per-particle visual size variation (baked). */
  readonly baseScale: Float32Array;
  /** Consume animation start point. */
  readonly cx: Float32Array; readonly cy: Float32Array; readonly cz: Float32Array;

  friction = 0.55;
  wallFriction = 0.6;
  restitution = 0.15;
  damping = 0.985;
  iterations = 4;

  awake = true;
  private windowStep = 0;
  private readonly sx: Float32Array; private readonly sy: Float32Array; private readonly sz: Float32Array;
  private readonly order: Int32Array;
  private lastAx = 0; private lastAy = 0; private lastAz = 0;
  private rng = 0x9e3779b9;

  constructor(cfg: PopcornTankSimConfig) {
    const n = cfg.capacity;
    this.n = n;
    [this.hx, this.hy, this.hz] = cfg.halfExtents;
    this.rPop = cfg.popcornRadius;
    this.rKernel = cfg.kernelRadius;
    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f(); this.ox = f(); this.oy = f(); this.oz = f();
    this.r = f(); this.age = f(); this.baseScale = f().fill(1);
    this.qx = f(); this.qy = f(); this.qz = f(); this.qw = f().fill(1);
    this.wx = f(); this.wy = f(); this.wz = f();
    this.cx = f(); this.cy = f(); this.cz = f();
    this.state = new Uint8Array(n);
    this.order = new Int32Array(n);
    this.sx = f(); this.sy = f(); this.sz = f();
  }

  /** Deterministic cheap random in [0,1). */
  rand(): number {
    let x = this.rng | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }

  wake(): void {
    this.awake = true;
    this.windowStep = 0;
  }

  count(s: PState): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === s) c++;
    return c;
  }

  /** Place particle i at rest (no velocity). */
  place(i: number, x: number, y: number, z: number, s: PState, radius?: number): void {
    this.px[i] = this.ox[i] = x;
    this.py[i] = this.oy[i] = y;
    this.pz[i] = this.oz[i] = z;
    this.state[i] = s;
    this.r[i] = radius ?? (s === PState.Kernel ? this.rKernel : this.rPop);
    this.age[i] = 10; // animations already finished
    this.wx[i] = this.wy[i] = this.wz[i] = 0;
    this.wake();
  }

  setRotation(i: number, x: number, y: number, z: number, w: number): void {
    this.qx[i] = x; this.qy[i] = y; this.qz[i] = z; this.qw[i] = w;
  }

  hide(i: number): void {
    this.state[i] = PState.Hidden;
  }

  /** Spawn a kernel with an initial velocity (units/s) — e.g. dropped from the open lid. */
  spawnKernel(i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, dt = 1 / 60): void {
    this.place(i, x, y, z, PState.Kernel, this.rKernel);
    this.ox[i] = x - vx * dt; this.oy[i] = y - vy * dt; this.oz[i] = z - vz * dt;
    this.age[i] = 0;
    this.randomSpin(i, 14);
  }

  /** Kernel → popcorn: grows, jumps (impulse along `up`, units/s) and tumbles. */
  pop(i: number, upx: number, upy: number, upz: number, dt = 1 / 60): void {
    if (this.state[i] !== PState.Kernel) return;
    this.state[i] = PState.Popcorn;
    this.age[i] = 0;
    const j = 2.2 + this.rand() * 2.0;
    const lx = (this.rand() - 0.5) * 1.6, lz = (this.rand() - 0.5) * 1.6;
    const vx = upx * j + lx, vy = upy * j, vz = upz * j + lz;
    this.ox[i] = this.px[i] - vx * dt;
    this.oy[i] = this.py[i] - vy * dt;
    this.oz[i] = this.pz[i] - vz * dt;
    this.randomSpin(i, 18);
    this.wake();
  }

  /** Random velocity kick on every loose piece (shot recoil, lid slam). amount in units/s. */
  shake(amount: number, upx = 0, upy = 1, upz = 0, dt = 1 / 60): void {
    for (let i = 0; i < this.n; i++) {
      const s = this.state[i];
      if (s !== PState.Popcorn && s !== PState.Kernel) continue;
      const k = amount * (0.4 + this.rand() * 0.6);
      this.ox[i] -= ((this.rand() - 0.5) * 0.8 + upx) * k * dt;
      this.oy[i] -= ((this.rand() - 0.5) * 0.8 + upy) * k * dt;
      this.oz[i] -= ((this.rand() - 0.5) * 0.8 + upz) * k * dt;
    }
    this.wake();
  }

  /** Popcorn sucked into the feed (a shot). Collisions stop immediately. */
  consume(i: number): void {
    if (this.state[i] !== PState.Popcorn) return;
    this.state[i] = PState.Consumed;
    this.age[i] = 0;
    this.cx[i] = this.px[i]; this.cy[i] = this.py[i]; this.cz[i] = this.pz[i];
    this.wake();
  }

  private randomSpin(i: number, amount: number): void {
    this.wx[i] = (this.rand() - 0.5) * amount;
    this.wy[i] = (this.rand() - 0.5) * amount;
    this.wz[i] = (this.rand() - 0.5) * amount;
  }

  /** Visual scale multiplier of particle i (pop squash & stretch / consume shrink). */
  visualScale(i: number): number {
    const s = this.state[i];
    const a = this.age[i];
    if (s === PState.Popcorn) {
      if (a >= POP_SCALE_DUR) return this.baseScale[i];
      const u = a / POP_SCALE_DUR; // 0.3 → 1.18 → 1.0
      const k = u < 0.45 ? 0.3 + (1.18 - 0.3) * easeOut(u / 0.45) : 1.18 - 0.18 * easeInOut((u - 0.45) / 0.55);
      return k * this.baseScale[i];
    }
    if (s === PState.Consumed) return Math.max(0, 1 - a / CONSUME_DUR) * this.baseScale[i];
    if (s === PState.Kernel && a < KERNEL_IN) return easeOut(a / KERNEL_IN);  // materialise
    return this.baseScale[i];
  }

  /**
   * One fixed substep. (ax, ay, az): effective acceleration in TANK-LOCAL units/s²
   * (gravity + inertia of the moving weapon, already converted by the caller).
   * Returns true while something moved.
   */
  step(dt: number, ax: number, ay: number, az: number, feedX = 0, feedY = -this.hy, feedZ = 0): boolean {
    // wake on a significant acceleration change (player moves / weapon tilts)
    const dax = ax - this.lastAx, day = ay - this.lastAy, daz = az - this.lastAz;
    if (dax * dax + day * day + daz * daz > 1.5 * 1.5) {
      this.lastAx = ax; this.lastAy = ay; this.lastAz = az;
      this.wake();
    }
    const animating = this.animate(dt, feedX, feedY, feedZ);
    if (animating) this.wake();
    if (!this.awake) return false;
    return this.solve(dt, ax, ay, az, animating);
  }

  /**
   * Life-state animations only (pop growth, consume suction). Cheap; this is ALL the work done
   * for remote / third-person weapons (no physics: particles stay on their baked slots).
   * Returns true while an animation runs.
   */
  animate(dt: number, feedX = 0, feedY = -this.hy, feedZ = 0): boolean {
    const n = this.n;
    const { px, py, pz, ox, oy, oz, r, state, age } = this;
    let animating = false;
    for (let i = 0; i < n; i++) {
      const s = state[i];
      if (s === PState.Hidden) continue;
      if (age[i] < 1) {
        age[i] += dt;
        if (age[i] < (s === PState.Kernel ? KERNEL_IN : Math.max(POP_SCALE_DUR, CONSUME_DUR)) + dt) animating = true;
      }
      if (s === PState.Popcorn && r[i] < this.rPop) {
        r[i] = Math.min(this.rPop, this.rKernel + (this.rPop - this.rKernel) * easeOut(Math.min(1, age[i] / POP_GROW)));
        animating = true;
      }
      if (s === PState.Consumed) {
        const u = Math.min(1, age[i] / CONSUME_DUR);
        const e = u * u;
        px[i] = this.cx[i] + (feedX - this.cx[i]) * e;
        py[i] = this.cy[i] + (feedY - this.cy[i]) * e;
        pz[i] = this.cz[i] + (feedZ - this.cz[i]) * e;
        ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i];
        if (u >= 1) state[i] = PState.Hidden;
      }
    }
    return animating;
  }

  private solve(dt: number, ax: number, ay: number, az: number, animating: boolean): boolean {
    const n = this.n;
    const { px, py, pz, ox, oy, oz, r, state, age } = this;
    // ---- integrate
    const dt2 = dt * dt;
    const damp = this.damping;
    let len = 0;
    for (let i = 0; i < n; i++) {
      const s = state[i];
      if (s !== PState.Kernel && s !== PState.Popcorn) continue;
      const vx = (px[i] - ox[i]) * damp, vy = (py[i] - oy[i]) * damp, vz = (pz[i] - oz[i]) * damp;
      ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i];
      px[i] += vx + ax * dt2; py[i] += vy + ay * dt2; pz[i] += vz + az * dt2;
      this.order[len++] = i;
    }
    const ord = this.order;
    const fr = this.friction * 0.5;
    const hx = this.hx, hy = this.hy, hz = this.hz;
    const rest = this.restitution, wf = this.wallFriction * 0.5;

    for (let it = 0; it < this.iterations; it++) {
      // insertion sort on x (nearly sorted → ~O(n))
      for (let a = 1; a < len; a++) {
        const k = ord[a]; const kx = px[k];
        let b = a - 1;
        while (b >= 0 && px[ord[b]] > kx) { ord[b + 1] = ord[b]; b--; }
        ord[b + 1] = k;
      }
      // pairs
      for (let a = 0; a < len; a++) {
        const i = ord[a];
        const ri = r[i];
        for (let b = a + 1; b < len; b++) {
          const j = ord[b];
          const rr = ri + r[j];
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
          // friction: damp relative tangential velocity
          const rvx = (px[j] - ox[j]) - (px[i] - ox[i]);
          const rvy = (py[j] - oy[j]) - (py[i] - oy[i]);
          const rvz = (pz[j] - oz[j]) - (pz[i] - oz[i]);
          const vn = rvx * nx + rvy * ny + rvz * nz;
          const tx = (rvx - nx * vn) * fr, ty = (rvy - ny * vn) * fr, tz = (rvz - nz * vn) * fr;
          ox[i] -= tx; oy[i] -= ty; oz[i] -= tz;
          ox[j] += tx; oy[j] += ty; oz[j] += tz;
        }
      }
      // walls
      for (let a = 0; a < len; a++) {
        const i = ord[a];
        const ri = r[i];
        let lo = -hx + ri, hi = hx - ri;
        if (px[i] < lo || px[i] > hi) {
          const t = px[i] < lo ? lo : hi;
          const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
          px[i] = t; ox[i] = vx * vx > REST_V2 ? t + vx * rest : t; oy[i] += vy * wf; oz[i] += vz * wf;
        }
        lo = -hy + ri; hi = hy - ri;
        if (py[i] < lo || py[i] > hi) {
          const t = py[i] < lo ? lo : hi;
          const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
          py[i] = t; oy[i] = vy * vy > REST_V2 ? t + vy * rest : t; ox[i] += vx * wf; oz[i] += vz * wf;
        }
        lo = -hz + ri; hi = hz - ri;
        if (pz[i] < lo || pz[i] > hi) {
          const t = pz[i] < lo ? lo : hi;
          const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
          pz[i] = t; oz[i] = vz * vz > REST_V2 ? t + vz * rest : t; ox[i] += vx * wf; oy[i] += vy * wf;
        }
      }
    }

    // ---- visual tumbling
    const gl = Math.hypot(ax, ay, az) || 1;
    const gx = ax / gl, gy = ay / gl, gz = az / gl;
    for (let a = 0; a < len; a++) {
      const i = ord[a];
      const vx = px[i] - ox[i], vy = py[i] - oy[i], vz = pz[i] - oz[i];
      if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 1e-3 && age[i] > 0.35) continue; // resting jitter: no spin
      // rolling: ω ≈ (down × v) / r, blended with the free spin of fresh pops / kernels
      const inv = 1 / (r[i] * dt);
      const rx = (gy * vz - gz * vy) * inv, ry = (gz * vx - gx * vz) * inv, rz = (gx * vy - gy * vx) * inv;
      const k = age[i] < 0.35 ? 0.15 : 0.6;
      this.wx[i] = this.wx[i] * (1 - k) * 0.97 + rx * k;
      this.wy[i] = this.wy[i] * (1 - k) * 0.97 + ry * k;
      this.wz[i] = this.wz[i] * (1 - k) * 0.97 + rz * k;
      integrateQuat(this, i, dt);
    }
    // ---- sleep test (positional drift over a window)
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
        // freeze: kill the residual jitter so the pile wakes up exactly where it slept
        for (let a = 0; a < len; a++) { const i = ord[a]; ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i]; }
      }
      this.windowStep = 0;
    }
    return true;
  }
}

function easeOut(u: number): number {
  const v = 1 - Math.min(1, Math.max(0, u));
  return 1 - v * v * v;
}

function easeInOut(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
}

function integrateQuat(s: PopcornTankSim, i: number, dt: number): void {
  const wx = s.wx[i], wy = s.wy[i], wz = s.wz[i];
  const ang = Math.hypot(wx, wy, wz) * dt;
  if (ang < 1e-5) return;
  const h = ang * 0.5, sn = Math.sin(h) / (ang / dt);
  const dx = wx * sn, dy = wy * sn, dz = wz * sn, dw = Math.cos(h);
  const x = s.qx[i], y = s.qy[i], z = s.qz[i], w = s.qw[i];
  // q' = dq * q
  let nx = dw * x + dx * w + dy * z - dz * y;
  let ny = dw * y - dx * z + dy * w + dz * x;
  let nz = dw * z + dx * y - dy * x + dz * w;
  let nw = dw * w - dx * x - dy * y - dz * z;
  const l = 1 / Math.hypot(nx, ny, nz, nw);
  nx *= l; ny *= l; nz *= l; nw *= l;
  s.qx[i] = nx; s.qy[i] = ny; s.qz[i] = nz; s.qw[i] = nw;
}
