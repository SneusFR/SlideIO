import type * as THREE from "three";
import { GpuTimer } from "../ui/GpuTimer";

/** What a frame meter user receives. */
export interface FrameListener {
  /** A rendered frame: its start (performance.now, ms), its main-thread time (ms), its GPU tag. */
  frame?(t: number, cpuMs: number, tag: number): void;
  /** A frame's GPU execution time arrived (a few frames late; null = voided by a disjoint event). */
  gpu?(tag: number, ms: number | null, arrivedAt: number): void;
}

export interface LiveStats {
  /** Rendered frames per second over the window. */
  fps: number;
  /** Median interval between rendered frames (ms). */
  frameMs: number;
  /** Median main-thread time of a frame (ms). */
  cpuMs: number;
  /** Median GPU execution time (ms), null when no GPU timer reports. */
  gpuMs: number | null;
}

const RING = 256;

/**
 * Frame timings for the graphics settings: every rendered frame (menu preview,
 * pause, play) is recorded with its main-thread time and, when the browser
 * has EXT_disjoint_timer_query_webgl2, its GPU time. One GPU timer at a time
 * (WebGL forbids nested timer queries): the debug one when it exists (dev
 * builds, `?gpu`), else this meter's own — created only while someone needs
 * GPU times (the settings page open, a detection running, the dynamic
 * resolution on), never on a software renderer (SwiftShader never returns
 * results and slows down with queries in flight).
 */
export class FrameMeter {
  private own: GpuTimer | null = null;
  private ownMissing = false;
  private users = 0;
  private tag = 0;
  private open: GpuTimer | null = null;
  private readonly listeners = new Set<FrameListener>();
  private readonly frameT = new Float64Array(RING);
  private readonly frameCpu = new Float64Array(RING);
  private frameCount = 0;
  private readonly gpuT = new Float64Array(RING);
  private readonly gpuMs = new Float64Array(RING);
  private gpuCount = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly debugTimer: GpuTimer | null,
    private readonly ownAllowed: boolean,
  ) {
    if (debugTimer) debugTimer.onFrame = (ms, tag) => this.onGpu(ms, tag);
  }

  /** The timer measuring frames now (null = no GPU times). */
  private timer(): GpuTimer | null {
    if (this.debugTimer && !this.debugTimer.dead) return this.debugTimer;
    return this.own && !this.own.dead ? this.own : null;
  }

  /** True while GPU times can arrive. */
  get gpuAvailable(): boolean {
    return this.timer() !== null;
  }

  /** Someone needs GPU times (the meter's own timer is created on the first one). */
  acquire(): void {
    this.users++;
    if (this.debugTimer || this.own || this.ownMissing || !this.ownAllowed) return;
    this.own = GpuTimer.create(this.renderer);
    if (!this.own) {
      this.ownMissing = true;
      return;
    }
    this.own.onFrame = (ms, tag) => this.onGpu(ms, tag);
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.own) return;
    if (this.open === this.own) this.open = null;
    this.own.dispose();
    this.own = null;
  }

  addListener(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Right before the frame's GPU work: opens the GPU timer frame. Returns the frame's tag. */
  begin(pass = "monde"): number {
    const tag = ++this.tag;
    const timer = this.timer();
    this.open = timer;
    timer?.beginFrame(pass, tag);
    return tag;
  }

  /** Right after the frame's GPU work. */
  endGpu(): void {
    this.open?.endFrame();
    this.open = null;
  }

  /** The frame is done: `t` = its start, `cpuMs` = its main-thread time. */
  record(t: number, cpuMs: number, tag: number): void {
    const k = this.frameCount % RING;
    this.frameT[k] = t;
    this.frameCpu[k] = cpuMs;
    this.frameCount++;
    for (const l of this.listeners) l.frame?.(t, cpuMs, tag);
  }

  private onGpu(ms: number | null, tag: number): void {
    const now = performance.now();
    if (ms !== null) {
      const k = this.gpuCount % RING;
      this.gpuT[k] = now;
      this.gpuMs[k] = ms;
      this.gpuCount++;
    }
    for (const l of this.listeners) l.gpu?.(tag, ms, now);
  }

  /** Medians over the last `windowMs` (the settings page's live readout). */
  stats(now: number, windowMs = 1000): LiveStats | null {
    const intervals: number[] = [];
    const cpu: number[] = [];
    const n = Math.min(this.frameCount, RING);
    let first = Infinity;
    let last = -Infinity;
    let count = 0;
    let prev: number | null = null;
    for (let i = this.frameCount - n; i < this.frameCount; i++) {
      const t = this.frameT[i % RING];
      if (t < now - windowMs) continue;
      if (prev !== null) intervals.push(t - prev);
      prev = t;
      cpu.push(this.frameCpu[i % RING]);
      first = Math.min(first, t);
      last = Math.max(last, t);
      count++;
    }
    if (count < 3) return null;
    const gpu: number[] = [];
    const g = Math.min(this.gpuCount, RING);
    for (let i = this.gpuCount - g; i < this.gpuCount; i++) {
      if (this.gpuT[i % RING] >= now - windowMs) gpu.push(this.gpuMs[i % RING]);
    }
    const median = (v: number[]): number => {
      const s = [...v].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    return {
      fps: last > first ? ((count - 1) * 1000) / (last - first) : 0,
      frameMs: median(intervals),
      cpuMs: median(cpu),
      gpuMs: gpu.length >= 3 ? median(gpu) : null,
    };
  }
}
