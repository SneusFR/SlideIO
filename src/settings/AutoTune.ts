import {
  ANISOTROPY_LEVELS,
  FLOOR,
  SHADOW_QUALITIES,
  floorRenderScale,
  isMsaa,
  sameValues,
  type AntiAliasing,
  type Anisotropy,
  type DisplayEnv,
  type GraphicsCaps,
  type GraphicsValues,
  type ShadowQuality,
} from "./GraphicsSettings";
import { describeValues, frNumber } from "./labels";

/**
 * AUTOMATIC DETECTION — pure logic, fed with the frames the game renders.
 *
 * Measured on the REAL map (the menu's live view, or the pause view), with
 * FRAME INTERVALS as the signal: the time between two rendered frames under
 * the very load being judged. GPU timer queries are not used — on the
 * laptop's Iris Xe a query around a whole frame also counts the GPU's idle
 * gaps and makes Chrome flush (it changes what it measures), and per-draw
 * queries inflate the small operations (PERFORMANCE.md, 11th pass).
 *
 * 1. A LADDER of complete configurations, from the best this map shows
 *    (rung 0: native resolution, MSAA 4×, the sharpest shadows, 16×
 *    filtering) down to the BEAUTY FLOOR (last rung: the old LOW look). Each
 *    rung removes the next least visible cost: the doubled shadow map, 16× →
 *    8× filtering, MSAA 4× → 2×, … then FXAA, then the resolution in small
 *    steps down to one pixel per CSS pixel. Only settings the session
 *    applies LIVE move (no shader compile, no reload).
 * 2. The floor is measured first: does this machine reach the target at all?
 *    If not, the same view at half its pixels tells the graphics card (much
 *    faster with fewer pixels: the floor is the answer) from the processor
 *    or the browser (no faster: the graphics are not the limit — the search
 *    then only has to keep the frame rate the floor reached).
 * 3. A rung HOLDS when its frames keep the goal WITH MARGIN: it is measured
 *    with 30 % more pixels than it really draws (render scale × √1.3) — a
 *    vsync-locked display shows 60 FPS at 10 ms and at 16 ms of work alike;
 *    with that load on top, a rung that still holds 60 keeps ≈ 23 % of the
 *    frame free for the fights (8 bots, effects, the HUD's own drawing).
 * 4. The top rung first (strong machines answer in one probe), then a binary
 *    search over the rest. One answer, stored: the detection never runs
 *    again by itself on the same machine and map (it never oscillates), and
 *    the player can always override it.
 */

/** Every threshold of the detection, with its reason. */
export const AUTO_TUNE = {
  /** A probe draws this many times the candidate's pixels (≈ +14 % per axis): the margin. */
  marginPixels: 1.3,
  /** A probe holds a frame rate when its median frame interval reaches 97 % of it… */
  holdRatio: 0.97,
  /** …with at most 4 % of its frames late by half a frame or more (one missed refresh in 25). */
  lateFactor: 1.5,
  maxLateShare: 0.04,
  /** Frames ignored after applying a candidate: render-target allocation, shadow re-bake, uploads. */
  settleFrames: 8,
  settleMs: 300,
  /** A probe measures at least this many frames over at least this time… */
  minFrames: 40,
  minMs: 800,
  /** …at most this long (slow machines), with at least minFramesHard frames. */
  maxMs: 2500,
  minFramesHard: 10,
  /** Whole detection: hard stop on FOCUSED time (the best known rung is kept). */
  maxFocusedMs: 30000,
  /** Floor at half its pixels this much faster = the graphics card is the limit. */
  gpuBoundGain: 1.12,
  /** Processor-limited machine: a rung holds while it keeps this share of the floor's frame rate. */
  cpuBoundKeep: 0.95,
  /** Highest render scale a margin probe draws (%), and the scale of the half-pixel check's lowest. */
  maxProbeScale: 200,
  minProbeScale: 25,
  /** Frame intervals kept per probe (240 Hz × 2.5 s fits). */
  maxSamples: 1024,
  /** Slowest share of a probe's frames left out of its frame rate (lone hitches: 1 at least). */
  outlierShare: 0.02,
};

export type AutoTuneConfig = typeof AUTO_TUNE;

const qRank = (q: ShadowQuality): number => SHADOW_QUALITIES.indexOf(q);
const minQuality = (q: ShadowQuality, cap: ShadowQuality): ShadowQuality => (qRank(q) > qRank(cap) ? cap : q);
const minAniso = (a: Anisotropy, cap: Anisotropy): Anisotropy => (a > cap ? cap : a);

