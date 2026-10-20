import { RENDER_SCALE_STEP } from "./GraphicsSettings";

/**
 * DYNAMIC RESOLUTION (option, off by default) — pure controller.
 *
 * Holds the target frame rate in play by moving the render scale between the
 * beauty floor and the scale the player set, with hysteresis so it never
 * ping-pongs:
 *   - DOWN fast: when the slow quarter of the last ~0.7 s of frames uses more
 *     than 92 % of the frame budget, the scale drops (proportionally to the
 *     overshoot, at least one 5 % step), then waits 1.2 s before any change;
 *   - UP slowly: one step at a time, only after 3 s of continuous headroom.
 *     With GPU timer queries the cost of the next step is predicted (pixels
 *     ∝ scale²) and must stay under 80 % of the budget; without them, frames
 *     coming at the target rate are the only clue: a step up that has to be
 *     undone within 4 s doubles the wait before the next try (up to 32×:
 *     one retry every ~1.5 min at worst), and drops go one step at a time
 *     (frames paced by the display say "too slow", not by how much).
 * Every change reallocates the render targets (a few ms, no shader compile):
 * the cooldowns cap that to a handful per minute in the worst case.
 */
export const DYNAMIC_RESOLUTION = {
  step: RENDER_SCALE_STEP,
  downAt: 0.92,
  upTarget: 0.8,
  /** Without GPU timer: frames within 5 % of the budget = holding the rate. */
  frameHold: 1.05,
  windowMs: 700,
  minSamples: 12,
  cooldownMs: 1200,
  upHoldMs: 3000,
  failWindowMs: 4000,
  maxBackoff: 32,
  /** GPU samples older than this no longer count as "a GPU timer is reporting". */
  gpuFreshMs: 1000,
};

export type DynamicResolutionConfig = typeof DYNAMIC_RESOLUTION;

interface Sample {
  t: number;
  ms: number;
}

export class DynamicResolutionController {
  private current: number;
  private readonly frames: Sample[] = [];
  private readonly gpuMs: Sample[] = [];
  private cooldownUntil = 0;
  private upSince: number | null = null;
  private lastUpAt = -Infinity;
  private backoff = 1;
  /** Changes made (tests / debug). */
  changes = 0;

  constructor(
    private min: number,
    private max: number,
    private budgetMs: number,
    private readonly cfg: DynamicResolutionConfig = DYNAMIC_RESOLUTION,
  ) {
    this.current = max;
  }

  get scale(): number {
    return this.current;
  }

  /** New bounds (player scale changed, floor changed with the screen). Returns the clamped scale. */
  setBounds(min: number, max: number): number {
    this.min = Math.min(min, max);
    this.max = max;
    this.current = Math.min(this.max, Math.max(this.min, this.current));
    return this.current;
  }

  setBudget(ms: number): void {
    this.budgetMs = ms;
  }

  /** Restart from the player's scale (resume after the menus: their frames are not play frames). */
  reset(now: number): void {
    this.frames.length = 0;
    this.gpuMs.length = 0;
    this.upSince = null;
    this.cooldownUntil = now + this.cfg.cooldownMs;
  }

  /** GPU execution time of a frame (arrives a few frames late). */
  gpu(now: number, ms: number): void {
    this.gpuMs.push({ t: now, ms });
    trim(this.gpuMs, now - this.cfg.windowMs);
  }

  /** A play frame ended: returns the new scale when it changes, else null. */
  frame(now: number, frameMs: number): number | null {
    this.frames.push({ t: now, ms: frameMs });
    trim(this.frames, now - this.cfg.windowMs);
    trim(this.gpuMs, now - this.cfg.windowMs);
    if (now < this.cooldownUntil) return null;
    const gpuMode =
      this.gpuMs.length >= this.cfg.minSamples / 2 && now - this.gpuMs[this.gpuMs.length - 1].t <= this.cfg.gpuFreshMs;
    const samples = gpuMode ? this.gpuMs : this.frames;
    if (samples.length < (gpuMode ? this.cfg.minSamples / 2 : this.cfg.minSamples)) return null;
    const values = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p75 = values[Math.floor((values.length - 1) * 0.75)];
    const p90 = values[Math.floor((values.length - 1) * 0.9)];
    const budget = this.budgetMs;

    if (p75 > budget * this.cfg.downAt && this.current > this.min) {
      // GPU time: pixels ∝ scale² — aim at upTarget of the budget, at least one
      // step down. Frame times only: vsync makes them 16.7 / 33.3 ms, which says
      // "too slow" but not by how much — one step at a time.
      const ideal = this.current * Math.sqrt((budget * this.cfg.upTarget) / p75);
      const stepped = gpuMode ? Math.round(ideal / this.cfg.step) * this.cfg.step : this.current - this.cfg.step;
      const next = Math.max(this.min, Math.min(this.current - this.cfg.step, stepped));
      if (now - this.lastUpAt < this.cfg.failWindowMs) this.backoff = Math.min(this.cfg.maxBackoff, this.backoff * 2);
      return this.change(next, now);
    }

    if (this.current < this.max) {
      const next = Math.min(this.max, this.current + this.cfg.step);
      const ratio = next / this.current;
      const room = gpuMode ? p90 * ratio * ratio <= budget * this.cfg.upTarget : p90 <= budget * this.cfg.frameHold;
      if (!room) {
        this.upSince = null;
        return null;
      }
      this.upSince ??= now;
      if (now - this.upSince < this.cfg.upHoldMs * this.backoff) return null;
      this.lastUpAt = now;
      return this.change(next, now);
    }
    // At the player's scale and holding: forgiven, the next drop restarts from 1×.
    if (now - this.lastUpAt > this.cfg.failWindowMs * 2) this.backoff = 1;
    return null;
  }

  private change(next: number, now: number): number | null {
    if (Math.abs(next - this.current) < 1e-6) return null;
    this.current = next;
    this.changes++;
    this.frames.length = 0;
    this.gpuMs.length = 0;
    this.upSince = null;
    this.cooldownUntil = now + this.cfg.cooldownMs;
    return next;
  }
}

function trim(samples: Sample[], before: number): void {
  let n = 0;
  while (n < samples.length && samples[n].t < before) n++;
  if (n > 0) samples.splice(0, n);
}
