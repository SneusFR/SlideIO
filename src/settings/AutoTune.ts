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
 * AUTOMATIC DETECTION — pure logic (fed with measurements by the Game).
 *
 * 1. A LADDER of complete configurations, from the best this map can show
 *    (rung 0) down to the beauty floor (last rung). Each rung removes the
 *    next cheapest-to-see cost: dense snow, 16× filtering, the doubled shadow
 *    map, MSAA 4× → 2×, … then FXAA, then the render scale in 5-10 % steps
 *    down to the floor. Only settings the session applies LIVE move (no shader
 *    compile, no reload): the shadow mode, character shadows and effect
 *    lights stay those of the session.
 * 2. A BINARY SEARCH over the ladder (cost decreases along it): ~4-5 probes,
 *    each one rendering the real map for half a second to two seconds.
 * 3. A probe holds the target when its GPU time per frame (timer queries)
 *    stays under 80 % of the frame budget — or, without timer queries, when
 *    its frames come at the target rate (then one more rung is taken as the
 *    margin the GPU time would have given).
 * The result is one rung: never oscillating, never under the floor, always
 * overridable by the player.
 */

/**
 * Every threshold of the detection, with its reason. Tuned on the headless
 * bench only for the LOGIC (software rendering): the numbers come from the
 * frame-budget reasoning below, to be confirmed on real machines.
 */