/** Highest anisotropy level the GPU really applies (three clamps above it). */
export function topAnisotropy(maxAnisotropy: number): Anisotropy {
  let best: Anisotropy = 1;
  for (const a of ANISOTROPY_LEVELS) if (a <= maxAnisotropy) best = a;
  return best;
}

/**
 * The ladder, best first, floor last. `boot` = the values the session runs
 * with: its shadow mode and character shadows (and, without a post chain, its
 * MSAA) are kept on every rung — they only change at a reload.
 */
export function buildLadder(boot: GraphicsValues, env: DisplayEnv, caps: GraphicsCaps): GraphicsValues[] {
  const floorScale = floorRenderScale(env);
  const shadowsOn = caps.shadows && boot.shadows !== "off";
  const dynamic = shadowsOn && boot.shadows === "dynamic";
  const topAa: AntiAliasing = caps.composer
    ? caps.maxSamples >= 4
      ? "msaa4"
      : caps.maxSamples >= 2
        ? "msaa2"
        : FLOOR.antialiasing
    : boot.antialiasing;
  // Static shadows are baked once: their size costs no time per frame — the
  // old HIGH size on every rung (the ultra tier, 4× the memory, only by hand).
  // Live shadows are re-rendered every frame: from the GPU's best down to the
  // old LOW size.
  const topShadow: ShadowQuality = !shadowsOn
    ? boot.shadowQuality
    : dynamic
      ? caps.maxShadowQuality
      : minQuality(caps.maxShadowQuality, "high");
  let v: GraphicsValues = {
    ...boot,
    renderScale: 100,
    antialiasing: topAa,
    shadowQuality: topShadow,
    snow: caps.snow ? "normale" : boot.snow,
    halos: caps.halos ? true : boot.halos,
    footprints: caps.footprints ? true : boot.footprints,
    particles: "normal",
    anisotropy: caps.anisotropicTextures ? topAnisotropy(caps.maxAnisotropy) : boot.anisotropy,
  };
  const ladder: GraphicsValues[] = [v];
  const push = (next: GraphicsValues | null): void => {
    if (!next || sameValues(next, v)) return;
    v = next;
    ladder.push(v);
  };
  const aniso = (cap: Anisotropy): Anisotropy => (caps.anisotropicTextures ? minAniso(v.anisotropy, cap) : v.anisotropy);
  const shadowAtMost = (cap: ShadowQuality): ShadowQuality => (dynamic ? minQuality(v.shadowQuality, cap) : v.shadowQuality);

  // Nearly invisible: the doubled live shadow map, 16× → 8× filtering.
  push({ ...v, shadowQuality: shadowAtMost("high") });
  push({ ...v, anisotropy: aniso(8) });
  // Edges: MSAA 4× → 2× (half the multisampled memory traffic).
  push(caps.composer && v.antialiasing === "msaa4" ? { ...v, antialiasing: "msaa2" } : null);
  // Grazing-angle sharpness and the old LOW size of the live shadow map.
  push({ ...v, anisotropy: aniso(4), shadowQuality: shadowAtMost(FLOOR.shadowQuality) });
  // FXAA instead of MSAA: softer edges, the big win on integrated GPUs.
  push(caps.composer && isMsaa(v.antialiasing) ? { ...v, antialiasing: FLOOR.antialiasing } : null);
  push({ ...v, anisotropy: aniso(2) });
  push({ ...v, anisotropy: aniso(FLOOR.anisotropy), snow: caps.snow && v.snow === "normale" ? FLOOR.snow : v.snow });
  // Then pixels, in small steps, down to one pixel per CSS pixel.
  for (const s of [90, 85, 80, 75, 70, 65, 60, 55, 50]) push({ ...v, renderScale: Math.max(floorScale, s) });
  return ladder;
}

/** The candidate drawn with the margin's extra pixels. */
export function withMargin(values: GraphicsValues, cfg: AutoTuneConfig = AUTO_TUNE): GraphicsValues {
  return { ...values, renderScale: Math.min(cfg.maxProbeScale, values.renderScale * Math.sqrt(cfg.marginPixels)) };
}

/** The same view at half its pixels (processor or graphics card?). */
export function halfPixels(values: GraphicsValues, cfg: AutoTuneConfig = AUTO_TUNE): GraphicsValues {
  return { ...values, renderScale: Math.max(cfg.minProbeScale, values.renderScale * Math.SQRT1_2) };
}

// ------------------------------------------------------------- verdicts

