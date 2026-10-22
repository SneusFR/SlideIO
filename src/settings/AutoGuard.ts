import { cheaperPerFrame, noCostlier } from "./AutoTune";
import { sameValues, type AutoResult, type GraphicsValues } from "./GraphicsSettings";
import type { PowerState } from "./Power";

/**
 * AUTO GUARD — the "Auto" preset's promise kept in MATCHES: at least 60 FPS
 * (or the display's own rate when it is lower). Pure logic, fed with the
 * frames the game renders (GraphicsController wires it).
 *
 * The detection (settings/AutoTune) measures the menu: a fixed view, a cool
 * chip in its turbo window, a main thread with nothing to simulate. A match
 * is something else — 8 bots and their effects in view, the HUD, a busy
 * processor sharing the laptop's power budget with the GPU, and, minutes
 * later, the chip at its sustained clocks (battery, office power plans). On
 * the owner's work laptop Auto held 60 FPS at first, then not. So the
 * guard watches the real frames of FOCUSED PLAY (pointer locked, page
 * visible, the match running) and, when 60 FPS stop holding for a sustained
 * stretch, steps the answer DOWN the detection's own ladder:
 *   - live (only settings applied without a shader compile are on the
 *     ladder), one significant rung at a time (guardStepIndex);
 *   - judged again after each step: KEPT (stored as the Auto result of this
 *     map and GPU) only when it helped; a step that changed nothing means
 *     the graphics are not the limit (a browser frame cap, the processor, the
 *     browser's GPU process): the guard stops for the session and that step
 *     is not stored;
 *   - never back up inside a session (no oscillation); at the start of a
 *     LATER session (the next day, then waits doubling after each failed
 *     try) ONE rung back up towards the detection's own answer is tried,
 *     stored once it held a whole match, stepped down again otherwise —
 *     conditions change (charger, room, a lighter HUD after an update);
 *   - POWER-AWARE (settings/Power, when the browser tells): each kept step
 *     records whether the laptop ran on its battery. A step taken on
 *     battery says nothing about the charger (owner's laptop: 2.8× the
 *     main-thread time, +20 % GPU on battery), so once plugged in — at the
 *     start of a session, or when the charger is plugged in BETWEEN matches
 *     (never mid-match) — its rung is tried again at once, with the same
 *     rules (kept after a whole match, stepped down otherwise); a try that
 *     fails costs no doubled wait, and a step that does not hold on the
 *     charger either is a mains step from then on (the normal wait). A step
 *     taken plugged in, or with the power unknown, keeps the normal wait;
 *   - never below the beauty floor (the ladder's last rung), never above
 *     the detection's answer, never for an explicit preset (Low, High,
 *     Custom…).
 *
 * Signal: the intervals between rendered frames — as the detection, no GPU
 * timer queries. When the GPU is the limit, Chrome delivers ≈ 1000 / (GPU ms
 * per frame) frames per second (a 18 ms frame → ~55 FPS: a 33 ms interval
 * now and then among 16.7 ms ones), so the delivered frame rate of a
 * stretch measures how far it is short — short when it is under the line
 * on average AND in most of its seconds (a burst of action is not a machine
 * short of 60). Left out of it:
 *   - frames the PROCESSOR made late (the main thread alone took ~ a whole
 *     frame: AI, a kill, garbage collection) — lowering the graphics would
 *     not help them; a stretch mostly made of them is not judged at all;
 *   - the slowest 1.5 % of the rest (lone hitches: the browser's GPU process,
 *     an upload);
 *   - stalls (> 250 ms), and the seconds that follow entering / resuming play
 *     or a step (re-allocation, the HUD's big first frame, clocks ramping).
 */

