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
import { describeValues, formatNumber } from "./labels";

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
 * 2. The floor is measured first: which goals can this machine reach at all?
 *    If it misses one, the same view at half its pixels tells the graphics
 *    card (much faster with fewer pixels — missing 60 FPS even at the floor:
 *    the floor is the answer) from the processor or the browser (no faster:
 *    the graphics are not the limit — the searches then only have to keep
 *    the frame rate the floor reached).
 * 3. A rung HOLDS when its frames keep the goal WITH MARGIN: it is measured
 *    with 30 % more pixels than it really draws (render scale × √1.3) — a
 *    vsync-locked display shows 60 FPS at 10 ms and at 16 ms of work alike;
 *    with that load on top, a rung that still holds 60 keeps ≈ 23 % of the
 *    frame free for the fights (8 bots, effects, the HUD's own drawing). The
 *    default look (point 4) is kept with half that margin. Integrated GPUs
 *    get +50 % (see AUTO_TUNE.integratedMarginPixels: on them the margin in
 *    pixels buys less frame time, and matches run hotter than the menu).
 * 4. Two goals (TuneGoals): 60 FPS must hold — for it the image may go down
 *    to the floor; the display's rate is wanted — for it the image never goes
 *    below the DEFAULT LOOK (the old preset of this GPU): a machine that
 *    holds 60 keeps at least the look it always had.
 * 5. The top of each searched range first (strong machines answer in one
 *    probe), then a binary search. One answer, stored: the detection never
 *    runs again by itself on the same machine and map (it never
 *    oscillates), and the player can always override it.
 * 6. In matches, the AUTO GUARD (settings/AutoGuard) watches the real frames:
 *    if 60 FPS stop holding for a sustained stretch of focused play (fights,
 *    a throttled laptop, the HUD's own drawing — the detection measures with
 *    the HUD hidden), it steps this answer down the same ladder — live,
 *    stored, never back up inside a session (one rung back up is tried at
 *    the start of a later one), never below the floor.
 */

/** Every threshold of the detection, with its reason. */
export const AUTO_TUNE = {
  /** A probe draws this many times the candidate's pixels (≈ +14 % per axis): the margin. */
  marginPixels: 1.3,
  /**
   * …but the DEFAULT LOOK (the old preset of this GPU) is kept with half that
   * margin (+15 % pixels, ≈ 13 % of the frame free): the image a machine always
   * had only goes when it is clearly short, not for a borderline measure.
   */
  keepMarginPixels: 1.15,
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
  /**
   * INTEGRATED GPUs (Intel, AMD APUs, mobile chips — the old "weak" list):
   * every rung above the floor is measured with +50 % pixels instead of
   * +30 % (≈ +22 % per axis). The +30 % margin let Auto pass in the menu and
   * still miss 60 FPS in matches on the owner's Iris Xe laptops:
   *   - a good part of an iGPU frame does not scale with pixels (vertices of
   *     ~190 k map triangles, the depth clear, submission): +30 % pixels was
   *     only ≈ +15-25 % of frame time;
   *   - the menu is measured on a cool chip in its turbo window, with the
   *     main thread nearly idle (no AI, no physics) and the in-match HUD
   *     HIDDEN (menu-active, game-paused: its raster and compositing never
   *     reach a probe); a match adds bots, effects and that HUD (on the
   *     owner's laptop, before its CSS fix: 59.9 → 45 FPS at native with the
   *     same WebGL time), keeps the processor busy (processor and GPU share
   *     ONE power budget on these chips) and, minutes later, the chip settles
   *     at its sustained power (battery, office power plans: lower still);
   *   - on a 60 Hz screen, 5 % over the 16.7 ms budget already costs ≈ 3 FPS.
   * +50 % keeps ≈ 30-45 % of the frame time free in the menu's view; the
   * in-match guard (settings/AutoGuard) corrects what is left. Auto never
   * picks more than 100 % of native on any GPU (the ladder's top).
   */
  integratedMarginPixels: 1.5,
  /** …and the DEFAULT LOOK with half that margin, as on other GPUs (on iGPUs the default look is the floor). */
  integratedKeepMarginPixels: 1.25,
};

export type AutoTuneConfig = typeof AUTO_TUNE;

/**
 * The detection's thresholds for this GPU: integrated GPUs get the larger
 * margin (see AUTO_TUNE.integratedMarginPixels). `marginPercent` (the
 * `?diag=tunemarginNN` A/B switch) forces the margin to NN % extra pixels
 * (keep margin: half of it) on any GPU — `tunemargin30` = the old rule.
 */
export function tuneConfigFor(gpu: { integrated: boolean }, marginPercent: number | null = null): AutoTuneConfig {
  if (marginPercent !== null && Number.isFinite(marginPercent) && marginPercent >= 0) {
    const m = Math.min(300, marginPercent) / 100;
    return { ...AUTO_TUNE, marginPixels: 1 + m, keepMarginPixels: 1 + m / 2 };
  }
  if (!gpu.integrated) return AUTO_TUNE;
  return { ...AUTO_TUNE, marginPixels: AUTO_TUNE.integratedMarginPixels, keepMarginPixels: AUTO_TUNE.integratedKeepMarginPixels };
}

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

/** The candidate drawn with the margin's extra pixels (`pixels` = AUTO_TUNE.marginPixels by default). */
export function withMargin(values: GraphicsValues, cfg: AutoTuneConfig = AUTO_TUNE, pixels = cfg.marginPixels): GraphicsValues {
  return { ...values, renderScale: Math.min(cfg.maxProbeScale, values.renderScale * Math.sqrt(pixels)) };
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

// ---------------------------------------------------- the default look

/**
 * Index of the DEFAULT LOOK in the ladder: the first rung no costlier than
 * `look` (the old preset of this GPU: High, or Low on integrated GPUs) in
 * any knob that costs time per frame — resolution, anti-aliasing, filtering,
 * snow, and the shadow map size when it is re-rendered every frame. The
 * high-refresh goal never takes the image below it (see Calibration).
 */
export function defaultRungIndex(ladder: readonly GraphicsValues[], look: GraphicsValues): number {
  for (let i = 0; i < ladder.length; i++) if (noCostlier(ladder[i], look)) return i;
  return ladder.length - 1;
}

const AA_RANK: Record<AntiAliasing, number> = { none: 0, fxaa: 1, msaa2: 2, msaa4: 3 };
const SNOW_RANK: Record<string, number> = { off: 0, legere: 1, normale: 2, dense: 3 };

/**
 * `v` costs no more time per frame than `than` in any knob: resolution,
 * anti-aliasing, filtering, snow, and the shadow map size when it is
 * re-rendered every frame (live shadows; a static map is baked once).
 */
export function noCostlier(v: GraphicsValues, than: GraphicsValues): boolean {
  return (
    v.renderScale <= than.renderScale + 1e-6 &&
    AA_RANK[v.antialiasing] <= AA_RANK[than.antialiasing] &&
    v.anisotropy <= than.anisotropy &&
    SNOW_RANK[v.snow] <= SNOW_RANK[than.snow] &&
    (v.shadows !== "dynamic" || qRank(v.shadowQuality) <= qRank(than.shadowQuality))
  );
}

/**
 * `v` is cheaper than `than` in a knob that moves an integrated GPU's frame
 * time by several % on its own: fewer pixels, lighter anti-aliasing (MSAA
 * resolves), a smaller LIVE shadow map. Filtering and snow density alone
 * weigh ≈ 1-3 % (11th pass: snow 0.08-0.18 ms of a ~10 ms frame).
 */
export function cheaperPerFrame(v: GraphicsValues, than: GraphicsValues): boolean {
  return (
    v.renderScale < than.renderScale - 0.5 ||
    AA_RANK[v.antialiasing] < AA_RANK[than.antialiasing] ||
    (v.shadows === "dynamic" && qRank(v.shadowQuality) < qRank(than.shadowQuality))
  );
}

// ---------------------------------------------------------- calibration

/**
 * What the detection aims at. HARD: the frame rate that must hold — 60, or
 * the display's own rate when it is lower; for it, the image may go down to
 * the beauty floor. SOFT: the frame rate wanted — the display's rate (or the
 * player's target), up to 240; for it, the image never goes below the
 * DEFAULT LOOK (`defaultIndex`): a machine that holds 60 FPS keeps at least
 * the look it always had, and only trades the extras above it for a
 * high-refresh screen's frames.
 */
export interface TuneGoals {
  hard: number;
  soft: number;
  defaultIndex: number;
}

/** Goals from the target the player wants (the display's rate by default). */
export function tuneGoals(target: number, defaultIndex: number): TuneGoals {
  return { hard: Math.min(60, target), soft: target, defaultIndex };
}

/**
 *   target — the answer holds the SOFT goal (on a 60 Hz screen, soft = hard);
 *   hard   — high-refresh screen: the soft goal would need the image below
 *            the default look; the answer holds the HARD goal (60 FPS): the
 *            default look itself, or below it only when even it misses 60;
 *   cpu    — the processor / browser limits: the graphics would not change
 *            the frame rate, they stay as beautiful as the measures allow;
 *   gpu    — even the floor misses 60 FPS (graphics card): the floor.
 */
export type TuneMode = "target" | "hard" | "cpu" | "gpu";

export interface TuneOutcome {
  values: GraphicsValues;
  /** Rung index in the ladder. */
  index: number;
  /** Rung of the default look (above it = better; an index past it = the look was lowered). */
  defaultIndex: number;
  mode: TuneMode;
  /** Frame rate the answer was chosen to keep. */
  goalFps: number;
  /** Frame rate seen at the floor (raw), and at the answer's probe (with the margin), null when not measured. */
  floorFps: number | null;
  answerFps: number | null;
  /**
   * Pixels the answer was measured with, relative to what it draws: the
   * margin (1.3), the default look's (1.15), or 1 — the floor, measured as is
   * (nothing lower may be chosen: it is the answer even without a margin).
   */
  marginPixels: number;
  probes: number;
  /** False when stopped before the end (time limit): the answer is the best KNOWN rung. */
  complete: boolean;
}

/** What the calibration needs from the game. */
export interface CalibrationHost {
  /** Apply a candidate live (resolution, anti-aliasing, shadow size, snow…). */
  apply(values: GraphicsValues): void;
}

interface Probe {
  /** Rung index (-1 = the half-pixel check). */
  index: number;
  values: GraphicsValues;
  /** Margin it is drawn with (1 = as is). */
  pixels: number;
  appliedAt: number;
  seen: number;
  measuring: boolean;
  startedAt: number;
  lastT: number;
  count: number;
  cpuSum: number;
}

/**
 * One search of the ladder over [lo, hi] for the BEST (lowest) rung that keeps
 * a goal: the top of the range first (strong machines: one probe), then a
 * binary search (the cost decreases along the ladder). `hiKnown`: the range's
 * last rung is already known to keep the goal (the floor, measured first).
 */
class RangeSearch {
  best: number | null;
  /** Margin `best` was measured with (the known last rung: the floor, measured as is). */
  bestPixels = 1;
  private lo: number;
  private hi: number;
  private topDone = false;

  constructor(
    lo: number,
    hi: number,
    hiKnown: boolean,
    readonly goal: number,
    /** Processor-limited: the delivered frame rate alone (late frames are the processor's). */
    readonly relative: boolean,
    /** The default look's rung when this range contains it at an end (measured with the keep margin). */
    readonly keepIndex: number | null = null,
  ) {
    this.best = hiKnown ? hi : null;
    this.lo = lo;
    this.hi = hiKnown ? hi - 1 : hi;
  }

  /** Next rung to measure, null once the answer (or its absence) is known. */
  next(): number | null {
    if (this.lo > this.hi) return null;
    if (!this.topDone) return this.lo;
    return Math.floor((this.lo + this.hi) / 2);
  }

  report(index: number, kept: boolean, pixels: number): void {
    if (kept) this.bestPixels = pixels;
    if (!this.topDone) {
      this.topDone = true;
      if (kept) {
        this.best = index;
        this.hi = this.lo - 1; // done: nothing above the top
      } else {
        this.lo = index + 1;
      }
      return;
    }
    if (kept) {
      this.best = index;
      this.hi = index - 1;
    } else {
      this.lo = index + 1;
    }
  }

  /** Probes left at most (progress bar). */
  get remaining(): number {
    const span = this.hi - this.lo + 1;
    if (span <= 0) return 0;
    return (this.topDone ? 0 : 1) + Math.ceil(Math.log2(span + 1));
  }
}

type Stage =
  | { kind: "floor" }
  | { kind: "check" }
  | { kind: "search"; search: RangeSearch; mode: TuneMode; then: (() => void) | null };

/**
 * Drives the probes from the rendered frames (no timers): the Game calls
 * onFrame() after each frame it renders; candidates are applied through the
 * host. Frames of an unfocused or hidden window restart the probe (a laptop
 * runs much slower in the background: they would judge the wrong machine).
 *
 *   1. the floor, as is: does this machine reach the goals at all?
 *   2. if it misses one, the floor at half its pixels: much faster = the
 *      graphics card limits; not faster = the processor / browser;
 *   3. searches (top first, then binary) — SOFT goal over [top … default
 *      look]; if no rung there keeps it, HARD goal over [default look …
 *      floor]; on a 60 Hz screen, one search over the whole ladder.
 */
export class Calibration {
  private stage: Stage | null = null;
  private done_ = false;
  private probe: Probe | null = null;
  private readonly intervals: Float64Array;
  private floorStats: ProbeStats | null = null;
  private probes = 0;
  private focusedMs = 0;
  private lastFrameT: number | null = null;
  private result: TuneOutcome | null = null;
  /** Fallback answer when stopped early: the best rung known to keep a goal. */
  private known: { index: number; mode: TuneMode; goal: number; fps: number | null; pixels: number } | null = null;
  /** Probe results by rung (tests, summary). */
  readonly measured = new Map<number, ProbeStats>();
  readonly goals: TuneGoals;

  constructor(
    private readonly host: CalibrationHost,
    readonly ladder: readonly GraphicsValues[],
    goals: TuneGoals | number,
    private readonly cfg: AutoTuneConfig = AUTO_TUNE,
  ) {
    if (ladder.length === 0) throw new Error("Calibration: empty ladder");
    const last = ladder.length - 1;
    const g = typeof goals === "number" ? tuneGoals(goals, last) : goals;
    this.goals = {
      hard: Math.min(g.hard, g.soft),
      soft: g.soft,
      defaultIndex: Math.max(0, Math.min(last, g.defaultIndex)),
    };
    this.intervals = new Float64Array(cfg.maxSamples);
  }

  get done(): boolean {
    return this.done_;
  }

  get outcome(): TuneOutcome | null {
    return this.result;
  }

  /** Probes measured so far (cheap: the per-frame check before building `progress`). */
  get probeCount(): number {
    return this.probes;
  }

  /** Progress for the page: probes done / expected, the candidate on screen. */
  get progress(): { done: number; total: number; values: GraphicsValues | null } {
    if (this.done_) return { done: this.probes, total: this.probes, values: null };
    const st = this.stage;
    const ladderSearch = Math.ceil(Math.log2(this.ladder.length + 1)) + 1;
    const left = !st || st.kind === "floor" ? 1 + ladderSearch : st.kind === "check" ? 1 + ladderSearch : Math.max(1, st.search.remaining);
    return { done: this.probes, total: this.probes + left, values: this.probe?.values ?? null };
  }

  start(now: number): void {
    if (this.stage || this.done_) return;
    this.stage = { kind: "floor" };
    const last = this.ladder.length - 1;
    this.begin(last, this.ladder[last], now);
  }

  /**
   * A frame was rendered: `t` = its start (performance.now, ms), `cpuMs` =
   * its main-thread time, `focused` = the window had the focus and was
   * visible.
   */
  onFrame(t: number, cpuMs: number, focused: boolean): void {
    const p = this.probe;
    if (!p || this.done_) return;
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

  /** Stop now: the best rung known so far. Null when nothing was measured. */
  cancel(): TuneOutcome | null {
    if (!this.done_) this.finish(false);
    return this.result;
  }

  private restart(p: Probe, t: number): void {
    p.appliedAt = t;
    p.seen = 0;
    p.measuring = false;
    p.count = 0;
    p.cpuSum = 0;
  }

  private begin(index: number, values: GraphicsValues, now: number, pixels = 1): void {
    this.probe = { index, values, pixels, appliedAt: now, seen: 0, measuring: false, startedAt: now, lastT: now, count: 0, cpuSum: 0 };
    this.host.apply(values);
  }

  private statsOf(p: Probe): ProbeStats {
    const sorted = this.intervals.slice(0, p.count).sort();
    return { ...deliveredStats(sorted, this.cfg), cpuMs: p.cpuSum / Math.max(1, p.count + 1), sorted };
  }

  private complete(p: Probe, now: number): void {
    this.probes++;
    const stats = this.statsOf(p);
    this.measured.set(p.index, stats);
    const st = this.stage!;
    if (st.kind === "floor") return this.afterFloor(stats, now);
    if (st.kind === "check") return this.afterCheck(stats, now);
    const kept = st.search.relative ? stats.frames > 0 && stats.fps >= st.search.goal : holds(stats, st.search.goal, this.cfg);
    st.search.report(p.index, kept, p.pixels);
    if (kept && (!this.known || p.index <= this.known.index)) {
      this.known = { index: p.index, mode: st.mode, goal: st.search.goal, fps: stats.fps, pixels: p.pixels };
    }
    this.step(now);
  }

  /** The floor is measured: which goals can this machine reach at all? */
  private afterFloor(floor: ProbeStats, now: number): void {
    this.floorStats = floor;
    const { hard, soft } = this.goals;
    const last = this.ladder.length - 1;
    if (holds(floor, soft, this.cfg)) {
      this.known = { index: last, mode: "target", goal: soft, fps: floor.fps, pixels: 1 };
      this.startTargetSearches(true, now);
      return;
    }
    if (soft > hard && holds(floor, hard, this.cfg)) this.known = { index: last, mode: "hard", goal: hard, fps: floor.fps, pixels: 1 };
    // A goal missed even at the floor: the graphics card, or the processor?
    this.stage = { kind: "check" };
    this.begin(-1, halfPixels(this.ladder[last], this.cfg), now);
  }

  /** The half-pixel check is measured. */
  private afterCheck(half: ProbeStats, now: number): void {
    const floor = this.floorStats!;
    const { hard, soft, defaultIndex } = this.goals;
    const last = this.ladder.length - 1;
    const gpuLimited = half.fps >= floor.fps * this.cfg.gpuBoundGain;
    const floorHoldsHard = holds(floor, hard, this.cfg);
    if (gpuLimited) {
      if (!floorHoldsHard) return this.answer(last, "gpu", hard, floor.fps, true, 1);
      // Only the high-refresh goal is out of reach: 60 FPS from the default look down.
      this.startSearch(new RangeSearch(defaultIndex, last, true, hard, false, defaultIndex), "hard", null, now);
      return;
    }
    // The frame rate does not follow the pixels: the processor / the browser.
    // The rungs only have to keep what the floor reached.
    const goal = floor.fps * this.cfg.cpuBoundKeep;
    if (floor.fps * this.cfg.holdRatio >= hard && soft > hard) {
      // ≥ 60 anyway: as beautiful as the processor allows, never below the
      // default look for frames the processor cannot give.
      const fallback = (): void =>
        this.startSearch(new RangeSearch(defaultIndex, last, floorHoldsHard, hard, false, defaultIndex), "hard", null, now);
      this.startSearch(new RangeSearch(0, defaultIndex, false, goal, true, defaultIndex), "cpu", fallback, now);
      return;
    }
    this.startSearch(new RangeSearch(0, last, true, goal, true), "cpu", null, now);
  }

  /**
   * The floor keeps the soft goal (and so the hard one). Searches staged at
   * the default look: from the top down to it first (it is kept with the
   * smaller margin), then — only when even it falls short — below it.
   */
  private startTargetSearches(floorKeepsSoft: boolean, now: number): void {
    const { hard, soft, defaultIndex } = this.goals;
    const last = this.ladder.length - 1;
    const upToDefault = (goal: number): RangeSearch =>
      new RangeSearch(0, defaultIndex, defaultIndex === last && floorKeepsSoft, goal, false, defaultIndex);
    if (soft <= hard) {
      if (defaultIndex >= last) {
        this.startSearch(upToDefault(soft), "target", null, now);
        return;
      }
      const below = (): void => this.startSearch(new RangeSearch(defaultIndex + 1, last, floorKeepsSoft, soft, false), "target", null, now);
      this.startSearch(upToDefault(soft), "target", below, now);
      return;
    }
    // High-refresh screen: the soft goal down to the default look only…
    const fallback = (): void => this.startSearch(new RangeSearch(defaultIndex, last, true, hard, false, defaultIndex), "hard", null, now);
    this.startSearch(upToDefault(soft), "target", fallback, now);
  }

  private startSearch(search: RangeSearch, mode: TuneMode, then: (() => void) | null, now: number): void {
    this.stage = { kind: "search", search, mode, then };
    this.step(now);
  }

  /** Next probe of the current search, or its answer. */
  private step(now: number): void {
    const st = this.stage;
    if (!st || st.kind !== "search") return;
    const next = st.search.next();
    if (next !== null) {
      const pixels = next === st.search.keepIndex ? this.cfg.keepMarginPixels : this.cfg.marginPixels;
      this.begin(next, withMargin(this.ladder[next], this.cfg, pixels), now, pixels);
      return;
    }
    if (st.search.best !== null) {
      const stats = this.measured.get(st.search.best) ?? null;
      this.answer(st.search.best, st.mode, st.search.goal, stats ? stats.fps : this.floorStats?.fps ?? null, true, st.search.bestPixels);
      return;
    }
    if (st.then) {
      st.then();
      return;
    }
    // Nothing kept the goal (noise): the floor.
    const last = this.ladder.length - 1;
    this.answer(last, st.mode === "cpu" ? "cpu" : "gpu", st.search.goal, this.floorStats?.fps ?? null, true, 1);
  }

  private answer(index: number, mode: TuneMode, goal: number, fps: number | null, complete: boolean, pixels: number): void {
    this.done_ = true;
    this.probe = null;
    this.result = {
      values: this.ladder[index],
      index,
      defaultIndex: this.goals.defaultIndex,
      mode,
      goalFps: goal,
      floorFps: this.floorStats?.fps ?? null,
      answerFps: fps,
      marginPixels: pixels,
      probes: this.probes,
      complete,
    };
  }

  private finish(complete: boolean): void {
    if (this.done_) return;
    // Stopped early: the best rung KNOWN to keep a goal; nothing measured → no answer.
    if (!this.floorStats) {
      this.done_ = true;
      this.probe = null;
      this.result = null;
      return;
    }
    const last = this.ladder.length - 1;
    const k = this.known ?? { index: last, mode: "gpu" as TuneMode, goal: this.goals.hard, fps: this.floorStats.fps, pixels: 1 };
    this.answer(k.index, k.mode, k.goal, k.fps, complete, k.pixels);
  }
}

// --------------------------------------------------------------- summary

export interface SummaryContext {
  targetFps: number;
  caps: Pick<GraphicsCaps, "composer" | "snow" | "halos" | "anisotropicTextures">;
  /** Software rendering (SwiftShader, llvmpipe, Basic Render Driver). */
  software: boolean;
}

/** The message shown after a detection (settings page, under "Auto-detect"). */
export function summarize(o: TuneOutcome, ctx: SummaryContext): string {
  const desc = describeValues(o.values, ctx.caps);
  if (ctx.software) {
    return (
      "Software rendering detected: your browser is drawing without the graphics card (hardware acceleration is off). " +
      `Floor settings for now (${desc}). Turn on hardware acceleration in your browser.`
    );
  }
  const partial = o.complete ? "" : " Detection was interrupted: safe settings for now, it runs again at the next launch.";
  // The margin this answer was really measured with (the floor: as is).
  const reserve =
    o.marginPixels > 1 + 1e-6
      ? ` with ${formatNumber((o.marginPixels - 1) * 100, 0)}% extra pixels as headroom for fights`
      : " (the quality floor, with no measured headroom for fights)";
  if (o.mode === "gpu") {
    const fps = o.floorFps !== null ? `about ${Math.round(o.floorFps)} FPS` : "less";
    return (
      `Even at the quality floor (${desc}), this PC gets ${fps} instead of ${Math.min(60, ctx.targetFps)}: ` +
      `the graphics card is the limit. The floor keeps the image clean; you can go lower by hand.${partial}`
    );
  }
  if (o.mode === "cpu") {
    const fps = o.floorFps !== null ? `about ${Math.round(o.floorFps)} FPS` : "less than the target";
    return (
      `This PC tops out at ${fps} whatever the graphics: the processor or the browser is the limit, ` +
      `not the graphics card. So the graphics stay sharp: ${desc}.${partial}`
    );
  }
  const lowered = o.index > o.defaultIndex;
  if (o.mode === "hard") {
    if (lowered) {
      return (
        `This graphics card's original look can't hold ${o.goalFps} FPS here with enough headroom: ` +
        `settings picked for at least ${o.goalFps} FPS${reserve}: ${desc}.${partial}`
      );
    }
    return (
      `Holding ${ctx.targetFps} FPS would mean going below this graphics card's original look, so it is kept, ` +
      `for at least ${o.goalFps} FPS${reserve}: ${desc}. ` +
      `For more frames, lower the resolution or the anti-aliasing by hand.${partial}`
    );
  }
  const below = lowered ? ` This graphics card's original look didn't keep enough headroom at ${ctx.targetFps} FPS.` : "";
  return `Settings picked to hold ${ctx.targetFps} FPS${reserve}: ${desc}.${below}${partial}`;
}
