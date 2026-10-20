import {
  AUTO_TUNE_VERSION,
  autoResultUsable,
  effectivePreset,
  effectiveValues,
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
import { needsFirstDetection, type PerfPanelMode, type SettingsRecord, type SettingsStore } from "./SettingsStore";
import type { OutlineSettings } from "../game/OutlineSettings";
import type { CrosshairSettings } from "../ui/CrosshairSettings";

/** What the controller drives (the Game; a fake in the tests). */
export interface GraphicsHost {
  readonly graphicsBoot: GraphicsValues;
  readonly graphicsCaps: GraphicsCaps;
  readonly gpuName: string;
  readonly softwareRenderer: boolean;
  readonly autoTuning: boolean;
  onDisplayDensityChange: (() => void) | null;
  applyGraphicsSettings(values: GraphicsValues): void;
  setFpsCap(maxFps: number): void;
  setDynamicResolution(on: boolean, targetFps: number): void;
  applyOutlineSettings(settings: OutlineSettings): void;
  setPerfPanel(mode: PerfPanelMode): void;
  startAutoTune(targetFps: number, onProgress?: (p: DetectionProgress) => void): Promise<TuneOutcome>;
  cancelAutoTune(restore: boolean): void;
}

export interface DetectionProgress {
  done: number;
  total: number;
  values: GraphicsValues | null;
}

export type DetectionEvent =
  | { kind: "start"; reason: "first" | "manual" }
  | { kind: "progress"; progress: DetectionProgress }
  | { kind: "done"; result: AutoResult; reason: "first" | "manual" }
  | { kind: "cancelled" };

/** Weak-GPU test of the name (same families as GraphicsQuality's heuristic). */
export type WeakGpuTest = (name: string) => boolean;

/**
 * Settings → game, once and for all: every change of the record (settings
 * page, detection result, preset, display density) applies what the session
 * can apply live; reload-only changes are listed for the page. Also runs the
 * automatic detection (first launch, « Détection automatique ») and stores
 * its result as the "Automatique" choice.
 */
export class GraphicsController {
  private outlineDebug = false;
  private lastCrosshair = "";
  private lastPanel: PerfPanelMode | null = null;
  private detection: Promise<AutoResult | null> | null = null;
  private detectionReason: "first" | "manual" = "manual";
  private progressState: DetectionProgress | null = null;
  private cancelled = false;
  private readonly listeners = new Set<(e: DetectionEvent) => void>();

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

  /** Values the stored choice stands for on this display. */
  effective(): GraphicsValues {
    return effectiveValues(this.record.graphics, this.env(), this.gpu);
  }

  /** The preset the choice really is ("auto" before any detection = the heuristic preset). */
  effectivePreset(): PresetChoice {
    return effectivePreset(this.record.graphics, this.gpu);
  }

  /** True when "Automatique" uses a stored detection of this GPU. */
  get autoDetected(): boolean {
    return autoResultUsable(this.record.graphics.auto, this.gpu);
  }

  /** Stored changes the session can only apply after a reload. */
  pendingReload(): ReloadChange[] {
    return reloadChanges(this.host.graphicsBoot, this.effective(), this.host.graphicsCaps);
  }

  /** The frame-rate cap in effect (Infinity = uncapped). */
  capFps(): number {
    return resolveFpsCap(this.record.fpsCap, this.effectivePreset());
  }

  /** What the detection aims at (the display's rate, the chosen target; ≤ an explicit cap). */
  detectionTarget(): number {
    return computeTargetFps(this.record.fpsTarget, this.refreshHz(), resolveFpsCap(this.record.fpsCap, "auto"));
  }

  /** What the dynamic resolution holds (the cap in effect included). */
  playTarget(): number {
    return computeTargetFps(this.record.fpsTarget, this.refreshHz(), this.capFps());
  }

  get detecting(): boolean {
    return this.detection !== null;
  }

  get progress(): DetectionProgress | null {
    return this.progressState;
  }

  /** Detection events (the settings page, the menu's toast). */
  subscribe(listener: (e: DetectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Session-only cel-shading debug view. */
  setOutlineDebug(on: boolean): void {
    this.outlineDebug = on;
    this.sync();
  }

  get outlineDebugOn(): boolean {
    return this.outlineDebug;
  }

  /** The player never chose and this GPU was never measured. */
  needsFirstDetection(): boolean {
    return needsFirstDetection(this.record, this.host.gpuName);
  }

  /** Everything the record says, applied (idempotent: the host only changes what differs). */
  sync(): void {
    const r = this.record;
    this.host.applyGraphicsSettings(this.effective());
    this.host.setFpsCap(this.capFps());
    this.host.setDynamicResolution(r.dynamicResolution, this.playTarget());
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
   * measured) and stores its result as the "Automatique" choice. Resolves with
   * the result, or null when cancelled.
   */
  runDetection(reason: "first" | "manual" = "manual"): Promise<AutoResult | null> {
    if (this.detection) return this.detection;
    this.cancelled = false;
    this.detectionReason = reason;
    const target = this.detectionTarget();
    const caps = this.host.graphicsCaps;
    this.progressState = { done: 0, total: 5, values: null };
    this.emit({ kind: "start", reason });
    const run = this.host
      .startAutoTune(target, (p) => {
        this.progressState = p;
        this.emit({ kind: "progress", progress: p });
      })
      .then((outcome) => {
        this.detection = null;
        this.progressState = null;
        if (this.cancelled) {
          this.emit({ kind: "cancelled" });
          return null;
        }
        const result = this.resultOf(outcome, target, caps);
        this.store.update((d) => {
          d.graphics = { preset: "auto", custom: d.graphics.custom, auto: result };
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
    this.host.cancelAutoTune(true);
  }

  /** Detection outcome → stored "Automatique" result (with its French summary). */
  private resultOf(o: TuneOutcome, target: number, caps: GraphicsCaps): AutoResult {
    const values = { ...o.values };
    let summary = summarize(o, { targetFps: target, caps, software: this.host.softwareRenderer });
    // Even the floor misses with LIVE shadows: the per-frame shadow pass goes
    // (static shadows: the map's shadows baked once, no character shadows).
    // Not measurable live (it changes shaders): applied at the next load.
    const boot = this.host.graphicsBoot;
    if (o.limitedBy === "gpu" && boot.shadows === "dynamic" && !this.host.softwareRenderer) {
      values.shadows = "static";
      values.characterShadows = false;
      summary += " Les ombres passent en statiques au prochain chargement pour gagner encore (« Appliquer et recharger »).";
    }
    return {
      values,
      at: Date.now(),
      gpu: this.host.gpuName,
      targetFps: target,
      expectedFps: o.verdict ? Math.round(o.verdict.fps) : null,
      limitedBy: o.limitedBy,
      belowTarget: o.belowTarget,
      summary,
      version: AUTO_TUNE_VERSION,
    };
  }

  private emit(e: DetectionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}
