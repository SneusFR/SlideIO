/** GoofyBasket presentation only. No scene, socket, physics or damage access.
 * Positions are ALREADY converted: FP camera space; TP source glTF scene space.
 * TP curves inherit the normalized glTF scene transform, NOT remote.model's
 * unscaled wrapper. A world-space consumer multiplies that scene matrix once.
 * Scale stays on the visual instance (profile radius / source radius 0.125).
 * Do not apply the source FP_Viewmodel transform a second time.
 */
export type BasketView = "FP" | "TP";
export type BasketPosition = [number, number, number];
export type BasketQuaternion = [number, number, number, number]; // x, y, z, w

export interface BasketPose {
  position: BasketPosition;
  quaternion: BasketQuaternion;
  visible: boolean;
  /** Authored contact state, NOT permission to apply a second socket transform. */
  attached: boolean;
}
export interface BasketSample extends BasketPose { t: number }
export interface BasketClip {
  duration: number;
  loop: boolean;
  samples: readonly BasketSample[];
}
export interface BasketCurveView {
  space: "camera" | "character";
  clips: Readonly<Record<string, BasketClip>>;
}
export interface BasketCurveLibrary {
  schemaVersion: 1;
  views: { FP: BasketCurveView; TP: BasketCurveView };
}
export interface BasketGatherOptions {
  duration?: number;
  /** Units/second in the SAME coordinate space; omit for zero initial velocity. */
  initialVelocity?: readonly [number, number, number];
  onComplete?: () => void;
  onCancel?: () => void;
}
interface GatherState {
  from: BasketPose;
  velocity: BasketPosition;
  startedAt: number;
  duration: number;
  onComplete?: () => void;
  onCancel?: () => void;
}

export function createBasketPose(): BasketPose {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], visible: false, attached: false };
}

function finite(n: number, label: string): void {
  if (!Number.isFinite(n)) throw new RangeError(`${label} must be finite`);
}
function vector(value: unknown, count: number, label: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== count || value.some(v => typeof v !== "number" || !Number.isFinite(v))) {
    throw new TypeError(`${label} must contain ${count} finite numbers`);
  }
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}
function validPose(value: unknown, label: string): asserts value is BasketPose {
  record(value, label);
  vector(value.position, 3, `${label}.position`);
  vector(value.quaternion, 4, `${label}.quaternion`);
  const length = Math.hypot(...value.quaternion);
  if (!Number.isFinite(length) || length < 1e-12) throw new RangeError(`${label}.quaternion has invalid length`);
  if (typeof value.visible !== "boolean" || typeof value.attached !== "boolean") {
    throw new TypeError(`${label}: visible and attached must be booleans`);
  }
}

/** Validate once when loading JSON. Data is retained by reference: do not mutate it. */
function validateLibrary(value: unknown): BasketCurveLibrary {
  record(value, "curves");
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported GoofyBasket curve schemaVersion");
  record(value.views, "views");
  for (const view of ["FP", "TP"] as const) {
    const data = value.views[view];
    record(data, view);
    if (data.space !== (view === "FP" ? "camera" : "character")) throw new TypeError(`${view}: incorrect coordinate space`);
    record(data.clips, `${view}.clips`);
    for (const [name, clip] of Object.entries(data.clips)) {
      record(clip, name);
      if (typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration <= 0) {
        throw new RangeError(`${name}: duration must be positive and finite`);
      }
      if (typeof clip.loop !== "boolean") throw new TypeError(`${name}: loop must be boolean`);
      if (!Array.isArray(clip.samples) || clip.samples.length === 0) throw new TypeError(`${name}: samples required`);
      let previous = -Infinity;
      for (const [index, sample] of clip.samples.entries()) {
        validPose(sample, `${name}[${index}]`);
        const t = (sample as BasketSample).t;
        if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > clip.duration || t <= previous) {
          throw new RangeError(`${name}: sample times must increase strictly within [0, duration]`);
        }
        if (index === 0 && t !== 0) throw new RangeError(`${name}: first sample must be at zero`);
        previous = t;
      }
    }
  }
  return value as unknown as BasketCurveLibrary;
}