export const AUTO_TUNE = {
  /**
   * Share of the frame budget the GPU may use at the measured view. The
   * calibration view (menu orbit, pause) is lighter than a fight (8 bots,
   * effects, the HUD's own raster on the same GPU): 20 % headroom.
   */
  gpuBudget: 0.8,
  /** No GPU timer: the median frame must come within 8 % of the target interval (vsync jitter). */
  frameSlack: 1.08,
  /** … and the slowest 10 % within 45 % (one missed refresh in ten at most). */
  frameP90Slack: 1.45,
  /** Main-thread share of a frame from which the processor is the limit (graphics barely matter). */
  cpuBound: 0.85,
  /** Frames ignored after applying a candidate: render-target allocation, re-bake, texture upload. */
  settleFrames: 4,
  settleMs: 150,
  /** A probe measures at least this many frames over at least this time … */
  minFrames: 18,
  minMs: 450,
  /** … at most this long (slow machines), with at least minFramesHard frames. */
  maxMs: 2200,
  minFramesHard: 4,
  /** GPU samples needed to judge on GPU time (they arrive a few frames late). */
  minGpuFrames: 8,
  /** Whole detection: hard stop (the best known rung is kept). */
  maxTotalMs: 15000,
  /** Supersampling is only tried when the best rung uses less than this share of the frame (GPU timer). */
  supersampleGpuBudget: 0.35,
  supersampleScale: 125,
  /** Without GPU timer, rungs taken under the best one that held the rate (headroom). */
  noTimerMarginRungs: 1,
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
 * The ladder, best first. `boot` = the values the session runs with: its
 * shadow mode, character shadows, effect lights (and, without a post chain,
 * its MSAA) are kept on every rung.
 */
export function buildLadder(boot: GraphicsValues, env: DisplayEnv, caps: GraphicsCaps): GraphicsValues[] {
  const floorScale = floorRenderScale(env);
  const shadowsOn = caps.shadows && boot.shadows !== "off";
  const topAa: AntiAliasing = caps.composer
    ? caps.maxSamples >= 4
      ? "msaa4"
      : caps.maxSamples >= 2
        ? "msaa2"
        : "fxaa"
    : boot.antialiasing;
  let v: GraphicsValues = {
    ...boot,
    renderScale: Math.max(floorScale, 100),
    antialiasing: topAa,
    shadowQuality: shadowsOn ? caps.maxShadowQuality : boot.shadowQuality,
    snow: caps.snow ? "dense" : boot.snow,
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
  const scaleTo = (s: number): number => Math.max(floorScale, Math.min(v.renderScale, s));
  const aniso = (cap: Anisotropy): Anisotropy => (caps.anisotropicTextures ? minAniso(v.anisotropy, cap) : v.anisotropy);

  // Invisible or nearly: the flakes past "normale", 16× → 8× filtering, the doubled shadow map.
  push(caps.snow && v.snow === "dense" ? { ...v, snow: "normale" } : null);
  push({ ...v, anisotropy: aniso(8) });
  push(shadowsOn ? { ...v, shadowQuality: minQuality(v.shadowQuality, "high") } : null);
  // Edges: MSAA 4× → 2× (half the multisampled memory traffic).
  push(caps.composer && v.antialiasing === "msaa4" && caps.maxSamples >= 2 ? { ...v, antialiasing: "msaa2" } : null);
  // Grazing-angle sharpness and the old LOW shadow size.
  push({ ...v, anisotropy: aniso(4), shadowQuality: shadowsOn ? minQuality(v.shadowQuality, "medium") : v.shadowQuality });
  // FXAA instead of MSAA: softer edges, the big win on integrated GPUs.
  push(caps.composer && isMsaa(v.antialiasing) ? { ...v, antialiasing: FLOOR.antialiasing } : null);
  // Then pixels, in small steps, with the cheapest leftovers in between.
  push({ ...v, renderScale: scaleTo(90) });
  push({ ...v, snow: caps.snow && v.snow === "normale" ? FLOOR.snow : v.snow, anisotropy: aniso(2) });
  push({ ...v, renderScale: scaleTo(85), anisotropy: aniso(FLOOR.anisotropy) });
  push({ ...v, renderScale: scaleTo(80), particles: FLOOR.particles });
  // High-DPI screens: the floor is lower (one pixel per CSS pixel, see floorRenderScale).
  for (const s of [75, 70, 65, 60, 55, 50]) push({ ...v, renderScale: scaleTo(s) });
  return ladder;
}

/** Supersampling candidate above rung 0 (null when the slider cannot go there). */
export function supersampleRung(top: GraphicsValues, cfg: AutoTuneConfig = AUTO_TUNE): GraphicsValues | null {
  return top.renderScale >= cfg.supersampleScale ? null : { ...top, renderScale: cfg.supersampleScale };
}

// ------------------------------------------------------------- verdicts

/** Measurements of one probe (medians over its frames). */
export interface ProbeStats {
  frames: number;
  /** Median interval between rendered frames (ms). */
  frameMs: number;
  /** 90th percentile of the intervals (ms). */
  frameP90: number;
  /** Median main-thread time of the frame (game JS + render submission, ms). */
  cpuMs: number;
  /** Median GPU execution time (timer queries), null without enough samples. */
  gpuMs: number | null;
  gpuFrames: number;
}

export interface Verdict {
  fits: boolean;
  /** The frame misses the target while the GPU has room: processor / browser limited. */
  cpuBound: boolean;
  frameMs: number;
  cpuMs: number;
  gpuMs: number | null;
  /** Frames per second seen during the probe. */
  fps: number;
}

export function judge(stats: ProbeStats, budgetMs: number, cfg: AutoTuneConfig = AUTO_TUNE): Verdict {
  const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
  const base = { frameMs: stats.frameMs, cpuMs: stats.cpuMs, gpuMs: stats.gpuMs, fps };
  if (stats.gpuMs !== null) {
    const fits = stats.gpuMs <= budgetMs * cfg.gpuBudget;
    return { ...base, fits, cpuBound: fits && stats.frameMs > budgetMs * cfg.frameSlack };
  }
  const slow = stats.frameMs > budgetMs * cfg.frameSlack;
  // Without GPU timer: a main thread busy for (nearly) the whole frame is the limit — lowering the
  // graphics would not bring the frames back, so the rung is accepted as far as the GPU goes.
  const cpuBound = slow && stats.cpuMs >= stats.frameMs * cfg.cpuBound;
  const holds = !slow && stats.frameP90 <= budgetMs * cfg.frameP90Slack;
  return { ...base, fits: holds || cpuBound, cpuBound };
}

/** Median / percentile of a sample list (sorted copy). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))];
}

// --------------------------------------------------------------- search

/**
 * Binary search for the BEST rung (lowest index) that holds the target, cost
 * decreasing with the index. The rung it ends on always has a verdict.
 */
export class LadderSearch {
  private lo = 0;
  private hi: number;
  readonly verdicts = new Map<number, Verdict>();

  constructor(readonly size: number) {
    this.hi = Math.max(0, size - 1);
  }

  /** Next rung to measure, null once the answer is known. */
  next(): number | null {
    if (this.lo >= this.hi) return this.verdicts.has(this.hi) ? null : this.hi;
    return Math.floor((this.lo + this.hi) / 2);
  }

  report(index: number, verdict: Verdict): void {
    this.verdicts.set(index, verdict);
    if (verdict.fits) this.hi = Math.min(this.hi, index);
    else this.lo = Math.max(this.lo, index + 1);
    // Even the floor misses: the answer is the floor.
    if (this.lo > this.hi) this.lo = this.hi;
  }

  /** Best rung known (or assumed — the floor) to hold the target. */
  get answer(): number {
    return this.hi;
  }

  /** Estimated probes left (progress bar). */
  get remaining(): number {
    const span = this.hi - this.lo + 1;
    return span <= 1 ? (this.verdicts.has(this.hi) ? 0 : 1) : Math.ceil(Math.log2(span)) + 1;
  }
}

// ---------------------------------------------------------- calibration

export interface TuneOutcome {
  values: GraphicsValues;
  /** Rung index (-1 = supersampling above the ladder). */
  index: number;
  verdict: Verdict | null;
  probes: number;
  /** False when stopped before the end (best known rung kept). */
  complete: boolean;
  limitedBy: "gpu" | "cpu" | "none";
  belowTarget: boolean;
  usedGpuTimer: boolean;
}

/** What the calibration needs from the game. */
export interface CalibrationHost {
  /** Apply a candidate live (resolution, anti-aliasing, shadow size, snow…). */
  apply(values: GraphicsValues): void;
  /** True while GPU timer results can arrive. */
  gpuTimerAlive(): boolean;
}

interface Probe {
  index: number;
  values: GraphicsValues;
  appliedAt: number;
  seen: number;
  measuring: boolean;
  startedAt: number;
  lastT: number | null;
  intervals: number[];
  cpu: number[];
  tags: Set<number>;
  gpu: number[];
}

/**
 * Drives the probes from the rendered frames (no timers): the Game calls
 * onFrame() after each frame it renders and onGpu() when that frame's GPU time
 * arrives. Rungs are applied through the host.
 */
export class Calibration {
  private readonly search: LadderSearch;
  private probe: Probe | null = null;
  private phase: "idle" | "search" | "supersample" | "done" = "idle";
  private startedAt = 0;
  private probes = 0;
  private supersampleVerdict: Verdict | null = null;
  private usedGpu = false;
  private result: TuneOutcome | null = null;

  constructor(
    private readonly host: CalibrationHost,
    readonly ladder: readonly GraphicsValues[],
    private readonly budgetMs: number,
    private readonly supersample: GraphicsValues | null,
    private readonly cfg: AutoTuneConfig = AUTO_TUNE,
  ) {
    this.search = new LadderSearch(ladder.length);
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
    const left = this.phase === "supersample" ? 1 : Math.max(1, this.search.remaining);
    return { done: this.probes, total: this.probes + left, values: this.probe?.values ?? null };
  }

  start(now: number): void {
    if (this.phase !== "idle") return;
    this.phase = "search";
    this.startedAt = now;
    const first = this.search.next();
    if (first === null) this.finish(true);
    else this.begin(first, this.ladder[first], now);
  }

  /** A frame was rendered: `t` = its start (ms), `cpuMs` = its main-thread time, `tag` = its GPU timer tag. */
  onFrame(t: number, cpuMs: number, tag: number): void {
    const p = this.probe;
    if (!p || this.phase === "done") return;
    if (t - this.startedAt > this.cfg.maxTotalMs) {
      this.finish(false);
      return;
    }
    p.seen++;
    if (!p.measuring) {
      if (p.seen <= this.cfg.settleFrames || t - p.appliedAt < this.cfg.settleMs) return;
      p.measuring = true;
      p.startedAt = t;
      p.lastT = t;
      p.tags.add(tag);
      p.cpu.push(cpuMs);
      return;
    }
    if (p.lastT !== null) p.intervals.push(t - p.lastT);
    p.lastT = t;
    p.cpu.push(cpuMs);
    p.tags.add(tag);
    const elapsed = t - p.startedAt;
    const frames = p.intervals.length;
    const gpuWanted = this.host.gpuTimerAlive();
    const enough =
      (frames >= this.cfg.minFrames && elapsed >= this.cfg.minMs && (!gpuWanted || p.gpu.length >= this.cfg.minGpuFrames)) ||
      (elapsed >= this.cfg.maxMs && frames >= this.cfg.minFramesHard);
    if (enough) this.complete(p, t);
  }

  /** GPU time of a tagged frame (null = disjoint: dropped). */
  onGpu(tag: number, ms: number | null): void {
    const p = this.probe;
    if (!p || ms === null || !p.tags.has(tag)) return;
    p.gpu.push(ms);
  }

  /** Stop now: the best rung known so far (the conservative bound of the search). */
  cancel(): TuneOutcome {
    if (this.phase !== "done") this.finish(false);
    return this.result!;
  }

  private begin(index: number, values: GraphicsValues, now: number): void {
    this.probe = {
      index,
      values,
      appliedAt: now,
      seen: 0,
      measuring: false,
      startedAt: now,
      lastT: null,
      intervals: [],
      cpu: [],
      tags: new Set(),
      gpu: [],
    };
    this.host.apply(values);
  }

  private complete(p: Probe, now: number): void {
    this.probes++;
    const gpuMs = p.gpu.length >= this.cfg.minGpuFrames ? percentile(p.gpu, 0.5) : null;
    if (gpuMs !== null) this.usedGpu = true;
    const stats: ProbeStats = {
      frames: p.intervals.length,
      frameMs: percentile(p.intervals, 0.5),
      frameP90: percentile(p.intervals, 0.9),
      cpuMs: percentile(p.cpu, 0.5),
      gpuMs,
      gpuFrames: p.gpu.length,
    };
    const verdict = judge(stats, this.budgetMs, this.cfg);
    if (this.phase === "supersample") {
      this.supersampleVerdict = verdict;
      this.finish(true);
      return;
    }
    this.search.report(p.index, verdict);
    const next = this.search.next();
    if (next !== null) {
      this.begin(next, this.ladder[next], now);
      return;
    }
    // Strong GPU: the best rung leaves most of the frame unused → try supersampling.
    const best = this.search.verdicts.get(this.search.answer);
    const roomy =
      best !== undefined && best.fits && best.gpuMs !== null && best.gpuMs <= this.budgetMs * this.cfg.supersampleGpuBudget;
    if (this.search.answer === 0 && this.supersample && roomy) {
      this.phase = "supersample";
      this.begin(-1, this.supersample, now);
      return;
    }
    this.finish(true);
  }

  private finish(complete: boolean): void {
    this.phase = "done";
    this.probe = null;
    let index = this.search.answer;
    let verdict = this.search.verdicts.get(index) ?? null;
    if (this.supersampleVerdict?.fits && this.supersample) {
      this.result = this.outcomeOf(-1, this.supersample, this.supersampleVerdict, complete);
      return;
    }
    // No GPU timer: frames at the target rate say nothing about the headroom —
    // one rung lower (cheaper by construction, never under the floor).
    if (!this.usedGpu && verdict?.fits && !verdict.cpuBound) {
      index = Math.min(this.ladder.length - 1, index + this.cfg.noTimerMarginRungs);
      verdict = this.search.verdicts.get(index) ?? verdict;
    }
    this.result = this.outcomeOf(index, this.ladder[index], verdict, complete);
  }

  private outcomeOf(index: number, values: GraphicsValues, verdict: Verdict | null, complete: boolean): TuneOutcome {
    const below = verdict !== null && !verdict.fits;
    const limitedBy: TuneOutcome["limitedBy"] = verdict?.cpuBound ? "cpu" : below ? "gpu" : "none";
    return {
      values,
      index,
      verdict,
      probes: this.probes,
      complete,
      limitedBy,
      belowTarget: below || (verdict?.cpuBound ?? false),
      usedGpuTimer: this.usedGpu,
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
  const budget = 1000 / ctx.targetFps;
  const v = o.verdict;
  if (ctx.software) {
    return (
      "Rendu logiciel détecté : le navigateur dessine sans la carte graphique (accélération matérielle " +
      `désactivée). Réglages minimum choisis (${desc}) — active l'accélération matérielle du navigateur.`
    );
  }
  const gpu = v?.gpuMs != null ? `carte graphique : ${frNumber(v.gpuMs, 1)} ms par image sur ${frNumber(budget, 1)}` : null;
  const seen = v ? `${Math.round(v.fps)} i/s mesurées` : null;
  const detail = [gpu, seen].filter(Boolean).join(", ");
  const partial = o.complete ? "" : " (détection interrompue : réglages prudents)";
  if (o.limitedBy === "cpu") {
    return (
      `La carte graphique a de la marge : c'est le processeur ou le navigateur qui limite ` +
      `(${v ? `${frNumber(v.frameMs, 1)} ms par image` : "images lentes"}). Les graphismes restent ` +
      `donc beaux : ${desc}${partial}.`
    );
  }
  if (o.limitedBy === "gpu") {
    return (
      `Même au plancher de qualité (${desc}), ce PC tient environ ${v ? Math.round(v.fps) : "?"} i/s ` +
      `au lieu de ${ctx.targetFps} : c'est la carte graphique qui limite. Le plancher garde un rendu propre ; ` +
      `tu peux descendre plus bas à la main${partial}.`
    );
  }
  return `Réglages choisis pour tenir ${ctx.targetFps} i/s : ${desc}${detail ? ` (${detail})` : ""}${partial}.`;
}