/** Every threshold of the guard, with its reason. */
export const AUTO_GUARD = {
  /**
   * The promise holds while the delivered frame rate of a stretch stays at
   * ≥ 95 % of the goal (57 FPS for 60). With the trimming below, a 60 Hz
   * laptop triggers from ≈ 17.6 ms of GPU per frame (≈ 55-56 FPS delivered:
   * a missed refresh every ~12 frames, judder you see), while 58-59 FPS
   * (a GPU at 16.9-17.2 ms) or lone hitches never cost the image a step.
   */
  holdRatio: 0.95,
  /**
   * SUSTAINED = the last 10 s of focused play: longer than a burst of action
   * (an explosion, a pile-up of bots: 1-5 s) — reacting to those would lower
   * the image for a moment's frames — and short against the minutes a laptop
   * takes to settle at its sustained clocks. ≈ 600 frames at 60 FPS.
   */
  windowMs: 10_000,
  /**
   * After a step, the stretch that judges it: shorter (the machine is known
   * to be short in this match), so that two or three steps, when a throttled
   * laptop needs them, take ≈ 30 s and not a minute.
   */
  followUpMs: 6_000,
  /** A stretch needs at least this many counted frames to be judged (a very slow machine too: 10 FPS × 6 s). */
  minFrames: 60,
  /**
   * …and SUSTAINED means most of it, not its average: at least 70 % of its
   * seconds (7 of the last 10) must be below the line too. 8 s at 60 FPS
   * plus 2 s at 30 (an explosion, a pile-up) average 54 FPS — that is a
   * burst, not a machine short of 60.
   */
  sustainShare: 0.7,
  /** Length of those seconds: buckets of focused-play time (ms). */
  bucketMs: 1000,
  /** Slowest share of a stretch's counted intervals left out (lone hitches: ≈ 9 frames of 600). */
  trimShare: 0.015,
  /**
   * An interval that follows a frame whose main-thread time took ≥ 90 % of
   * the goal's budget (15 ms at 60) was late because of the PROCESSOR — not
   * the graphics: left out of the frame rate.
   */
  cpuLateShare: 0.9,
  /**
   * …but not all of that main-thread time is the processor's. The render
   * submission WAITS when the browser's GPU process falls behind (its command
   * buffer is full): on the owner's laptop, a GPU-bound fight showed
   * 4-8 ms of submission against 1.5-3 ms at 60 FPS, and the guard took those
   * frames for the processor's — no verdict, the match stayed at 45-55 FPS.
   * The processor's part of a frame = its main-thread time with the
   * submission counted at its usual level only — the lowest one seen in
   * focused play (a GPU-bound stretch can last the whole match: the level
   * must be remembered, not averaged), creeping up 2 % per second (the scene
   * changes), a sample under a quarter of it ignored (an odd near-empty
   * frame). The surplus is the graphics'.
   */
  renderFloorCreepPerS: 0.02,
  renderFloorOutlier: 0.25,
  /** A stretch with more than half its frames processor-late is the processor's: no verdict. */
  maxCpuShare: 0.5,
  /** An interval longer than this is a stall (tab switch, long task, collection), not a GPU frame: ignored, and play settles again. */
  stallMs: 250,
  /** Focused play ignored after entering / resuming it (the HUD's first big frame, clocks ramping up after the menu). */
  resumeSettleMs: 3_000,
  /** …and after a step (render targets re-allocated, a shadow map re-baked). */
  stepSettleMs: 2_000,
  /**
   * A step that did not fully restore the goal is still KEPT when the next
   * stretch is ≥ 2 % faster than the one that triggered it (a rung of this
   * ladder removes ≥ 10 % of the pixels, or MSAA: several % of a GPU-bound
   * frame); otherwise the graphics were not the limit — the guard stops.
   */
  minGain: 0.02,
  /** Verdicts are looked at every 0.5 s of focused play (the per-frame work is a few additions). */
  checkEveryMs: 500,
  /**
   * STEPPING BACK UP — never inside a session: the frames of a lower rung say
   * nothing about the rung above it (a vsync display shows 60 FPS at 10 ms
   * and at 16 ms alike), so going back up there would be a guess, and an
   * oscillation when it is wrong (on the owner's laptop 90 % held a whole
   * match with ≈ 9 late frames, 100 % fell to 45-48 FPS). But conditions
   * change between sessions — a laptop plugged in again, a cooler room, a
   * lighter HUD after an update — so at the START of a later session ONE rung
   * up is tried (towards the detection's own answer, never above it), from
   * the next day on: the first try 20 h after the step…
   */
  retryAfterMs: 20 * 3600_000,
  /** …each failed try doubling the wait (20 h, 40 h, 80 h…), at most a month. */
  retryMaxMs: 30 * 24 * 3600_000,
  /** A tried rung is kept (stored) once it held this much focused play without a step: about one match. */
  trialKeepMs: 4 * 60_000,
  /** Histogram resolution of the intervals (trimmed frame rate without sorting anything). */
  binMs: 0.25,
  /** Intervals kept per stretch (10 s at 400 FPS). */
  capacity: 4096,
};

