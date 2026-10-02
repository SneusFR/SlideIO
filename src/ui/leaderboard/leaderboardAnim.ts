/**
 * Tiny Web Animations host for the leaderboard: every animation it starts is
 * tracked, so the HUD can cancel everything at once (rebuild / dispose) and the
 * tooling can verify nothing is left running at rest. `timeScale` > 1 = slow
 * motion (dev tooling only; the game keeps 1).
 */
export interface PlayOpts {
  /** ms at normal speed */
  duration: number;
  delay?: number;
  easing?: string;
  fill?: FillMode;
}

export class AnimHost {
  /** 1 = real time · 4 = four times slower (preview slow-motion). */
  timeScale = 1;
  private readonly live = new Set<Animation>();

  /** Animations currently running or scheduled (0 when the board is at rest). */
  get active(): number {
    return this.live.size;
  }

  play(el: Element, keyframes: Keyframe[], o: PlayOpts, done?: () => void): Animation {
    const ts = this.timeScale;
    const a = el.animate(keyframes, {
      duration: Math.max(1, o.duration * ts),
      delay: (o.delay ?? 0) * ts,
      easing: o.easing ?? "linear",
      fill: o.fill ?? "none",
    });
    this.live.add(a);
    a.addEventListener("finish", () => {
      this.live.delete(a);
      done?.();
    });
    a.addEventListener("cancel", () => {
      this.live.delete(a);
    });
    return a;
  }

  cancelAll(): void {
    for (const a of [...this.live]) a.cancel();
    this.live.clear();
  }
}
