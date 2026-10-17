import * as THREE from "three";
import { PlayerMovement } from "../player/PlayerMovement";

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
  }

  /** One-line static render setup (preset, AA path…), shown under the resolution. */
  setRenderSetup(text: string): void {
    this.renderSetup = text;
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

      // Light census: three.js forward lighting shades EVERY scene light
      // per pixel — lit or not — so the TOTAL is what costs GPU time.
      if (scene) {
        let total = 0;
        let active = 0;
        scene.traverse((obj) => {
          const light = obj as THREE.Light;
          if (!light.isLight || (light as THREE.Light & { isAmbientLight?: boolean }).isAmbientLight) return;
          total++;
          if (light.intensity > 0) active++;
        });
        this.lightsTotal = total;
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
      `World:    ${this.drawCalls} draws / ${(this.triangles / 1000).toFixed(0)}k tris\n` +
      `Render:   ${this.bufferW}x${this.bufferH} (ratio ${this.pixelRatio.toFixed(2)} / DPR ${this.devicePixelRatio.toFixed(2)})\n` +
      (this.renderSetup ? `Setup:    ${this.renderSetup}\n` : "") +
      `Lights:   ${this.lightsTotal} (${this.lightsActive} lit)\n` +
      `\n` +
      `Dash:     ${movement.dashReady ? "READY" : "COOLDOWN"}\n` +
      `Phase:    ${movement.phaseEligible ? "YES" : "NO"}\n` +
      `Grace:    ${movement.phaseGraceActive ? "ACTIVE" : "INACTIVE"}\n` +
      `Phase Wall: ${pd.wallPhaseable ? "TRUE" : "FALSE"}\n` +
      `Exit Clear: ${pd.exitClear ? "TRUE" : "FALSE"}\n` +
      `Wall Thickness: ${pd.wallThickness.toFixed(1)}`;
  }
}