export type AutoGuardConfig = typeof AUTO_GUARD;

/**
 * A sliding stretch of focused-play frame intervals: the processor-late ones
 * counted apart, the others in a histogram (trimmed frame rate without a
 * sort). Fixed memory; nothing allocated per frame.
 */
export class FrameStretch {
  /**
   * Intervals, oldest first from `head` (negative = processor-late). Float64:
   * a value dropped must be exactly the one added (sums, histogram bin).
   */
  private readonly ring: Float64Array;
  private head = 0;
  private size = 0;
  private totalMs = 0;
  private countedN = 0;
  private countedMs = 0;
  private cpuLateN = 0;
  private readonly bins: Uint32Array;
  private readonly binSums: Float64Array;
  /** The last seconds' frame rates (NaN: a second the processor made mostly late), oldest first from `bucketHead`. */
  private readonly buckets = new Float32Array(32);
  private bucketHead = 0;
  private bucketCount = 0;
  /** The second being filled: all its time, and its counted frames / time. */
  private openMs = 0;
  private openCountedN = 0;
  private openCountedMs = 0;

  constructor(private readonly cfg: AutoGuardConfig = AUTO_GUARD) {
    this.ring = new Float64Array(cfg.capacity);
    const n = Math.ceil(cfg.stallMs / cfg.binMs) + 1;
    this.bins = new Uint32Array(n);
    this.binSums = new Float64Array(n);
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.totalMs = 0;
    this.countedN = 0;
    this.countedMs = 0;
    this.cpuLateN = 0;
    this.bins.fill(0);
    this.binSums.fill(0);
    this.bucketHead = 0;
    this.bucketCount = 0;
    this.openMs = 0;
    this.openCountedN = 0;
    this.openCountedMs = 0;
  }

  /**
   * Share of the last `n` seconds whose frame rate was under `fps` — among the
   * seconds with frames to judge (null when fewer than half of them have).
   */
  shareBelow(n: number, fps: number): number | null {
    const k = Math.min(n, this.bucketCount);
    let judged = 0;
    let below = 0;
    for (let i = this.bucketCount - k; i < this.bucketCount; i++) {
      const f = this.buckets[(this.bucketHead + i) % this.buckets.length];
      if (Number.isNaN(f)) continue;
      judged++;
      if (f < fps) below++;
    }
    return judged * 2 >= n && judged > 0 ? below / judged : null;
  }

  /** Focused-play time the stretch covers (ms). */
  get durationMs(): number {
    return this.totalMs;
  }

  /** Intervals counted in the frame rate (not processor-late). */
  get frames(): number {
    return this.countedN;
  }

  /** Share of the stretch's intervals the processor made late. */
  get cpuShare(): number {
    const n = this.countedN + this.cpuLateN;
    return n > 0 ? this.cpuLateN / n : 0;
  }

  /** Adds an interval; the oldest ones go while the rest still covers `spanMs`. */
  push(ms: number, cpuLate: boolean, spanMs: number): void {
    if (this.size === this.ring.length) this.dropOldest();
    const tail = (this.head + this.size) % this.ring.length;
    this.ring[tail] = cpuLate ? -ms : ms;
    this.size++;
    this.totalMs += ms;
    if (cpuLate) this.cpuLateN++;
    else {
      const b = this.bin(ms);
      this.bins[b]++;
      this.binSums[b] += ms;
      this.countedN++;
      this.countedMs += ms;
      this.openCountedN++;
      this.openCountedMs += ms;
    }
    while (this.size > 1 && this.totalMs - Math.abs(this.ring[this.head]) >= spanMs) this.dropOldest();
    // The second being filled: closed once it covers bucketMs of focused play.
    this.openMs += ms;
    if (this.openMs >= this.cfg.bucketMs) {
      const judged = this.openCountedMs * 2 >= this.openMs && this.openCountedN > 0;
      const fps = judged ? (this.openCountedN * 1000) / this.openCountedMs : NaN;
      if (this.bucketCount === this.buckets.length) {
        this.bucketHead = (this.bucketHead + 1) % this.buckets.length;
        this.bucketCount--;
      }
      this.buckets[(this.bucketHead + this.bucketCount) % this.buckets.length] = fps;
      this.bucketCount++;
      this.openMs = 0;
      this.openCountedN = 0;
      this.openCountedMs = 0;
    }
  }

