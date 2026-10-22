/**
 * The HUD document's frames, ON DEMAND (frameEntry.ts) — pure logic, unit
 * tested in Node (scripts/test-hud-frame-clock.mts).
 *
 * PERF (`?diag=nohudidle` = the old permanent loop): a frame callback always
 * pending made the HUD document run a main frame at every display refresh,
 * whatever happened: each one re-sampled every running CSS animation of the
 * HUD (the Bean Buddy's idle, its leaves and blink, the dash chevrons, the
 * key cap…) — style, layout (SVG transforms), pre-paint, layerize and a
 * commit per refresh: the debug line's "rendu 1.8-2.3 ms" at rest on the
 * Iris Xe laptop, although those animations run on the compositor. Now this
 * document's own frame callback is only registered for a frame it draws
 * anyway: someone asked for a frame (the plate paint, the warm-up —
 * requestAnimationFrame is wrapped), the DOM changed (a batch that changed
 * nothing draws nothing), or a FramePulse restart needs the frame number.
 * At rest the HUD's main thread does nothing; its animations keep running on
 * the compositor.
 *
 * The frame NUMBER replaces document.timeline for frameStamp(): without a
 * callback always pending, the timeline's time runs ahead between frames
 * (Chrome estimates the next frame), and two batches applied before the same
 * frame could read different times. The number moves at the first callback
 * of each frame — this callback is always registered before any other one of
 * that frame — so every batch applied before a frame reads the same number,
 * as with the permanent loop, and a batch applied after it reads the next.
 */
export interface FrameClockEnv {
  /** The browser's own requestAnimationFrame (before the wrapping). */
  requestFrame(callback: () => void): void;
  now(): number;
}

export class FrameClock {
  /** Moves at the first callback of each frame drawn (see frameStamp). */
  frameNumber = 0;
  /** Frames counted since the start (pong). */
  frames = 0;
  /**
   * Until the HUD is built: every frame (the isolation check counts them
   * while the game page's thread is blocked).
   */
  loopForever = true;
  /** Frames counted until this time (after a ping: the harness's isolation checks). */
  loopUntil = -Infinity;
  /** Called in this document's callback of every frame drawn (stats: count, time the rendering). */
  onFrame: (() => void) | null = null;
  private pending = false;

  /** `permanent`: the old permanent loop (`?diag=nohudidle`). */
  constructor(
    private readonly env: FrameClockEnv,
    readonly permanent = false,
  ) {}

  /** This document's callback, registered (first) for the next frame it draws. */
  watch(): void {
    if (this.pending) return;
    this.pending = true;
    this.env.requestFrame(this.tick);
  }

  /** frameStamp(): the frame number — and this frame is watched. */
  stamp(): number {
    this.watch();
    return this.frameNumber;
  }

  /** Frames counted for `ms` from now (the old loop's counter, for a while). */
  countFor(ms: number): void {
    this.loopUntil = Math.max(this.loopUntil, this.env.now() + ms);
    this.watch();
  }

  /** `window.requestAnimationFrame` as the HUD document sees it: its own callback goes first. */
  wrap<T>(raf: (callback: FrameRequestCallback) => T): (callback: FrameRequestCallback) => T {
    return (callback) => {
      this.watch();
      return raf(callback);
    };
  }

  private readonly tick = (): void => {
    this.pending = false;
    this.frameNumber++;
    this.frames++;
    this.onFrame?.();
    if (this.loopForever || this.permanent || this.env.now() < this.loopUntil) this.watch();
  };
}
