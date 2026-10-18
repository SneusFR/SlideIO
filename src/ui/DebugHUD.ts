import * as THREE from "three";
import { PlayerMovement } from "../player/PlayerMovement";
import type { FrameSections } from "./FrameSections";

/**
 * A frame gap at least this long is analysed as a HITCH (ms): at 60 Hz, two
 * refreshes or more without a new image (the "51 FPS" dips).
 */
const HITCH_MS = 30;
/**
 * Frames whose post-frame browser work is remembered (see markFrameEnd): a
 * hitch is analysed 250 ms after it, so the ring must hold that many frames
 * even at very high frame rates (250 ms = 60 frames at 240 Hz).
 */
const POST_RING = 256;

/** Long Animation Frame entry (Chrome 123+), the fields used here. */
interface LoafScript {
  invoker?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}
interface LoafEntry {
  startTime: number;
  duration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts?: LoafScript[];
}

/**
 * Minimal development HUD: speed, state, velocity, FPS + frame timing.
 *
 * The FPS/frame-time stats are fed the RAW (unclamped) frame delta — the
 * gameplay dt is clamped to 1/30 s, so a counter built on it could never
 * report below 30 FPS and always over-estimated under load. The p95/max
 * frame times expose irregularity that an average hides. Neither these
 * intervals nor distinct rAF timestamps measure actual screen presentation
 * or mouse-to-display latency.
 */
export class DebugHUD {
  private el: HTMLElement;
  /** RAW frame-time samples (seconds) since the last stats refresh. */
  private readonly samples: number[] = [];
  private fps = 0;
  private avgMs = 0;
  private p95Ms = 0;
  private maxMs = 0;
  private statsTimer = 0;
  private refreshTimer = 0;
  // GPU-side census (refreshed with the frame stats, not every frame).
  private drawCalls = 0;
  private triangles = 0;
  private lightsTotal = 0;
  private lightsActive = 0;
  /** Lights found by the last scene walk + seconds until the next walk. */
  private readonly lights: THREE.Light[] = [];
  private censusTimer = 0;
  /**
   * Rendered resolution (DRAWING-BUFFER pixels — CSS size × pixel ratio),
   * the real fill-rate driver: a 1440p screen at 125 % Windows scaling
   * renders 3200 × 1800 on HIGH (pixel-ratio cap 2), not 2560 × 1440.
   */
  private bufferW = 0;
  private bufferH = 0;
  private pixelRatio = 1;
  private devicePixelRatio = 1;
  /** Static render setup line (preset, MSAA path…) — set once by the Game. */
  private renderSetup = "";
  /** GPU / backend the browser renders with (software fallback check). */
  private deviceName = "";
  /**
   * DEV: GPU execution time per frame (GpuTimer), pulled with the frame
   * stats. Null = no line (production / no timer extension).
   */
  gpuSummary: (() => string | null) | null = null;
  private gpuText = "";
  /**
   * Main-thread CPU per frame (ms), averaged + worst over the stats window:
   * `sim` = everything before the render call (AI, physics, weapons, HUD),
   * `render` = three.js render submission (scene traversal, uniforms,
   * draw calls — NOT the GPU execution, which is asynchronous).
   * Frame time ≫ sim + render ⇒ the GPU (or the compositor) is the limit.
   */
  private cpuSimSum = 0;
  private cpuRenderSum = 0;
  private cpuSamples = 0;
  private cpuWorst = 0;
  private cpuSimMs = 0;
  private cpuRenderMs = 0;
  private cpuWorstMs = 0;
  /** CPU (sim + render) of the last game frame — the "jeu" part of a hitch. */
  private lastFrameCpu = 0;
  /**
   * HITCH breakdown (frames ≥ HITCH_MS): what the browser's MAIN THREAD was
   * doing during the gap (Long Animation Frames API: scripts, style /
   * layout, rendering — GC and browser work show up as busy time without
   * scripts) vs the time it was simply WAITING (GPU process / compositor:
   * shader compiles, rasterization, presentation). Shown on the "Hitch"
   * line for 6 s and logged to the console with the scripts involved.
   */
  private readonly loaf: LoafEntry[] = [];
  private readonly hitchQueue: { start: number; end: number; gameMs: number; split: string; prev: number }[] = [];
  /**
   * Browser main-thread work AFTER each game frame: a message posted at the
   * end of the frame only runs once the browser is done with that frame's
   * rendering steps (style, layout, paint, commit) and with the tasks queued
   * before it (garbage collection included). The Long Animation Frames API
   * ignores frames under 50 ms: without this, a 35-45 ms hitch spent in
   * style / layout was reported as "waiting for the GPU".
   */
  private readonly frameEnd = new MessageChannel();
  private frameId = 0;
  private readonly frameEndAt = new Float64Array(POST_RING);
  private readonly postMs = new Float64Array(POST_RING);
  private readonly postId = new Int32Array(POST_RING).fill(-1);
  /** DEV: per-section CPU split of each game frame (null = no split shown). */
  private sections: FrameSections | null = null;
  private hitchText = "";
  private hitchUntil = 0;
  /** Distinct rAF timestamps, including ticks skipped by the FPS cap. */
  private rafRate = 0;
  private callbackRate = 0;
  private duplicateCallbacks = 0;
  private rafWindowStart: number | null = null;
  private lastRafTimestamp: number | null = null;
  private rafCallbacks = 0;
  private rafUnique = 0;