  /**
   * Frames per second of the counted intervals, without the slowest `share`
   * of them (0 when none).
   */
  trimmedFps(share: number): number {
    const n = this.countedN;
    if (n === 0) return 0;
    const dropN = Math.floor(n * share);
    let left = dropN;
    let sum = this.countedMs;
    for (let b = this.bins.length - 1; b >= 0 && left > 0; b--) {
      const c = this.bins[b];
      if (c === 0) continue;
      if (c <= left) {
        sum -= this.binSums[b];
        left -= c;
      } else {
        sum -= (this.binSums[b] / c) * left;
        left = 0;
      }
    }
    return sum > 0 ? ((n - dropN) * 1000) / sum : 0;
  }

  private bin(ms: number): number {
    return Math.min(this.bins.length - 1, Math.max(0, Math.floor(ms / this.cfg.binMs)));
  }

  private dropOldest(): void {
    const v = this.ring[this.head];
    this.head = (this.head + 1) % this.ring.length;
    this.size--;
    const ms = Math.abs(v);
    this.totalMs -= ms;
    if (v < 0) this.cpuLateN--;
    else {
      const b = this.bin(ms);
      this.bins[b]--;
      this.binSums[b] -= ms;
      this.countedN--;
      this.countedMs -= ms;
    }
  }
}

/**
 *   step       — 60 FPS no longer hold: step one rung down now (then applied() / stop());
 *   keep       — the last step restored the goal: store it;
 *   keep-step  — it helped, not enough: store it and step once more (then applied() / stop());
 *   useless    — it changed nothing: the graphics are not the limit, the guard
 *                stops for the session (the step stays on screen, NOT stored).
 */
export type GuardAction = "step" | "keep" | "keep-step" | "useless";

export interface GuardVerdict {
  action: GuardAction;
  /** Delivered frame rate of the stretch just judged (trimmed, processor-late frames left out). */
  fps: number;
  /** Frame rate of the stretch that triggered the step being judged (null for a first step). */
  before: number | null;
  /** Share of the stretch's frames the processor made late. */
  cpuShare: number;
}

/**
 *   watch  — judging the last windowMs of focused play;
 *   wait   — a step was asked for: frames ignored until the host applied it;
 *   verify — the stretch after the step (followUpMs), judged against the one before;
 *   off    — done for this session (the floor, or a useless step).
 */
export type GuardPhase = "watch" | "wait" | "verify" | "off";

/** The guard of one session and one detection result (see the module comment). */
export class AutoGuard {
  private phase_: GuardPhase = "watch";
  private readonly stretch: FrameStretch;
  private lastT: number | null = null;
  private lastCpu = 0;
  /** The usual level of the render submission in focused play (ms; 0 = none seen yet — see renderFloorCreepPerS). */
  private renderFloor = 0;
  /** Focused-play time still to ignore (settling). The first frames of a session settle too. */
  private settleLeft: number;
  private sinceCheck = 0;
  /** Frame rate of the stretch that triggered the step being judged. */
  private before = 0;
  /** A step was judged useless this session: the frame rate does not follow the graphics here. */
  private deaf = false;
  /** Steps applied this session. */
  steps = 0;
  /** Focused play seen this session (ms; stalls left out). */
  playedMs = 0;

  constructor(
    /** The frame rate the promise is about: 60, or the display's rate when lower. */
    readonly goalFps: number,
    private readonly cfg: AutoGuardConfig = AUTO_GUARD,
  ) {
    this.stretch = new FrameStretch(cfg);
    this.settleLeft = cfg.resumeSettleMs;
  }

  get phase(): GuardPhase {
    return this.phase_;
  }

  /** False once done for the session. */
  get active(): boolean {
    return this.phase_ !== "off";
  }

