import {
  AUTO_TUNE_VERSION,
  autoResultFor,
  effectivePreset,
  effectiveValues,
  heuristicPreset,
  liveValues,
  needsDetection,
  presetValues,
  reloadChanges,
  resolveFpsCap,
  sameValues,
  targetFps as computeTargetFps,
  type AutoResult,
  type DisplayEnv,
  type GpuHint,
  type GraphicsCaps,
  type GraphicsValues,
  type PresetChoice,
  type ReloadChange,
} from "./GraphicsSettings";
import { buildLadder, summarize, tuneConfigFor, type AutoTuneConfig, type TuneOutcome } from "./AutoTune";
import { AUTO_GUARD, AutoGuard, guardStepIndex, guardUpIndex, retryDelay, type AutoGuardConfig, type GuardVerdict } from "./AutoGuard";
import { describeChange, guardNoticeText, guardRaisedText, guardSummaryText } from "./labels";
import type { PerfPanelMode, SettingsRecord, SettingsStore } from "./SettingsStore";
import type { OutlineSettings } from "../game/OutlineSettings";
import type { CrosshairSettings } from "../ui/CrosshairSettings";
import { perfExperiments } from "../ui/perfDiag";

/** Options of one detection run. */
export interface AutoTuneOptions {
  /** Called after every probe (progress bar). */
  onProgress?: (p: DetectionProgress) => void;
  /** Measure even on a software renderer (headless tests only). */
  allowSoftware?: boolean;
  /**
   * The look this GPU always had (its old preset: High, Low on integrated
   * GPUs): a high-refresh screen's frame rate never takes the image below it.
   */
  defaultLook?: GraphicsValues;
  /** Thresholds of the detection (tuneConfigFor: this GPU, `?diag=tunemarginNN`). */
  config?: AutoTuneConfig;
}

/** A rendered frame: its start, its main-thread time, and whether it was focused play. */
export type PlayFrameListener = (t: number, cpuMs: number, play: boolean) => void;

/** What the controller drives (the Game; a fake in the tests). */
export interface GraphicsHost {
  readonly graphicsBoot: GraphicsValues;
  readonly graphicsCaps: GraphicsCaps;
  readonly gpuName: string;
  /** Map of this session (detections are stored per map). */
  readonly mapId: string;
  readonly softwareRenderer: boolean;
  onDisplayDensityChange: (() => void) | null;
  applyGraphicsSettings(values: GraphicsValues): void;
  setFpsCap(maxFps: number): void;
  applyOutlineSettings(settings: OutlineSettings): void;
  setPerfPanel(mode: PerfPanelMode): void;
  /** Measures the ladder on the frames rendered from now on; null when stopped before any measurement. */
  startAutoTune(targetFps: number, opts: AutoTuneOptions): Promise<TuneOutcome | null>;
  /** Stops a running detection (its promise resolves with the best known rung, or null). */
  cancelAutoTune(): void;
  /**
   * Every rendered frame, with whether it was FOCUSED PLAY — the match under
   * the player's hands: pointer locked, page visible, match not over, no
   * detection measuring. The Auto guard's input (absent: no guard).
   */
  addFrameListener?(listener: PlayFrameListener): () => void;
  /** A short, non-intrusive notice over the game (the Auto guard's step). */
  showGraphicsNotice?(text: string): void;
}

/** Wiring options of the controller (tests; production uses the defaults). */
export interface GraphicsControllerOptions {
  /** `?diag=` switches (default: the address bar's): `noguard`, `tunemarginNN`. */
  experiments?: ReadonlySet<string>;
  /**
   * Runs `fn` once the current frame is over (default: a 0 ms timeout). The
   * guard decides at the END of a frame; resizing the canvas there would show
   * a blank image (see Game.pendingProbe), and storage writes have no place
   * in a frame either.
   */
  defer?: (fn: () => void) => void;
  /** Thresholds of the in-match guard (tests). */
  guardConfig?: AutoGuardConfig;
  /** Wall clock (Date.now; tests): when a try one rung back up is due. */
  now?: () => number;
}