/** Measurements of one probe. */
export interface ProbeStats {
  frames: number;
  /**
   * Frames per second DELIVERED: frames / time (the mean interval). Not the
   * median: with vsync, intervals are whole refresh periods (16.7 / 33.3 ms
   * at 60 Hz, 4.2 / 8.3 ms at 240 Hz) — a fifth of the frames missing their
   * refresh leaves the median on the display's rate while the player gets
   * 20 % fewer images.
   */
  fps: number;
  /** Median frame interval (ms). */
  frameMs: number;
  /** Mean main-thread time of a frame (game JS + render submission, ms). */
  cpuMs: number;
  /** The intervals themselves (sorted), for the late share of any goal. */
  sorted: Float64Array;
}

/** Share of the frames later than `lateFactor` frame budgets of `goalFps`. */
export function lateShare(stats: ProbeStats, goalFps: number, cfg: AutoTuneConfig = AUTO_TUNE): number {
  const limit = (1000 / goalFps) * cfg.lateFactor;
  const s = stats.sorted;
  if (s.length === 0) return 1;
  let i = s.length;
  while (i > 0 && s[i - 1] > limit) i--;
  return (s.length - i) / s.length;
}

/** The probe keeps `goalFps`: frame rate within 3 %, few late frames (no stutter). */
export function holds(stats: ProbeStats, goalFps: number, cfg: AutoTuneConfig = AUTO_TUNE): boolean {
  return stats.frames > 0 && stats.fps >= goalFps * cfg.holdRatio && lateShare(stats, goalFps, cfg) <= cfg.maxLateShare;
}

/**
 * Frames, delivered frame rate and median interval of a probe's sorted
 * intervals. The slowest `outlierShare` of them (one at least) are left out
 * of the frame rate: a lone hitch (garbage collection, an upload) is not
 * the cost of the settings — a config that misses refreshes misses many.
 */
export function deliveredStats(sorted: Float64Array, cfg: AutoTuneConfig = AUTO_TUNE): { frames: number; fps: number; frameMs: number } {
  const n = sorted.length;
  if (n === 0) return { frames: 0, fps: 0, frameMs: 0 };
  const drop = n > 4 ? Math.max(1, Math.floor(n * cfg.outlierShare)) : 0;
  let total = 0;
  for (let i = 0; i < n - drop; i++) total += sorted[i];
  return { frames: n, fps: total > 0 ? ((n - drop) * 1000) / total : 0, frameMs: sortedPercentile(sorted, 0.5) };
}

/** Median / percentile of a sorted array. */
export function sortedPercentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1) + 0.5)))];
}

// ---------------------------------------------------------- calibration

export type TuneMode = "target" | "cpu" | "gpu";

export interface TuneOutcome {
  values: GraphicsValues;
  /** Rung index in the ladder. */
  index: number;
  /** target = the target holds at the answer; cpu = processor / browser-limited; gpu = even the floor misses (graphics card). */
  mode: TuneMode;
  /** Frame rate the rungs had to keep (the target, or what the floor reached when processor-limited). */
  goalFps: number;
  /** Frame rate seen at the floor (raw), and at the answer's probe (with the margin), null when not measured. */
  floorFps: number | null;
  answerFps: number | null;
  probes: number;
  /** False when stopped before the end (time limit): the answer is the best KNOWN rung. */
  complete: boolean;
}

/** What the calibration needs from the game. */
export interface CalibrationHost {
  /** Apply a candidate live (resolution, anti-aliasing, shadow size, snow…). */
  apply(values: GraphicsValues): void;
}

type Phase = "idle" | "floor" | "cpucheck" | "top" | "search" | "done";

interface Probe {
  /** Rung index (-1 = the half-pixel check). */
  index: number;
  values: GraphicsValues;
  appliedAt: number;
  seen: number;
  measuring: boolean;
  startedAt: number;
  lastT: number;
  count: number;
  cpuSum: number;
}

/**
 * Drives the probes from the rendered frames (no timers): the Game calls
 * onFrame() after each frame it renders. Candidates are applied through the
 * host. Frames of an unfocused or hidden window restart the probe (a laptop
 * runs much slower in the background: they would judge the wrong machine).
 */
export class Calibration {
  private phase: Phase = "idle";
  private probe: Probe | null = null;
  private readonly intervals: Float64Array;
  private lo = 0;
  private hi: number;
  private goal: number;
  private mode: TuneMode = "target";
  private floorFps: number | null = null;
  private answerFps: number | null = null;
  private probes = 0;
  private focusedMs = 0;
  private lastFrameT: number | null = null;
  private result: TuneOutcome | null = null;
  /** Probe results by rung (tests, summary). */
  readonly measured = new Map<number, ProbeStats>();

