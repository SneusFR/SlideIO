/**
 * DEV (debug HUD "Hitch" line): where the game's CPU time of ONE frame went.
 * Game.frame() calls lap("name") at the end of each section (a dozen
 * performance.now() per frame); commit() at the end of the frame keeps that
 * frame's split. A long frame is then reported as "armes bots 24 · rendu 6
 * · physique 3" instead of a single total.
 */
const MAX_SECTIONS = 16;

export class FrameSections {
  private readonly names: string[] = new Array(MAX_SECTIONS).fill("");
  private readonly ms = new Float64Array(MAX_SECTIONS);
  private n = 0;
  private t = 0;
  /** Split of the last COMMITTED frame. */
  private readonly lastNames: string[] = new Array(MAX_SECTIONS).fill("");
  private readonly lastMs = new Float64Array(MAX_SECTIONS);
  private lastN = 0;

  /** Start of the frame (same clock as performance.now()). */
  begin(now: number): void {
    this.n = 0;
    this.t = now;
  }

  /** Close the current section: the time since the previous lap goes to `name`. */
  lap(name: string): void {
    const now = performance.now();
    if (this.n < MAX_SECTIONS) {
      this.names[this.n] = name;
      this.ms[this.n] = now - this.t;
      this.n++;
    }
    this.t = now;
  }

  /** End of the frame: its split becomes the reported one. */
  commit(): void {
    for (let i = 0; i < this.n; i++) {
      this.lastNames[i] = this.names[i];
      this.lastMs[i] = this.ms[i];
    }
    this.lastN = this.n;
  }

  /** "armes bots 24 · rendu 6 · physique 3": the heaviest sections of the last frame. */
  top(count = 3, minMs = 1): string {
    const sums = new Map<string, number>();
    for (let i = 0; i < this.lastN; i++) {
      sums.set(this.lastNames[i], (sums.get(this.lastNames[i]) ?? 0) + this.lastMs[i]);
    }
    return [...sums]
      .filter(([, v]) => v >= minMs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`)
      .join(" · ");
  }
}