/** The in-match guard of one detection result, for this session. */
interface GuardSession {
  map: string;
  /** Date of the detection result it works on (a new detection = a new session of the guard). */
  at: number;
  guard: AutoGuard;
  /**
   * Values on screen other than the stored ones: a step not kept yet (being
   * judged), one judged useless (kept on screen for the session, never
   * stored), or the rung one step up tried this session. Null = the stored values.
   */
  live: GraphicsValues | null;
  /** This session tries ONE rung back up (since its start): kept after a whole match without a step. */
  trial: { to: GraphicsValues; startPlayedMs: number } | null;
  /** The try did not hold: the guard stepped back down from it (the next try waits twice as long). */
  trialFailed: boolean;
}

export interface DetectionProgress {
  done: number;
  total: number;
  values: GraphicsValues | null;
}

export type DetectionReason = "first" | "manual";

export type DetectionEvent =
  | { kind: "start"; reason: DetectionReason }
  | { kind: "progress"; progress: DetectionProgress }
  | { kind: "done"; result: AutoResult; reason: DetectionReason }
  | { kind: "cancelled"; reason: DetectionReason };

/** Weak-GPU test of the name (same families as GraphicsQuality's heuristic). */
export type WeakGpuTest = (name: string) => boolean;

/**
 * Settings → game, once and for all: every change of the record (settings
 * page, detection result, preset, display density) applies what the session
 * can apply live; reload-only changes are listed for the page. Also runs the
 * automatic detection (first launch of a map, "Run detection") and
 * stores its result as the "Auto" choice of that map — and, in matches, the
 * Auto GUARD (settings/AutoGuard) that keeps that choice's promise.
 */
export class GraphicsController {
  private outlineDebug = false;
  private lastCrosshair = "";
  private lastPanel: PerfPanelMode | null = null;
  private detection: Promise<AutoResult | null> | null = null;
  private detectionReason: DetectionReason = "manual";
  private progressState: DetectionProgress | null = null;
  private cancelled = false;
  private readonly listeners: ((e: DetectionEvent) => void)[] = [];
  /** `?diag=noguard`: no in-match guard (Auto = the detection's answer only). */
  private readonly guardDisabled: boolean;
  /** `?diag=tunemarginNN`: the detection's margin forced to NN % extra pixels (null = the rule). */
  private readonly marginOverride: number | null;
  private readonly defer: (fn: () => void) => void;
  private readonly guardConfig: AutoGuardConfig;
  private readonly now: () => number;
  private guardSession: GuardSession | null = null;
  /** The guard gets the frames (recomputed at every sync: cheap per frame). */
  private guardArmed = false;
  /** True during the constructor: the session's START — the only moment a rung back up is tried. */
  private starting = true;

  constructor(
    private readonly store: SettingsStore,
    private readonly host: GraphicsHost,
    private readonly env: () => DisplayEnv,
    private readonly refreshHz: () => number,
    private readonly applyCrosshair: (settings: CrosshairSettings) => void,
    private readonly isWeakGpu: WeakGpuTest,
    options: GraphicsControllerOptions = {},
  ) {
    const experiments = options.experiments ?? perfExperiments();
    this.guardDisabled = experiments.has("noguard");
    this.marginOverride = marginSwitch(experiments);
    this.defer = options.defer ?? ((fn) => void setTimeout(fn, 0));
    this.guardConfig = options.guardConfig ?? AUTO_GUARD;
    this.now = options.now ?? (() => Date.now());
    store.subscribe(() => this.sync());
    host.onDisplayDensityChange = () => this.sync();
    host.addFrameListener?.((t, cpuMs, play) => this.onFrame(t, cpuMs, play));
    this.sync();
    this.starting = false;
  }

  get record(): SettingsRecord {
    return this.store.get();
  }

  get gpu(): GpuHint {
    return { name: this.host.gpuName, weak: this.isWeakGpu(this.host.gpuName) };
  }

