const DEG = Math.PI / 180;

/**
 * Canvas box in PLATE pixels (the 170 Ã— 72 plate, y down). It ends left of the
 * tab (x 46) and of the face (x 49); the machine itself (axis at plate x 12)
 * stays left of the rail (x 30): the 3D never reaches the name, the counter or
 * the rail. Room above the plate for the jumping grains.
 */
export const MECH_CANVAS = { x: -15, y: -10, w: 54, h: 80 } as const;
/** On-screen size of the machine vs 1 world unit = 1 plate px. */
export const MECH_SCALE = 1.15;
/** World y seen at the canvas centre. */
export const VIEW_TARGET_Y = 4;

/**
 * Motion tuning (seconds / plate px / radians). Brief: local impulse 35–60 ms,
 * lid tilt 6–12° with one damping, 2–3 grains jumping 12–22 px over 100–160 ms
 * then falling back over 180–260 ms, one grain bouncing once on the edge,
 * everything under 450 ms.
 */
export const POPCORN_MECH_TUNING = {
  /** Miniature impulse: spring (ω, ζ) kicked at t = 0 — peak after ≈ 40 ms, peak ≈ 1.5 plate px, back in ≈ 200 ms. */
  kickW: 26,
  kickZ: 0.75,
  kickV: 100,
  /** Lid: tilt kick (rad/s) → peak ≈ 9° (clamped 12°), one small damped return. */
  lidW: 26,
  lidZ: 0.62,
  lidKick: 9.5,
  /** Lid while the weapon really reloads: wide open, a soft spring. */
  lidOpen: 62 * DEG,
  lidOpenW: 18,
  lidOpenZ: 0.55,
  /** Loads appearing in the window (refill): pop-in per grain; removed without a shot: quick shrink. */
  popW: 26,
  popZ: 0.5,
  popStagger: 0.035,
  dropW: 60,
  dropZ: 1,
} as const;

/** One jumping grain (HUD object, never a scene projectile). Heights / x / z in plate px / world units. */
export interface Flight {
  delay: number;
  rise: number;
  fall: number;
  /** Peak above the lid top, world units (× 1.15 × cos 20° ≈ on-screen px: 13.5 / 17.9 / 15.7). */
  px: number;
  x: number;
  z: number;
  /** Extra time of the single small bounce on the lid's front edge (0 = none). */
  bounce: number;
  spin: readonly [number, number, number];
}

/**
 * Three grains, restarted together by every real shot (a fixed pool, nothing
 * accumulates). Longest = delay + rise + fall (+ bounce) = 0.35 / 0.42 / 0.35 s < 0.45 s.
 * Grain 1 is the only one that bounces (once, on the front edge of the lid).
 */
export const FLIGHTS: readonly Flight[] = [
  { delay: 0, rise: 0.13, fall: 0.2, px: 12.5, x: -5.5, z: -0.5, bounce: 0, spin: [2.2, 1.4, -3.1] },
  { delay: 0.01, rise: 0.14, fall: 0.19, px: 16.5, x: 1.2, z: 7, bounce: 0.07, spin: [-1.6, 2.6, 2.0] },
  { delay: 0.03, rise: 0.12, fall: 0.18, px: 14.5, x: 6.4, z: 0.8, bounce: 0, spin: [1.1, -2.4, 2.8] },
];
export const MAX_JUMPS = FLIGHTS.length;
/** Height of the small bounce on the lid's front edge (plate px). */
export const BOUNCE_PX = 3;
/** A grain's resting radius (its centre sits this high above a surface). */
export const GRAIN_R = 2.4;

/** Scale of a resting grain (≈ 10 px wide) and of a jumping one. */
export const REST_SCALE = 1.2;
export const JUMP_SCALE = 1.1;

/**
 * Resting grains of ONE real load, as [x, dy, z] in world units: three in
 * front, two behind and one mound in the middle. Odd loads are mirrored so
 * two loads never look like a column.
 */
export const LAYER: ReadonlyArray<readonly [number, number, number]> = [
  [-7, 0, 3.5],
  [0, 0, 4.8],
  [7, 0, 3.5],
  [-3.6, 0.3, -3.2],
  [4, 0, -3.5],
  [0.5, 3.6, 0.2],
];
/** Height between two loads, and the centre of the first load above the window floor. */
export const LOAD_PITCH = 9.5;
export const LOAD_Y0 = 3.4;

/** A flying grain is hidden inside the lid at this height (relative to the lid top) and sinks for SINK_T after a bounce. */
export const SINK_Y = -2.8;
export const SINK_T = 0.03;
/** Seconds after a shot when the last grain is gone (< 0.45 s). */
export const FLIGHT_END = FLIGHTS.reduce((m, f) => Math.max(m, f.delay + f.rise + f.fall + (f.bounce > 0 ? f.bounce + SINK_T : 0)), 0);

/**
 * Height of a grain's centre above the lid top, `t` seconds after its own
 * start. Rise (ease-out) → fall (accelerating, u^1.6) back INTO the lid (hidden by it, so a
 * falling grain never lands in the window: it never reads as an ammo gain).
 * A bouncing grain lands on the lid's edge first, hops once, then sinks in.
 * null = not flying (before its start / finished).
 */
export function flightHeight(f: Flight, t: number): number | null {
  const rest = GRAIN_R * JUMP_SCALE * 0.9;
  if (t < 0) return null;
  if (t < f.rise) {
    const u = t / f.rise;
    return SINK_Y + (f.px - SINK_Y) * (1 - (1 - u) * (1 - u));
  }
  t -= f.rise;
  if (t < f.fall) {
    const u = t / f.fall;
    const end = f.bounce > 0 ? rest : SINK_Y;
    return f.px + (end - f.px) * u ** 1.6;
  }
  t -= f.fall;
  if (f.bounce <= 0) return null;
  if (t < f.bounce) {
    const v = t / f.bounce;
    return rest + BOUNCE_PX * 4 * v * (1 - v);
  }
  t -= f.bounce;
  if (t < SINK_T) return rest + (SINK_Y - rest) * (t / SINK_T);
  return null;
}

export const smooth = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** Damped spring (semi-implicit Euler, sub-stepped by the caller). */
export class Spring {
  x = 0;
  v = 0;
  target = 0;
  constructor(
    public w: number,
    public z: number,
  ) {}

  step(dt: number): void {
    const a = -2 * this.z * this.w * this.v - this.w * this.w * (this.x - this.target);
    this.v += a * dt;
    this.x += this.v * dt;
  }

  get settled(): boolean {
    return Math.abs(this.x - this.target) < 0.002 && Math.abs(this.v) < 0.01;
  }

  snap(to = this.target): void {
    this.target = to;
    this.x = to;
    this.v = 0;
  }
}
