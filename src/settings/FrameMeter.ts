/**
 * A rendered frame: its start (performance.now, ms), its main-thread time
 * (ms) and, within it, the render submission (ms: 0 when unknown) — the part
 * that also waits for the browser's GPU process when the graphics fall behind.
 */
export type FrameListener = (t: number, cpuMs: number, renderMs: number) => void;

export interface LiveStats {
  /** Frames delivered per second over the window. */
  fps: number;
  /** Median interval between rendered frames (ms). */
  frameMs: number;
  /** 95th percentile of the intervals (ms): the slow frames the player feels. */
  frameP95: number;
  /** Mean main-thread time of a frame (game JS + render submission, ms). */
  cpuMs: number;
  /**
   * GPU execution time per frame (ms) from the DEBUG GPU timer — only when it
   * already runs (`npm run dev`, `?gpu` in the address). Indicative: a query
   * around a whole frame also counts the GPU's idle gaps. Null otherwise: the
   * settings never add timer queries of their own (they make Chrome flush:
   * they would change what they measure).
   */
  gpuMs: number | null;
}

const RING = 512;

/**
 * Frame timings for the graphics settings: every rendered frame (menu
 * preview, pause, play) is recorded with its main-thread time, in fixed
 * typed arrays (nothing allocated per frame). The automatic detection
 * listens to the frames; the settings page reads a summary four times a
 * second.
 */
export class FrameMeter {
  private readonly listeners: FrameListener[] = [];
  private readonly frameT = new Float64Array(RING);
  private readonly frameCpu = new Float64Array(RING);
  private frameCount = 0;
  private readonly gpuT = new Float64Array(64);
  private readonly gpuMs = new Float64Array(64);
  private gpuCount = 0;

  /** Every rendered frame goes to `listener` until the returned function is called. */
  addListener(listener: FrameListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The frame is done: `t` = its start, `cpuMs` = its main-thread time, `renderMs` = its render submission (part of it). */
  record(t: number, cpuMs: number, renderMs = 0): void {
    const k = this.frameCount % RING;
    this.frameT[k] = t;
    this.frameCpu[k] = cpuMs;
    this.frameCount++;
    const listeners = this.listeners;
    for (let i = 0; i < listeners.length; i++) listeners[i](t, cpuMs, renderMs);
  }

  /** A frame's GPU time from the debug GPU timer (see LiveStats.gpuMs). */
  recordGpu(t: number, ms: number): void {
    const k = this.gpuCount % this.gpuT.length;
    this.gpuT[k] = t;
    this.gpuMs[k] = ms;
    this.gpuCount++;
  }

  /**
   * Summary of the last `windowMs` (the settings page's live card) — or of
   * the last 4 frames when fewer came in that window (a very slow machine),
   * as long as they are under 5 s old. Null without such frames.
   */
  stats(now: number, windowMs = 1000): LiveStats | null {
    const n = Math.min(this.frameCount, RING);
    const intervals: number[] = [];
    let cpuSum = 0;
    let frames = 0;
    let newest = 0;
    let oldest = 0;
    let next: number | null = null;
    for (let i = this.frameCount - 1; i >= this.frameCount - n; i--) {
      const t = this.frameT[i % RING];
      if (t < now - windowMs && (frames >= 4 || t < now - 5000)) break;
      if (next !== null) intervals.push(next - t);
      else newest = t;
      next = t;
      oldest = t;
      cpuSum += this.frameCpu[i % RING];
      frames++;
    }
    if (frames < 3) return null;
    intervals.sort((a, b) => a - b);
    const at = (p: number): number => intervals[Math.min(intervals.length - 1, Math.floor(p * (intervals.length - 1) + 0.5))];
    const gpu: number[] = [];
    const g = Math.min(this.gpuCount, this.gpuT.length);
    for (let i = this.gpuCount - g; i < this.gpuCount; i++) {
      const k = i % this.gpuT.length;
      if (this.gpuT[k] >= now - windowMs) gpu.push(this.gpuMs[k]);
    }
    gpu.sort((a, b) => a - b);
    return {
      fps: newest > oldest ? ((frames - 1) * 1000) / (newest - oldest) : 0,
      frameMs: at(0.5),
      frameP95: at(0.95),
      cpuMs: cpuSum / frames,
      gpuMs: gpu.length >= 3 ? gpu[gpu.length >> 1] : null,
    };
  }
}