  /**
   * A frame was rendered: `t` = its start (performance.now, ms), `cpuMs` =
   * its main-thread time, `play` = focused play (pointer locked, page
   * visible, the match running, no detection), `renderMs` = the render
   * submission within `cpuMs` (0: unknown — all of it is the processor's).
   * A verdict now and then.
   */
  onFrame(t: number, cpuMs: number, play: boolean, renderMs = 0): GuardVerdict | null {
    if (this.phase_ === "off") return null;
    if (!play) {
      // Menu, pause, end screen, hidden page: the interval across it means nothing.
      this.lastT = null;
      return null;
    }
    const prevT = this.lastT;
    const prevCpu = this.lastCpu;
    this.lastT = t;
    this.lastCpu = this.processorMs(cpuMs, renderMs, prevT === null ? 0 : Math.min(t - prevT, this.cfg.stallMs));
    if (prevT === null) {
      this.settleLeft = Math.max(this.settleLeft, this.cfg.resumeSettleMs);
      return null;
    }
    const dt = t - prevT;
    if (!(dt > 0)) return null;
    if (dt > this.cfg.stallMs) {
      this.settleLeft = Math.max(this.settleLeft, this.cfg.resumeSettleMs);
      return null;
    }
    this.playedMs += dt;
    if (this.phase_ === "wait") return null;
    if (this.settleLeft > 0) {
      this.settleLeft -= dt;
      return null;
    }
    const span = this.phase_ === "verify" ? this.cfg.followUpMs : this.cfg.windowMs;
    // The interval that ends now followed the previous frame: ITS main-thread time.
    this.stretch.push(dt, prevCpu >= this.cfg.cpuLateShare * (1000 / this.goalFps), span);
    this.sinceCheck += dt;
    if (this.sinceCheck < this.cfg.checkEveryMs) return null;
    this.sinceCheck = 0;
    return this.judge(span);
  }

  /**
   * The processor's part of a frame's main-thread time: the render submission
   * counted at its usual level (see renderFloorCreepPerS), the surplus being
   * the wait for a GPU process that fell behind. `dtMs`: time since the
   * previous frame (the level's creep).
   */
  private processorMs(cpuMs: number, renderMs: number, dtMs: number): number {
    if (!(renderMs > 0)) return cpuMs;
    let floor = this.renderFloor;
    if (floor === 0) floor = renderMs;
    else {
      floor *= 1 + this.cfg.renderFloorCreepPerS * (dtMs / 1000);
      if (renderMs < floor && renderMs >= floor * this.cfg.renderFloorOutlier) floor = renderMs;
    }
    this.renderFloor = floor;
    return cpuMs - renderMs + Math.min(renderMs, floor);
  }

  /** The asked step is on screen from the next frame: settle, then judge it. */
  applied(): void {
    if (this.phase_ !== "wait") return;
    this.steps++;
    this.phase_ = "verify";
    this.stretch.clear();
    this.settleLeft = this.cfg.stepSettleMs;
    this.sinceCheck = 0;
  }

  /** No rung left below (the floor), or the host could not step: done for this session. */
  stop(): void {
    this.phase_ = "off";
  }

  /**
   * Other values on screen between two matches (a rung tried back up): the
   * frames seen so far say nothing about them — watch afresh, after a settle
   * (also after a stop at the floor). False when a step was judged useless
   * this session: its frames do not follow the graphics, a try could not be
   * judged.
   */
  restart(): boolean {
    if (this.deaf) return false;
    this.phase_ = "watch";
    this.stretch.clear();
    this.lastT = null;
    this.settleLeft = this.cfg.resumeSettleMs;
    this.sinceCheck = 0;
    return true;
  }

  private judge(span: number): GuardVerdict | null {
    const s = this.stretch;
    if (s.durationMs < span || s.frames < this.cfg.minFrames) return null;
    const cpuShare = s.cpuShare;
    // The processor's stretch: lowering the graphics would not change it — no verdict.
    if (cpuShare > this.cfg.maxCpuShare) return null;
    const fps = s.trimmedFps(this.cfg.trimShare);
    const line = this.goalFps * this.cfg.holdRatio;
    const lowSeconds = s.shareBelow(Math.round(span / this.cfg.bucketMs), line);
    if (lowSeconds === null) return null; // mostly the processor's seconds: no verdict
    // Short of the goal = on average (lone hitches trimmed) AND for most of the stretch (not a burst).
    const holds = fps >= line || lowSeconds < this.cfg.sustainShare;
    if (this.phase_ === "watch") {
      if (holds) return null;
      this.before = fps;
      this.phase_ = "wait";
      return { action: "step", fps, before: null, cpuShare };
    }
    // verify
    const before = this.before;
    if (holds) {
      this.phase_ = "watch";
      s.clear();
      return { action: "keep", fps, before, cpuShare };
    }
    if (fps >= before * (1 + this.cfg.minGain)) {
      this.before = fps;
      this.phase_ = "wait";
      return { action: "keep-step", fps, before, cpuShare };
    }
    this.phase_ = "off";
    this.deaf = true;
    return { action: "useless", fps, before, cpuShare };
  }
}