function copyPose(from: BasketPose, out: BasketPose): void {
  for (let i = 0; i < 3; i++) out.position[i] = from.position[i];
  const length = Math.hypot(...from.quaternion);
  for (let i = 0; i < 4; i++) out.quaternion[i] = from.quaternion[i] / length;
  out.visible = from.visible;
  out.attached = from.attached;
}
function slerp(a: BasketQuaternion, b: BasketQuaternion, t: number, out: BasketQuaternion): void {
  const an = Math.hypot(...a), bn = Math.hypot(...b);
  const ax = a[0] / an, ay = a[1] / an, az = a[2] / an, aw = a[3] / an;
  let bx = b[0] / bn, by = b[1] / bn, bz = b[2] / bn, bw = b[3] / bn;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  dot = Math.min(1, Math.max(-1, dot));
  let wa = 1 - t, wb = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), denominator = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / denominator;
    wb = Math.sin(t * angle) / denominator;
  }
  const x = wa * ax + wb * bx, y = wa * ay + wb * by;
  const z = wa * az + wb * bz, w = wa * aw + wb * bw;
  const length = Math.hypot(x, y, z, w);
  out[0] = x / length; out[1] = y / length; out[2] = z / length; out[3] = w / length;
}
function differentFlags(a: BasketPose, b: BasketPose): boolean {
  return a.visible !== b.visible || a.attached !== b.attached;
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Reuse one caller-owned output pose and ONE visual ball per view.
 * This sampler does not allocate per sample or retain the output arrays.
 * A visual projectile launched into the world is managed elsewhere.
 */
export class GoofyBasketPresentation {
  private readonly curves: BasketCurveLibrary;
  private readonly gathers: Partial<Record<BasketView, GatherState>> = {};

  constructor(curvesJson: unknown) { this.curves = validateLibrary(curvesJson); }

  private clip(view: BasketView, name: string): BasketClip {
    const data = this.curves.views[view];
    const clip = data?.clips[name];
    if (!clip) throw new RangeError(`Unknown GoofyBasket clip ${view}/${name}`);
    return clip;
  }

  /** Non-loop: clamp to endpoints. Loop: positive modulo (also for negative time).
   * Booleans use the latest sample at or before t; no blended visibility.
   * Quaternion samples should be dense enough that each intended arc is <= PI.
   */
  sample(view: BasketView, name: string, elapsedSeconds: number, out: BasketPose): BasketPose {
    finite(elapsedSeconds, "elapsedSeconds");
    const clip = this.clip(view, name);
    const wrapped = elapsedSeconds % clip.duration;
    const t = clip.loop
      ? (wrapped < 0 ? wrapped + clip.duration : wrapped)
      : Math.max(0, Math.min(clip.duration, elapsedSeconds));
    const samples = clip.samples;
    let low = 0, high = samples.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (samples[mid].t <= t) low = mid + 1; else high = mid;
    }
    const a = samples[Math.max(0, low - 1)];
    const b = samples[Math.min(samples.length - 1, low)];
    const blend = a === b ? 0 : (t - a.t) / (b.t - a.t);
    for (let i = 0; i < 3; i++) out.position[i] = a.position[i] * (1 - blend) + b.position[i] * blend;
    slerp(a.quaternion, b.quaternion, blend, out.quaternion);
    out.visible = a.visible; out.attached = a.attached;
    return out;
  }

  /** Visit every visible/attached change in (from, to], including a long frame.
   * Pure cosmetic notification. Caller tracks its cursor/action id; calling the
   * same interval twice repeats notifications. Backward seeks emit nothing.
   * No per-event allocation: samples are readonly references to the JSON.
   */
  forEachStateChange(
    view: BasketView, name: string, fromSeconds: number, toSeconds: number,
    visit: (elapsedSeconds: number, sample: Readonly<BasketSample>, cycle: number) => void,
  ): number {
    finite(fromSeconds, "fromSeconds"); finite(toSeconds, "toSeconds");
    const clip = this.clip(view, name);
    if (toSeconds <= fromSeconds) return 0;
    const samples = clip.samples;
    const firstCycle = clip.loop ? Math.floor(fromSeconds / clip.duration) : 0;
    const lastCycle = clip.loop ? Math.floor(toSeconds / clip.duration) : 0;
    if (!Number.isSafeInteger(firstCycle) || !Number.isSafeInteger(lastCycle)) throw new RangeError("State-change cycle is outside the safe integer range");
    if (lastCycle - firstCycle > 10000) throw new RangeError("State-change interval exceeds 10000 loops; reset the presentation cursor");
    let count = 0;
    let lastActive = samples.length - 1;
    if (clip.loop && samples[lastActive].t === clip.duration) lastActive--;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (clip.loop && sample.t === clip.duration) continue; // seam belongs to next cycle's first sample
        if (i === 0 && !clip.loop) continue; // initial state, not a transition
        const previous = i > 0 ? samples[i - 1] : samples[Math.max(0, lastActive)];
        const at = cycle * clip.duration + sample.t;
        if (at > fromSeconds && at <= toSeconds && differentFlags(previous, sample)) {
          visit(at, sample, cycle); count++;
        }
      }
    }
    return count;
  }

  /** Snapshot the ACTUAL current dribble pose when interruption occurs.
   * Allocates only when starting a transition, never while sampling it.
   * Starting again cancels the previous gather once. Never restart per frame.
   */
  beginGather(view: BasketView, from: BasketPose, nowSeconds: number, options: BasketGatherOptions = {}): void {
    finite(nowSeconds, "nowSeconds"); validPose(from, "gather.from");
    const duration = options.duration ?? 0.18;
    finite(duration, "gather.duration");
    if (duration <= 0) throw new RangeError("gather.duration must be positive");
    const velocity = options.initialVelocity ?? [0, 0, 0];
    vector(velocity, 3, "gather.initialVelocity");
    this.cancelGather(view);
    const snapshot = createBasketPose(); copyPose(from, snapshot);
    this.gathers[view] = {
      from: snapshot, velocity: [velocity[0], velocity[1], velocity[2]],
      startedAt: nowSeconds, duration,
      onComplete: options.onComplete, onCancel: options.onCancel,
    };
  }

  /** The target is the CURRENT grip pose in the same space, updated each frame.
   * Position follows a smooth moving endpoint; optional initial velocity is
   * retained at the start. Quaternion converges to the moving grip orientation.
   * Returns inactive without modifying out when no gather is running.
   */
  sampleGather(view: BasketView, nowSeconds: number, grip: BasketPose, out: BasketPose): "inactive" | "gathering" | "complete" {
    finite(nowSeconds, "nowSeconds");
    const g = this.gathers[view];
    if (!g) return "inactive";
    validPose(grip, "gather.grip");
    const u = clamp01((nowSeconds - g.startedAt) / g.duration);
    if (u >= 1) {
      copyPose(grip, out);
      delete this.gathers[view];
      g.onComplete?.();
      return "complete";
    }
    const smooth = u * u * u * (u * (u * 6 - 15) + 10);
    const velocityWeight = u * (1 - u) * (1 - u) * g.duration;
    for (let i = 0; i < 3; i++) {
      out.position[i] = g.from.position[i] * (1 - smooth) + grip.position[i] * smooth + g.velocity[i] * velocityWeight;
    }
    slerp(g.from.quaternion, grip.quaternion, smooth, out.quaternion);
    out.visible = g.from.visible;
    out.attached = false;
    return "gathering";
  }

  cancelGather(view: BasketView): void {
    const previous = this.gathers[view];
    delete this.gathers[view];
    previous?.onCancel?.();
  }

  /** Drop pending callbacks on death/switch/reset; hide the caller's ball too. */
  reset(view?: BasketView): void {
    if (view) this.cancelGather(view);
    else { this.cancelGather("FP"); this.cancelGather("TP"); }
  }
}