  constructor(
    private readonly host: CalibrationHost,
    readonly ladder: readonly GraphicsValues[],
    readonly targetFps: number,
    private readonly cfg: AutoTuneConfig = AUTO_TUNE,
  ) {
    if (ladder.length === 0) throw new Error("Calibration: empty ladder");
    this.hi = ladder.length - 1;
    this.goal = targetFps;
    this.intervals = new Float64Array(cfg.maxSamples);
  }

  get done(): boolean {
    return this.phase === "done";
  }

  get outcome(): TuneOutcome | null {
    return this.result;
  }

  /** Progress for the page: probes done / expected, the candidate on screen. */
  get progress(): { done: number; total: number; values: GraphicsValues | null } {
    if (this.phase === "done") return { done: this.probes, total: this.probes, values: null };
    const searchLeft = this.hi > this.lo ? Math.ceil(Math.log2(this.hi - this.lo + 1)) : 0;
    let left: number;
    switch (this.phase) {
      case "idle":
      case "floor":
        left = 2 + Math.ceil(Math.log2(Math.max(1, this.ladder.length - 1)));
        break;
      case "cpucheck":
        left = 2 + Math.ceil(Math.log2(Math.max(1, this.ladder.length - 1)));
        break;
      case "top":
        left = 1 + searchLeft;
        break;
      default:
        left = Math.max(1, searchLeft);
    }
    return { done: this.probes, total: this.probes + Math.max(1, left), values: this.probe?.values ?? null };
  }

  start(now: number): void {
    if (this.phase !== "idle") return;
    this.phase = "floor";
    this.begin(this.ladder.length - 1, this.ladder[this.ladder.length - 1], now);
  }

  /**
   * A frame was rendered: `t` = its start (performance.now, ms), `cpuMs` =
   * its main-thread time, `focused` = the window had the focus and was
   * visible.
   */
  onFrame(t: number, cpuMs: number, focused: boolean): void {
    const p = this.probe;
    if (!p || this.phase === "done") return;
    const prev = this.lastFrameT;
    this.lastFrameT = t;
    if (!focused) {
      // Background / hidden window: this probe starts over once focused again.
      this.restart(p, t);
      return;
    }
    if (prev !== null) this.focusedMs += Math.min(250, t - prev);
    if (this.focusedMs > this.cfg.maxFocusedMs) {
      this.finish(false);
      return;
    }
    p.seen++;
    if (!p.measuring) {
      if (p.seen <= this.cfg.settleFrames || t - p.appliedAt < this.cfg.settleMs) return;
      p.measuring = true;
      p.startedAt = t;
      p.lastT = t;
      p.count = 0;
      p.cpuSum = cpuMs;
      return;
    }
    if (p.count < this.intervals.length) this.intervals[p.count++] = t - p.lastT;
    p.lastT = t;
    p.cpuSum += cpuMs;
    const elapsed = t - p.startedAt;
    const enough =
      (p.count >= this.cfg.minFrames && elapsed >= this.cfg.minMs) ||
      (elapsed >= this.cfg.maxMs && p.count >= this.cfg.minFramesHard) ||
      p.count >= this.intervals.length;
    if (enough) this.complete(p, t);
  }

  /** Stop now: the best rung known so far (the bound of the search). Null when nothing was measured. */
  cancel(): TuneOutcome | null {
    if (this.phase !== "done") this.finish(false);
    return this.result;
  }

  private restart(p: Probe, t: number): void {
    p.appliedAt = t;
    p.seen = 0;
    p.measuring = false;
    p.count = 0;
    p.cpuSum = 0;
  }

  private begin(index: number, values: GraphicsValues, now: number): void {
    this.probe = { index, values, appliedAt: now, seen: 0, measuring: false, startedAt: now, lastT: now, count: 0, cpuSum: 0 };
    this.host.apply(values);
  }

  private statsOf(p: Probe): ProbeStats {
    const sorted = this.intervals.slice(0, p.count).sort();
    return { ...deliveredStats(sorted, this.cfg), cpuMs: p.cpuSum / Math.max(1, p.count + 1), sorted };
  }

  /** The rung keeps the goal: the target itself, or (processor-limited) what the floor reached. */
  private keeps(stats: ProbeStats): boolean {
    if (this.mode === "cpu") return stats.frames > 0 && stats.fps >= this.goal;
    return holds(stats, this.goal, this.cfg);
  }

