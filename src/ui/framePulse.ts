/**
 * Restart one-shot CSS animations WITHOUT a forced reflow.
 *
 * The classic trick — remove the class, read `offsetWidth`, add the class
 * back — forces the browser to compute the style AND the layout of the whole
 * page synchronously, in the middle of the game frame, with every HUD change
 * of that frame still pending. The hit-feedback HUD did it on every shot and
 * every hit (crosshair kick, hitmarker, damage number): up to three full
 * layouts per frame while firing a 600 rpm paintball.
 *
 * Instead, the animation NAME alternates between two identical keyframe
 * twins (`x` ⇄ `x-b`, through an "alt" class): a new name restarts the
 * animation at the next style update, which the browser does anyway.
 *
 * Two alternations between two rendered frames would cancel each other out
 * (same name → no restart → a missing hitmarker), so requests are applied by
 * `flush()` at most once per frame: the game calls it once per frame after
 * its HUD updates, and a requestAnimationFrame fallback catches requests
 * made outside the game frame (network messages, menus).
 */

/** Where frameStamp() reads the frame identity, when a document installs one (see setFrameStampSource). */
let stampSource: (() => number) | null = null;

/**
 * The HUD's own document (src/hud/runtime/frameEntry.ts) draws frames only
 * when something changes — no frame callback is always pending there, and
 * document.timeline's time then runs ahead between frames. It installs a
 * frame NUMBER instead, which moves once per frame actually drawn: what
 * frameStamp() must tell apart. The game page keeps document.timeline (its
 * own frame loop never stops).
 */
export function setFrameStampSource(source: (() => number) | null): void {
  stampSource = source;
}

/** Timestamp of the frame being prepared — identical for every callback of one frame. */
export function frameStamp(): number {
  if (stampSource) return stampSource();
  const t = typeof document !== "undefined" ? document.timeline?.currentTime : undefined;
  return typeof t === "number" ? t : performance.now();
}

/** requestAnimationFrame — a ~60 Hz timer in the headless test scripts (Node has none). */
const nextFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

export class FramePulse {
  private pending = false;
  private scheduled = false;
  private lastFrame = Number.NaN;

  /** `apply(restart)`: write the requested state; swap the twin only when `restart`. */
  constructor(private readonly apply: (restart: boolean) => void) {}

  /** Ask for a restart (applied by the next flush — this frame or the next one). */
  request(): void {
    this.pending = true;
    if (!this.scheduled) {
      this.scheduled = true;
      nextFrame(this.onFrame);
    }
  }

  /** Apply the pending request now (call from inside the game frame). */
  flush(): void {
    if (!this.pending) return;
    this.pending = false;
    const t = frameStamp();
    const restart = t !== this.lastFrame;
    this.lastFrame = t;
    this.apply(restart);
  }

  private readonly onFrame = (): void => {
    this.scheduled = false;
    this.flush();
  };
}