  constructor() {
    this.el = document.getElementById("debug")!;
    this.frameEnd.port1.onmessage = (e: MessageEvent<number>) => {
      const id = e.data;
      const k = id % POST_RING;
      this.postMs[k] = performance.now() - this.frameEndAt[k];
      this.postId[k] = id;
    };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.loaf.push(e as unknown as LoafEntry);
        if (this.loaf.length > 64) this.loaf.splice(0, this.loaf.length - 64);
      }).observe({ type: "long-animation-frame", buffered: false });
    } catch {
      // No Long Animation Frames API: hitches still show (no main-thread split).
    }
  }

  /**
   * Capture draw calls / triangles — MUST be called right AFTER the world
   * render pass: three.js resets renderer.info before each render pass
   * (autoReset). These numbers exclude the separate arms/weapon pass.
   */
  sampleRenderInfo(renderer: THREE.WebGLRenderer): void {
    this.drawCalls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
    const canvas = renderer.domElement;
    this.bufferW = canvas.width;
    this.bufferH = canvas.height;
    this.pixelRatio = renderer.getPixelRatio();
    this.devicePixelRatio = window.devicePixelRatio || 1;
  }

  /** Per-frame CPU split (ms) — see the cpu* fields. */
  sampleCpu(simMs: number, renderMs: number): void {
    this.cpuSimSum += simMs;
    this.cpuRenderSum += renderMs;
    this.cpuSamples++;
    this.cpuWorst = Math.max(this.cpuWorst, simMs + renderMs);
    this.lastFrameCpu = simMs + renderMs;
  }

  /**
   * End of a game frame (after the render submission): times the browser's
   * main-thread work that follows it (see frameEnd).
   */
  markFrameEnd(): void {
    const id = ++this.frameId;
    this.frameEndAt[id % POST_RING] = performance.now();
    this.frameEnd.port2.postMessage(id);
  }

  /** DEV: the game's per-section frame split, quoted on the "Hitch" line. */
  setFrameSections(sections: FrameSections | null): void {
    this.sections = sections;
  }

  /** One-line static render setup (preset, AA path…), shown under the resolution. */
  setRenderSetup(text: string): void {
    this.renderSetup = text;
  }

  /** GPU name line (see GraphicsQuality.webglRendererName). */
  setDeviceName(name: string): void {
    this.deviceName = name;
  }

  /** Reset timing windows when gameplay starts (not on Escape/resume). */
  resetFrameStats(): void {
    this.samples.length = 0;
    this.fps = this.avgMs = this.p95Ms = this.maxMs = 0;
    this.statsTimer = this.refreshTimer = 0;
    this.rafRate = this.callbackRate = this.duplicateCallbacks = 0;
    this.rafWindowStart = this.lastRafTimestamp = null;
    this.rafCallbacks = this.rafUnique = 0;
  }

  /**
   * Called BEFORE the FPS cap. Returns false for a duplicate timestamp so
   * the caller can skip redundant simulation/rendering, while still
   * reporting the duplicate. Not a replacement for fixing loop ownership.
   */
  sampleAnimationFrame(timestamp: number): boolean {
    const unique = timestamp !== this.lastRafTimestamp;
    if (this.rafWindowStart === null) this.rafWindowStart = timestamp;
    const span = timestamp - this.rafWindowStart;
    // Close the PREVIOUS window before counting the new timestamp: both
    // callbacks of a duplicated refresh must stay in the same window.
    if (unique && span >= 500) {
      this.rafRate = this.rafUnique * 1000 / span;
      this.callbackRate = this.rafCallbacks * 1000 / span;
      this.duplicateCallbacks = this.rafCallbacks - this.rafUnique;
      this.rafCallbacks = this.rafUnique = 0;
      this.rafWindowStart = timestamp;
    }
    this.rafCallbacks++;
    if (unique) this.rafUnique++;
    this.lastRafTimestamp = timestamp;
    return unique;
  }

  update(rawDt: number, movement: PlayerMovement, scene?: THREE.Scene): void {
    this.samples.push(rawDt);
    this.statsTimer += rawDt;
    const now = performance.now();
    // (A gap over 1 s is a hidden tab / breakpoint, not a hitch.)
    if (rawDt * 1000 >= HITCH_MS && rawDt < 1) {
      // The gap holds the PREVIOUS frame's game CPU: its committed split.
      this.hitchQueue.push({
        start: now - rawDt * 1000,
        end: now,
        gameMs: this.lastFrameCpu,
        split: this.sections?.top() ?? "",
        prev: this.frameId,
      });
    }
    // LoAF entries arrive a little after their frame: analyse with a delay.
    while (this.hitchQueue.length > 0 && now - this.hitchQueue[0].end > 250) {
      this.analyseHitch(this.hitchQueue.shift()!, now);
    }
    if (this.statsTimer >= 0.5) {
      const n = this.samples.length;
      let total = 0;
      let max = 0;
      for (const s of this.samples) {
        total += s;
        if (s > max) max = s;
      }
      this.fps = Math.round(n / total);
      this.avgMs = (total / n) * 1000;
      const sorted = this.samples.slice().sort((a, b) => a - b);
      this.p95Ms = sorted[Math.min(n - 1, Math.floor(n * 0.95))] * 1000;
      this.maxMs = max * 1000;
      this.samples.length = 0;
      this.statsTimer = 0;
      if (this.cpuSamples > 0) {
        this.cpuSimMs = this.cpuSimSum / this.cpuSamples;
        this.cpuRenderMs = this.cpuRenderSum / this.cpuSamples;
        this.cpuWorstMs = this.cpuWorst;
      }
      this.cpuSimSum = this.cpuRenderSum = this.cpuWorst = 0;
      this.cpuSamples = 0;
      if (this.gpuSummary) this.gpuText = this.gpuSummary() ?? this.gpuText;

      // Light census: three.js forward lighting shades EVERY scene light
      // per pixel — lit or not — so the TOTAL is what costs GPU time.
      // PERF: the scene walk (thousands of nodes: map, bones…) only runs
      // every 5 s — the light set is fixed by design (FX light pool); the
      // "lit" count is re-read from the cached list at every refresh.
      if (scene) {
        this.censusTimer -= 0.5;
        if (this.censusTimer <= 0) {
          this.censusTimer = 5;
          this.lights.length = 0;
          scene.traverse((obj) => {
            const light = obj as THREE.Light;
            if (!light.isLight || (light as THREE.Light & { isAmbientLight?: boolean }).isAmbientLight) return;
            this.lights.push(light);
          });
        }
        let active = 0;
        for (const light of this.lights) if (light.intensity > 0) active++;
        this.lightsTotal = this.lights.length;
        this.lightsActive = active;
      }
    }

    // Refresh text at ~15 Hz — enough for debugging, no DOM spam.
    this.refreshTimer += rawDt;
    if (this.refreshTimer < 1 / 15) return;
    this.refreshTimer = 0;

    const v = movement.velocity;
    const pd = movement.phaseDebug;
    this.el.textContent =
      `Speed:    ${movement.horizontalSpeed.toFixed(1)}\n` +
      `Grounded: ${movement.grounded}\n` +
      `State:    ${movement.state}\n` +
      `Velocity: ${v.x.toFixed(1)} / ${v.y.toFixed(1)} / ${v.z.toFixed(1)}\n` +
      `FPS:      ${this.fps}\n` +
      `rAF:      ${Math.round(this.rafRate)} unique/s / ${Math.round(this.callbackRate)} calls/s (dup ${this.duplicateCallbacks})\n` +
      `Frame:    ${this.avgMs.toFixed(1)} ms (p95 ${this.p95Ms.toFixed(1)} / max ${this.maxMs.toFixed(1)})\n` +
      `CPU:      ${(this.cpuSimMs + this.cpuRenderMs).toFixed(1)} ms (sim ${this.cpuSimMs.toFixed(1)} / render ${this.cpuRenderMs.toFixed(1)} / max ${this.cpuWorstMs.toFixed(1)})\n` +
      (this.gpuText ? `GPU:      ${this.gpuText}\n` : "") +
      `World:    ${this.drawCalls} draws / ${(this.triangles / 1000).toFixed(0)}k tris\n` +
      `Render:   ${this.bufferW}x${this.bufferH} (ratio ${this.pixelRatio.toFixed(2)} / DPR ${this.devicePixelRatio.toFixed(2)})\n` +
      (this.renderSetup ? `Setup:    ${this.renderSetup}\n` : "") +
      (this.deviceName ? `Device:   ${this.deviceName}\n` : "") +
      (this.hitchText && performance.now() < this.hitchUntil ? `Hitch:    ${this.hitchText}\n` : "") +
      `Lights:   ${this.lightsTotal} (${this.lightsActive} lit)\n` +
      `\n` +
      `Dash:     ${movement.dashReady ? "READY" : "COOLDOWN"}\n` +
      `Phase:    ${movement.phaseEligible ? "YES" : "NO"}\n` +
      `Grace:    ${movement.phaseGraceActive ? "ACTIVE" : "INACTIVE"}\n` +
      `Phase Wall: ${pd.wallPhaseable ? "TRUE" : "FALSE"}\n` +
      `Exit Clear: ${pd.exitClear ? "TRUE" : "FALSE"}\n` +
      `Wall Thickness: ${pd.wallThickness.toFixed(1)}`;
  }

  /**
   * Split one long frame gap: `jeu` = the game frame's own CPU, `navigateur`
   * = other main-thread work inside the gap (style / layout / paint, GC,
   * tasks), `attente` = the rest: the main thread was idle, waiting for the
   * GPU process / compositor (shader compiles, raster, presentation).
   */
  private analyseHitch(
    h: { start: number; end: number; gameMs: number; split: string; prev: number },
    now: number,
  ): void {
    const gap = h.end - h.start;
    let busy = 0;
    let scriptMs = 0;
    let styleMs = 0;
    let renderMs = 0;
    const scripts: LoafScript[] = [];
    for (const l of this.loaf) {
      const end = l.startTime + l.duration;
      const overlap = Math.min(end, h.end) - Math.max(l.startTime, h.start);
      if (overlap <= 0) continue;
      busy += overlap;
      if (l.renderStart > 0) renderMs += end - l.renderStart;
      if (l.styleAndLayoutStart > 0) styleMs += end - l.styleAndLayoutStart;
      for (const sc of l.scripts ?? []) {
        scriptMs += sc.duration;
        scripts.push(sc);
      }
    }
    const game = Math.min(h.gameMs, gap);
    // Browser work after the game frame (measured for every frame) or, for
    // frames of 50 ms and more, the Long Animation Frame's non-game time.
    const k = h.prev % POST_RING;
    const post = this.postId[k] === h.prev ? this.postMs[k] : 0;
    const loafBrowser = busy - Math.min(busy, scriptMs, game);
    const browser = Math.max(0, Math.min(gap - game, Math.max(post, loafBrowser)));
    const wait = Math.max(0, gap - game - browser);
    this.hitchText =
      `${gap.toFixed(0)} ms = jeu ${game.toFixed(0)}${h.split && game >= 5 ? ` (${h.split})` : ""}` +
      ` + navigateur ${browser.toFixed(0)} + attente GPU ${wait.toFixed(0)}`;
    this.hitchUntil = now + 6000;
    // Console: every hitch while developing; production keeps only the big ones.
    if (!import.meta.env.DEV && gap < 60) return;
    const top = scripts
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 4)
      .map((sc) => {
        const src = (sc.sourceURL ?? "").split("/").pop()?.split("?")[0] ?? "";
        const forced = sc.forcedStyleAndLayoutDuration ? `, layout forcé ${sc.forcedStyleAndLayoutDuration.toFixed(0)}` : "";
        return `${sc.invoker ?? "?"} ${sc.sourceFunctionName || ""} ${src} ${sc.duration.toFixed(0)} ms${forced}`.trim();
      });
    console.warn(
      `[hitch] ${this.hitchText} | thread principal occupé ${busy.toFixed(0)} ms ` +
        `(scripts ${scriptMs.toFixed(0)}, rendu ${renderMs.toFixed(0)} dont style/layout ${styleMs.toFixed(0)})` +
        (top.length ? ` | ${top.join(" ; ")}` : ""),
    );
  }
}
