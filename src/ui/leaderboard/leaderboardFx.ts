import { AnimHost } from "./leaderboardAnim";

/** Hard cap: the board never owns more than this many particle elements. */
export const PARTICLE_POOL = 8;

/**
 * A fixed pool of little dots, reused for every landing. Deterministic spread
 * (no Math.random): the same event always looks the same, which keeps the
 * captures reproducible. Particles stay close to the landed row.
 */
export class ParticlePool {
  private readonly dots: HTMLElement[] = [];
  private readonly anims: Array<Animation | null> = [];

  constructor(
    private readonly host: AnimHost,
    container: HTMLElement,
  ) {
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const d = document.createElement("i");
      d.className = "lb-p";
      container.appendChild(d);
      this.dots.push(d);
      this.anims.push(null);
    }
  }

  /** Spread `count` dots along [x0, x1] at height y (design px), after `delay` ms. */
  burst(x0: number, x1: number, y: number, count: number, delay: number, palette: readonly string[]): void {
    const n = Math.min(PARTICLE_POOL, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const dot = this.dots[i];
      this.anims[i]?.cancel();
      dot.style.background = palette[i % palette.length];
      const t = (i + 0.5) / n;
      const x = x0 + t * (x1 - x0);
      const dir = i % 2 === 0 ? -1 : 1;
      const dx = dir * (3 + ((i * 5) % 7));
      const rise = 9 + ((i * 7) % 9);
      this.anims[i] = this.host.play(
        dot,
        [
          { transform: `translate(${x}px, ${y}px) scale(0.3)`, opacity: 0 },
          { transform: `translate(${x + dx * 0.5}px, ${y - rise}px) scale(1)`, opacity: 1, offset: 0.3 },
          { transform: `translate(${x + dx}px, ${y - rise + 7}px) scale(0.4)`, opacity: 0 },
        ],
        { duration: 420, delay, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
      );
    }
  }
}
