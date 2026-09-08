/** Landmarks of the authored Slide clip; only the middle segment repeats. */
export const SLIDE_POSE = { loopStart: 10 / 30, loopEnd: 33 / 30, recovery: 1.40, end: 1.5 };

/** Visual timing only. Gameplay decides when sliding ends or is interrupted. */
export class SlidePresentation {
  time = 0;
  start(): void { this.time = 0; }
  recover(): void { this.time = SLIDE_POSE.loopEnd; }
  update(dt: number, speed: number): void {
    let remaining = Math.min(Math.max(dt, 0), 0.1);
    if (this.time < SLIDE_POSE.loopStart) {
      const entry = Math.min(remaining, SLIDE_POSE.loopStart - this.time);
      this.time += entry;
      remaining -= entry;
    }
    if (this.time >= SLIDE_POSE.loopStart) {
      const rate = Math.max(0.8, Math.min(1.25, Math.abs(speed) / 12));
      const length = SLIDE_POSE.loopEnd - SLIDE_POSE.loopStart;
      this.time = SLIDE_POSE.loopStart +
        (this.time - SLIDE_POSE.loopStart + remaining * rate) % length;
    }
  }
  updateRecovery(dt: number): void {
    this.time = Math.min(SLIDE_POSE.end, this.time + Math.min(Math.max(dt, 0), 0.1) * 1.35);
  }
}