/**
 * The rung the guard steps to from the values on screen: the first one
 * down the ladder (no costlier in any knob) that is cheaper in a knob that
 * really moves the frame time (resolution, anti-aliasing, a live shadow
 * map — cheaperPerFrame), the finer rungs above it (filtering, snow
 * density: ≈ 1-3 % each, a step of them alone would cost another stretch of
 * missed frames for a gain lost in the noise) taken with it. Only fine
 * knobs left: the floor. Null at the floor: nothing below.
 */
export function guardStepIndex(ladder: readonly GraphicsValues[], current: GraphicsValues): number | null {
  let lowest: number | null = null;
  for (let j = 0; j < ladder.length; j++) {
    const r = ladder[j];
    if (!noCostlier(r, current) || sameValues(r, current)) continue;
    if (cheaperPerFrame(r, current)) return j;
    lowest = j;
  }
  return lowest;
}

/**
 * The rung ONE step back up from `current`, never above `detected` (the
 * detection's own answer): the best rung (lowest index, from `detected` on)
 * whose own step down lands on `current` — the exact undo of one guard step,
 * fine knobs included. Null when `current` is not below `detected` on this
 * ladder (nothing to climb back to).
 */
export function guardUpIndex(ladder: readonly GraphicsValues[], current: GraphicsValues, detected: GraphicsValues): number | null {
  const c = ladder.findIndex((v) => sameValues(v, current));
  const d = ladder.findIndex((v) => sameValues(v, detected));
  if (c < 0 || d < 0 || d >= c) return null;
  for (let k = d; k < c; k++) if (guardStepIndex(ladder, ladder[k]) === c) return k;
  return c - 1;
}

/** Wait before the next try one step up, after `fails` failed tries in a row (20 h, 40 h, 80 h… a month at most). */
export function retryDelay(fails: number, cfg: AutoGuardConfig = AUTO_GUARD): number {
  return Math.min(cfg.retryMaxMs, cfg.retryAfterMs * 2 ** Math.max(0, Math.min(16, fails)));
}

type GuardRecord = Pick<AutoResult, "guardSteps" | "guardPower" | "guardRetryAt" | "detected">;

/**
 * Power state of the step on top of a result's kept steps — the one a try
 * one rung up undoes. `guardPower` lists the most recent steps (its last
 * entry = the top); steps kept before power awareness have none: "unknown".
 */
export function topStepPower(r: GuardRecord): PowerState {
  const p = r.guardPower;
  return (r.guardSteps ?? 0) > 0 && p && p.length > 0 ? p[p.length - 1] : "unknown";
}

/**
 * Why a try one rung back up is due for a stored result, or null:
 *   power     — the step on top was taken on battery and the laptop is on
 *               its charger now: at once (no wait);
 *   scheduled — the wait after the last step or failed try is over.
 */
export function retryReason(r: GuardRecord, power: PowerState, now: number): "power" | "scheduled" | null {
  if (!r.detected || (r.guardSteps ?? 0) <= 0) return null;
  if (power === "mains" && topStepPower(r) === "battery") return "power";
  return r.guardRetryAt != null && now >= r.guardRetryAt ? "scheduled" : null;
}

/** The power list once one more step (taken in `power`) is kept: the most recent `steps` at most. */
export function pushStepPower(list: readonly PowerState[] | undefined, power: PowerState, steps: number): PowerState[] {
  return [...(list ?? []), power].slice(-Math.max(1, steps));
}

/** The power list once the step on top is undone (a try one rung up kept), `steps` left. */
export function popStepPower(list: readonly PowerState[] | undefined, steps: number): PowerState[] {
  return steps > 0 ? (list ?? []).slice(0, -1).slice(-steps) : [];
}

/** The power list with the step on top relabelled (a battery step that did not hold on the charger either: mains). */
export function relabelTopPower(list: readonly PowerState[] | undefined, power: PowerState): PowerState[] {
  const out = [...(list ?? [])];
  if (out.length > 0) out[out.length - 1] = power;
  return out;
}