  get mapId(): string {
    return this.host.mapId;
  }

  /**
   * Values the stored choice stands for on this display and map — or, with
   * "Auto", the in-match guard's step below them when it is not stored (yet).
   */
  effective(): GraphicsValues {
    return this.guardLive() ?? effectiveValues(this.record.graphics, this.env(), this.gpu, this.mapId);
  }

  /** The preset the choice really is ("auto" before any detection = the heuristic preset). */
  effectivePreset(): PresetChoice {
    return effectivePreset(this.record.graphics, this.gpu, this.mapId);
  }

  /** The stored detection "Auto" uses here (null = none yet: the heuristic preset). */
  autoResult(): AutoResult | null {
    return autoResultFor(this.record.graphics, this.gpu, this.mapId);
  }

  /** Stored changes the session can only apply after a reload. */
  pendingReload(): ReloadChange[] {
    return reloadChanges(this.host.graphicsBoot, this.effective(), this.host.graphicsCaps);
  }

  /** The frame-rate cap in effect (Infinity = uncapped). */
  capFps(): number {
    return resolveFpsCap(this.record.fpsCap, this.effectivePreset());
  }

  /**
   * What the detection aims at: the display's rate or the chosen target,
   * under an EXPLICIT cap only (the "auto" cap follows the preset — the
   * detection's own result would change its target).
   */
  detectionTarget(): number {
    return computeTargetFps(this.record.fpsTarget, this.refreshHz(), resolveFpsCap(this.record.fpsCap, "auto"));
  }

  get detecting(): boolean {
    return this.detection !== null;
  }

  get progress(): DetectionProgress | null {
    return this.progressState;
  }

