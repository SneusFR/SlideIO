/** Small inertial movement of the complete arms/weapon group, in metres. */
export class ViewmodelSlideMotion {
  offsetY = 0;
  private displacement = 0;
  private velocity = 0;
  private phase = 0;
  reset(): void { this.offsetY = this.displacement = this.velocity = this.phase = 0; }
  update(dt: number, sliding: boolean, speed: number, straight: boolean): void {
    let remaining = Math.min(Math.max(dt, 0), 0.1);
    const rate = Math.max(0.8, Math.min(1.25, Math.abs(speed) / 12));
    while (remaining > 1e-8) {
      const step = Math.min(remaining, 1 / 120);
      this.phase = sliding ? this.phase + step * rate * Math.PI * 2 / 0.77 : 0;
      const target = sliding ? -0.014 + 0.0015 * Math.sin(this.phase) : 0;
      this.velocity += (210 * (target - this.displacement) - 23 * this.velocity) * step;
      this.displacement += this.velocity * step;
      remaining -= step;
    }
    this.offsetY = this.displacement * (straight ? 0.15 : 1);
  }
}
