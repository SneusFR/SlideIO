import {
  AUTO_TUNE_VERSION,
  autoResultFor,
  effectivePreset,
  effectiveValues,
  needsDetection,
  reloadChanges,
  resolveFpsCap,
  targetFps as computeTargetFps,
  type AutoResult,
  type DisplayEnv,
  type GpuHint,
  type GraphicsCaps,
  type GraphicsValues,
  type PresetChoice,
  type ReloadChange,
} from "./GraphicsSettings";
import { summarize, type TuneOutcome } from "./AutoTune";
import type { PerfPanelMode, SettingsRecord, SettingsStore } from "./SettingsStore";
import type { OutlineSettings } from "../game/OutlineSettings";
import type { CrosshairSettings } from "../ui/CrosshairSettings";

/** Options of one detection run. */
export interface AutoTuneOptions {
  /** Called after every probe (progress bar). */
  onProgress?: (p: DetectionProgress) => void;
  /** Measure even on a software renderer (headless tests only). */
  allowSoftware?: boolean;
}

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
 * automatic detection (first launch of a map, « Lancer la détection ») and
 * stores its result as the "Automatique" choice of that map.
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

  constructor(
    private readonly store: SettingsStore,
    private readonly host: GraphicsHost,
    private readonly env: () => DisplayEnv,
    private readonly refreshHz: () => number,
    private readonly applyCrosshair: (settings: CrosshairSettings) => void,
    private readonly isWeakGpu: WeakGpuTest,
  ) {
    store.subscribe(() => this.sync());
    host.onDisplayDensityChange = () => this.sync();
    this.sync();
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

  /** Values the stored choice stands for on this display and map. */
  effective(): GraphicsValues {
    return effectiveValues(this.record.graphics, this.env(), this.gpu, this.mapId);
  }

  /** The preset the choice really is ("auto" before any detection = the heuristic preset). */
  effectivePreset(): PresetChoice {
    return effectivePreset(this.record.graphics, this.gpu, this.mapId);
  }

  /** The stored detection "Automatique" uses here (null = none yet: the heuristic preset). */
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

  /** "Automatique" has no up-to-date measurement of this machine and map. */
  needsDetection(): boolean {
    return needsDetection(this.record.graphics, this.gpu, this.mapId, this.detectionTarget(), this.host.graphicsBoot.shadows);
  }

  /** Everything the record says, applied (idempotent: the host only changes what differs). */
  sync(): void {
    const r = this.record;
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
   * measured) and stores its result as the "Automatique" choice of this map
   * (the preset becomes "Automatique"). Resolves with the result, or null
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
    this.emit({ kind: "start", reason });
    const run = this.host
      .startAutoTune(target, {
        ...opts,
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
    return run;
  }

  /** Stops the detection and puts the player's values back. */
  cancelDetection(): void {
    if (!this.detection) return;
    this.cancelled = true;
    this.host.cancelAutoTune();
  }

  /** Detection outcome → stored "Automatique" result (with its French summary). */
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
      summary += " Les ombres passent en statiques au prochain chargement pour gagner encore (« Appliquer et recharger »).";
    }
    const measuredFps = o.mode === "target" ? target : o.floorFps !== null ? Math.round(o.floorFps) : null;
    return {
      values,
      at: Date.now(),
      gpu: this.host.gpuName,
      map,
      targetFps: target,
      measuredFps,
      limitedBy: o.mode === "cpu" ? "cpu" : o.mode === "gpu" ? "gpu" : "none",
      belowTarget: o.mode !== "target",
      complete: o.complete,
      measuredShadows: boot.shadows,
      summary,
      version: AUTO_TUNE_VERSION,
    };
  }

  private emit(e: DetectionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}