  /** Detection events (the settings page, the menu's notice). */
  subscribe(listener: (e: DetectionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Session-only cel-shading debug view. */
  setOutlineDebug(on: boolean): void {
    this.outlineDebug = on;
    this.sync();
  }

  get outlineDebugOn(): boolean {
    return this.outlineDebug;
  }

  /** "Auto" has no up-to-date measurement of this machine and map. */
  needsDetection(): boolean {
    return needsDetection(this.record.graphics, this.gpu, this.mapId, this.detectionTarget(), this.host.graphicsBoot.shadows);
  }

  /** Everything the record says, applied (idempotent: the host only changes what differs). */
  sync(): void {
    const r = this.record;
    // (first: the guard's session — at the start, a rung back up may be tried: effective() then shows it)
    this.refreshGuard();
    this.host.applyGraphicsSettings(this.effective());
    this.host.setFpsCap(this.capFps());
    this.host.applyOutlineSettings({ ...r.outline, debugEdges: this.outlineDebug });
    const crosshair = JSON.stringify(r.crosshair);
    if (crosshair !== this.lastCrosshair) {
      this.lastCrosshair = crosshair;
      this.applyCrosshair({ ...r.crosshair });
    }
    if (r.perfPanel !== this.lastPanel) {
      this.lastPanel = r.perfPanel;
      this.host.setPerfPanel(r.perfPanel);
    }
  }

  /**
   * Runs the automatic detection now (menu or pause: the frames on screen are
   * measured) and stores its result as the "Auto" choice of this map
   * (the preset becomes "Auto"). Resolves with the result, or null
   * when cancelled.
   */
  runDetection(reason: DetectionReason = "manual", opts: Omit<AutoTuneOptions, "onProgress"> = {}): Promise<AutoResult | null> {
    if (this.detection) return this.detection;
    this.cancelled = false;
    this.detectionReason = reason;
    const target = this.detectionTarget();
    const caps = this.host.graphicsCaps;
    const map = this.mapId;
    const boot = this.host.graphicsBoot;
    this.progressState = { done: 0, total: 5, values: null };
    // While it measures, the guard sleeps (the detection owns the knobs).
    this.guardArmed = false;
    const run = this.host
      .startAutoTune(target, {
        ...opts,
        defaultLook: presetValues(heuristicPreset(this.gpu), this.env()),
        config: opts.config ?? tuneConfigFor({ integrated: this.gpu.weak }, this.marginOverride),
        onProgress: (p) => {
          this.progressState = p;
          this.emit({ kind: "progress", progress: p });
        },
      })
      .then((outcome) => {
        this.detection = null;
        this.progressState = null;
        if (this.cancelled || !outcome) {
          // The player's values come back (the host restored them).
          this.sync();
          this.emit({ kind: "cancelled", reason });
          return null;
        }
        const result = this.resultOf(outcome, target, caps, map, boot);
        this.store.update((d) => {
          d.graphics = { preset: "auto", custom: d.graphics.custom, auto: { ...d.graphics.auto, [map]: result } };
        });
        this.emit({ kind: "done", result, reason: this.detectionReason });
        return result;
      });
    this.detection = run;
    // Only now: the listeners (the page's locked options, its Cancel button)
    // see the detection running from its very first probe.
    this.emit({ kind: "start", reason });
    return run;
  }

  /** Stops the detection and puts the player's values back. */
  cancelDetection(): void {
    if (!this.detection) return;
    this.cancelled = true;
    this.host.cancelAutoTune();
  }

  /** Detection outcome → stored "Auto" result (with its summary for the page). */
  private resultOf(o: TuneOutcome, target: number, caps: GraphicsCaps, map: string, boot: GraphicsValues): AutoResult {
    const values = { ...o.values };
    const software = this.host.softwareRenderer;
    let summary = summarize(o, { targetFps: target, caps, software });
    // Even the floor misses with LIVE shadows (graphics card): the per-frame
    // shadow pass goes too — static shadows, the map's shadows baked once,
    // no character shadows. Not measurable live (it changes shaders): applied
    // at the next load, then measured again (needsDetection).
    if (o.mode === "gpu" && boot.shadows === "dynamic" && !software) {
      values.shadows = "static";
      values.characterShadows = false;
      summary += " Shadows switch to static at the next page load to gain more (\"Apply & reload\").";
    }
    const measuredFps =
      o.mode === "target" || o.mode === "hard" ? o.goalFps : o.floorFps !== null ? Math.round(o.floorFps) : null;
    return {
      values,
      at: Date.now(),
      gpu: this.host.gpuName,
      map,
      targetFps: target,
      measuredFps: measuredFps !== null ? Math.round(measuredFps) : null,
      mode: o.mode,
      complete: o.complete,
      measuredShadows: boot.shadows,
      summary,
      version: AUTO_TUNE_VERSION,
      guardSteps: 0,
      guardAt: null,
      detected: { ...values },
      guardRetryAt: null,
      guardUpFails: 0,
    };
  }

  private emit(e: DetectionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  // ------------------------------------------------------------ Auto guard

  /** Steps the in-match guard applied this session (diagnostics, tests). */
  get guardSteps(): number {
    return this.guardSession?.guard.steps ?? 0;
  }

  /** The guard's phase this session, null when it does not run (not "Auto", nothing measured, `?diag=noguard`…). */
  get guardPhase(): string | null {
    return this.guardArmed && this.guardSession ? this.guardSession.guard.phase : null;
  }

  /** The guard's values on screen when they are below the stored "Auto" ones (and still apply). */
  private guardLive(): GraphicsValues | null {
    const s = this.guardSession;
    if (!s || !s.live || this.record.graphics.preset !== "auto" || s.map !== this.mapId) return null;
    const r = this.autoResult();
    return r && r.at === s.at ? s.live : null;
  }

  /** The promise the guard keeps: 60 FPS, or the target when lower (a 50 Hz screen, a 30 FPS cap). */
  private guardGoal(): number {
    return Math.min(60, this.detectionTarget());
  }

  /**
   * Whether the guard gets the frames: "Auto" with a usable detection of this
   * GPU and map, no detection running, and something below the values on
   * screen — or a step still being judged. Never for an explicit preset.
   */
  private refreshGuard(): void {
    this.guardArmed = false;
    if (this.guardDisabled || !this.host.addFrameListener) return;
    if (this.record.graphics.preset !== "auto" || this.detection) return;
    const auto = this.autoResult();
    if (!auto) return;
    let s = this.guardSession;
    if (!s || s.at !== auto.at || s.map !== this.mapId) {
      s = { map: this.mapId, at: auto.at, guard: new AutoGuard(this.guardGoal(), this.guardConfig), live: null, trial: null, trialFailed: false };
      this.guardSession = s;
      // The START of a session, values lowered by the guard in an earlier one, the wait over: ONE rung back up.
      const up = this.starting ? this.recoveryRung(auto) : null;
      if (up) {
        s.live = { ...up };
        s.trial = { to: { ...up }, startPlayedMs: 0 };
        console.info(`[graphics] Auto guard: trying one step higher again this session (${describeChange(auto.values, up, this.host.graphicsCaps)}).`);
      }
    }
    if (!s.guard.active) return;
    if (s.guard.phase === "watch" && this.guardStepTarget() === null) return; // the floor: nothing below
    this.guardArmed = true;
  }

  /** The rung the guard would step to from the values on screen (null: the floor). */
  private guardStepTarget(): GraphicsValues | null {
    const ladder = buildLadder(this.host.graphicsBoot, this.env(), this.host.graphicsCaps);
    const j = guardStepIndex(ladder, this.effective());
    return j === null ? null : ladder[j];
  }

  /**
   * The rung ONE step back up from a result the guard lowered in an earlier
   * session, once its wait is over (guardRetryAt) — never above the
   * detection's own answer. Null: nothing to try.
   */
  private recoveryRung(r: AutoResult): GraphicsValues | null {
    if (!r.detected || (r.guardSteps ?? 0) <= 0 || r.guardRetryAt == null || this.now() < r.guardRetryAt) return null;
    const boot = this.host.graphicsBoot;
    const caps = this.host.graphicsCaps;
    const ladder = buildLadder(boot, this.env(), caps);
    const k = guardUpIndex(ladder, liveValues(boot, r.values, caps), liveValues(boot, r.detected, caps));
    return k === null ? null : ladder[k];
  }

  /** True while this session tries a rung back up (not stored yet). */
  get guardTrying(): boolean {
    return this.guardSession?.trial != null && this.guardLive() !== null;
  }

  private onFrame(t: number, cpuMs: number, play: boolean): void {
    if (!this.guardArmed) return;
    const s = this.guardSession!;
    const v = s.guard.onFrame(t, cpuMs, play);
    if (v) {
      this.onGuardVerdict(s, v);
      return;
    }
    // The rung tried one step up held a whole match: it is stored.
    const trial = s.trial;
    if (trial && s.guard.phase === "watch" && s.guard.playedMs - trial.startPlayedMs >= this.guardConfig.trialKeepMs) {
      s.trial = null;
      this.defer(() => this.guardKeepTrial(s, trial.to));
    }
  }

  private onGuardVerdict(s: GuardSession, v: GuardVerdict): void {
    switch (v.action) {
      case "step":
        this.defer(() => this.guardStep(s));
        return;
      case "keep": {
        const values = this.effective();
        this.defer(() => this.guardKeep(s, values, v));
        return;
      }
      case "keep-step": {
        const values = this.effective();
        this.defer(() => {
          this.guardKeep(s, values, v);
          this.guardStep(s);
        });
        return;
      }
      case "useless":
        // The frame rate does not follow the graphics here (a browser frame
        // cap, the processor, the browser's GPU process): no more steps this
        // session. The one on screen stays (never back up inside a session)
        // but is not stored: the next session starts from the stored values.
        this.guardArmed = false;
        console.info(
          `[graphics] Auto guard: ${Math.round(v.before ?? 0)} → ${Math.round(v.fps)} FPS after a step — the graphics are not the limit, guard off for this session.`,
        );
        return;
    }
  }

  /** One rung down, live (between two frames: see `defer`). */
  private guardStep(s: GuardSession): void {
    if (this.guardSession !== s || !s.guard.active) return;
    if (s.trial) {
      // The rung tried one step up did not hold: back down (to the stored rung), the next try later.
      s.trial = null;
      s.trialFailed = true;
    }
    const from = this.effective();
    const to = this.guardStepTarget();
    if (!to || this.record.graphics.preset !== "auto" || this.detection) {
      s.guard.stop();
      this.refreshGuard();
      return;
    }
    s.live = { ...to };
    s.guard.applied();
    this.sync(); // → the game applies it (no shader compile: ladder rungs only)
    const goal = s.guard.goalFps;
    this.host.showGraphicsNotice?.(guardNoticeText(from, to, goal, this.host.graphicsCaps));
  }

  /** The judged step helped: it becomes the stored "Auto" result of this map (its summary says so). */
  private guardKeep(s: GuardSession, values: GraphicsValues, v: GuardVerdict): void {
    if (this.guardSession !== s) return;
    const map = s.map;
    const caps = this.host.graphicsCaps;
    const goal = s.guard.goalFps;
    const cfg = this.guardConfig;
    const now = this.now();
    const trialFailed = s.trialFailed;
    s.trialFailed = false;
    this.store.update((d) => {
      const r = d.graphics.auto[map];
      if (!r || r.at !== s.at) return; // replaced meanwhile (a new detection)
      if (sameValues(r.values, values)) {
        // Back on the stored rung after a try one step up that did not hold: the next try waits twice as long.
        if (trialFailed) {
          const fails = (r.guardUpFails ?? 0) + 1;
          d.graphics.auto[map] = { ...r, guardUpFails: fails, guardRetryAt: now + retryDelay(fails, cfg) };
        }
        return;
      }
      const steps = (r.guardSteps ?? 0) + 1;
      d.graphics.auto[map] = {
        ...r,
        values: { ...values },
        detected: r.detected ?? { ...r.values },
        guardSteps: steps,
        guardAt: now,
        guardRetryAt: now + retryDelay(r.guardUpFails ?? 0, cfg),
        summary: guardSummaryText(values, steps, v.before ?? v.fps, goal, caps),
      };
    });
    this.dropLiveIfStored(s, values);
  }

  /** The rung tried one step up held a whole match: stored (one guard step less), the next try another day. */
  private guardKeepTrial(s: GuardSession, to: GraphicsValues): void {
    if (this.guardSession !== s) return;
    const map = s.map;
    const caps = this.host.graphicsCaps;
    const goal = s.guard.goalFps;
    const cfg = this.guardConfig;
    const now = this.now();
    this.store.update((d) => {
      const r = d.graphics.auto[map];
      if (!r || r.at !== s.at) return;
      const steps = Math.max(0, (r.guardSteps ?? 0) - 1);
      d.graphics.auto[map] = {
        ...r,
        values: { ...to },
        guardSteps: steps,
        guardAt: now,
        guardUpFails: 0,
        guardRetryAt: steps > 0 ? now + retryDelay(0, cfg) : null,
        summary: guardRaisedText(to, steps, goal, caps),
      };
    });
    this.dropLiveIfStored(s, to);
  }

  /** Stored = on screen: nothing left to override (same values: nothing changes on screen). */
  private dropLiveIfStored(s: GuardSession, values: GraphicsValues): void {
    const r = this.store.get().graphics.auto[s.map];
    if (r && r.at === s.at && s.live && sameValues(s.live, values) && sameValues(r.values, values)) {
      s.live = null;
      this.refreshGuard();
    }
  }
}

/** `?diag=tunemarginNN` → NN (0 allowed: no margin at all), null when absent. */
function marginSwitch(experiments: ReadonlySet<string>): number | null {
  for (const e of experiments) {
    if (!e.startsWith("tunemargin")) continue;
    const n = Number(e.slice("tunemargin".length));
    if (e.length > "tunemargin".length && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