  private complete(p: Probe, now: number): void {
    this.probes++;
    const stats = this.statsOf(p);
    this.measured.set(p.index, stats);
    const last = this.ladder.length - 1;
    switch (this.phase) {
      case "floor": {
        this.floorFps = stats.fps;
        if (holds(stats, this.targetFps, this.cfg)) {
          this.mode = "target";
          this.goal = this.targetFps;
          this.answerFps = stats.fps;
          this.startTop(now);
        } else {
          // Not even the floor: below the target either way (graphics card
          // until the half-pixel check says otherwise).
          this.mode = "gpu";
          this.phase = "cpucheck";
          this.begin(-1, halfPixels(this.ladder[last], this.cfg), now);
        }
        return;
      }
      case "cpucheck": {
        const floor = this.floorFps ?? 0;
        if (stats.fps >= floor * this.cfg.gpuBoundGain) {
          // Fewer pixels, many more frames: the graphics card is the limit,
          // and even the floor misses the target — the floor is the answer.
          this.mode = "gpu";
          this.goal = this.targetFps;
          this.answerFps = floor;
          this.lo = this.hi = last;
          this.finish(true);
        } else {
          // The frame rate does not follow the pixels: processor / browser.
          this.mode = "cpu";
          this.goal = floor * this.cfg.cpuBoundKeep;
          this.answerFps = floor;
          this.startTop(now);
        }
        return;
      }
      case "top": {
        if (this.keeps(stats)) {
          this.lo = this.hi = 0;
          this.answerFps = stats.fps;
          this.finish(true);
          return;
        }
        this.lo = 1;
        this.phase = "search";
        this.next(now);
        return;
      }
      case "search": {
        if (this.keeps(stats)) {
          this.hi = p.index;
          this.answerFps = stats.fps;
        } else {
          this.lo = p.index + 1;
        }
        this.next(now);
        return;
      }
      default:
        return;
    }
  }

  private startTop(now: number): void {
    const last = this.ladder.length - 1;
    if (last === 0) {
      this.lo = this.hi = 0;
      this.finish(true);
      return;
    }
    this.phase = "top";
    this.hi = last; // the floor: known acceptable (or the best we may offer)
    this.begin(0, withMargin(this.ladder[0], this.cfg), now);
  }

  private next(now: number): void {
    if (this.lo >= this.hi) {
      this.finish(true);
      return;
    }
    const mid = Math.floor((this.lo + this.hi) / 2);
    this.begin(mid, withMargin(this.ladder[mid], this.cfg), now);
  }

  private finish(complete: boolean): void {
    this.phase = "done";
    this.probe = null;
    // Nothing measured at all (stopped during the first probe): no answer.
    if (this.floorFps === null) {
      this.result = null;
      return;
    }
    const index = this.hi;
    this.result = {
      values: this.ladder[index],
      index,
      mode: this.mode,
      goalFps: this.goal,
      floorFps: this.floorFps,
      answerFps: this.answerFps,
      probes: this.probes,
      complete,
    };
  }
}

// --------------------------------------------------------------- summary

export interface SummaryContext {
  targetFps: number;
  caps: Pick<GraphicsCaps, "composer" | "snow" | "halos" | "anisotropicTextures">;
  /** Software rendering (SwiftShader, llvmpipe, Basic Render Driver). */
  software: boolean;
}

/** The French message shown after a detection. */
export function summarize(o: TuneOutcome, ctx: SummaryContext): string {
  const desc = describeValues(o.values, ctx.caps);
  if (ctx.software) {
    return (
      "Rendu logiciel détecté : le navigateur dessine sans la carte graphique (accélération matérielle " +
      `désactivée). Réglages du plancher (${desc}) — active l'accélération matérielle du navigateur.`
    );
  }
  const partial = o.complete ? "" : " Détection interrompue : réglages prudents, elle reprendra au prochain lancement.";
  if (o.mode === "gpu") {
    const fps = o.floorFps !== null ? `environ ${Math.round(o.floorFps)} i/s` : "moins";
    return (
      `Même au plancher de qualité (${desc}), ce PC tient ${fps} au lieu de ${ctx.targetFps} : ` +
      `c'est la carte graphique qui limite. Le plancher garde un rendu propre ; tu peux descendre plus bas à la main.${partial}`
    );
  }
  if (o.mode === "cpu") {
    const fps = o.floorFps !== null ? `environ ${Math.round(o.floorFps)} i/s` : "moins que l'objectif";
    return (
      `Ce PC plafonne à ${fps} quels que soient les graphismes : c'est le processeur ou le navigateur qui limite, ` +
      `pas la carte graphique. Les graphismes restent donc beaux : ${desc}.${partial}`
    );
  }
  return (
    `Réglages choisis pour tenir ${ctx.targetFps} i/s avec ${frNumber((AUTO_TUNE.marginPixels - 1) * 100, 0)} % ` +
    `de pixels en réserve pour les combats : ${desc}.${partial}`
  );
}
