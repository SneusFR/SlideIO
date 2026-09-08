export interface ViewmodelMotionInput {
  grounded: boolean;
  verticalVelocity: number;
  /** Increments when physics accepts a jump (including buffered/wall jumps). */
  jumpSequence: number;
  straight: boolean;
}

/** One bounded spring moves the complete arms/weapon group; never the aim ray. */
export class ViewmodelJumpMotion {
  offsetY = 0;
  private displacement = 0;
  private velocity = 0;
  private grounded: boolean | null = null;
  private sequence = 0;
  private fallSpeed = 0;
  private airTime = 0;

  reset(): void {
    this.offsetY = this.displacement = this.velocity = this.fallSpeed = this.airTime = 0;
    this.grounded = null;
  }

  update(dt: number, input: ViewmodelMotionInput): void {
    if (this.grounded === null) {
      this.grounded = input.grounded;
      this.sequence = input.jumpSequence;
    }
    const jumped = input.jumpSequence !== this.sequence;
    const landed = !this.grounded && input.grounded && this.airTime > 0.06;
    if (jumped) {
      // Replace residual landing energy on an immediate bunny hop.
      this.velocity = -0.26 * [1, 0.95, 1.05][input.jumpSequence % 3];
      this.airTime = 0;
      this.fallSpeed = 0;
    } else if (landed) {
      this.velocity = -Math.min(0.42, Math.max(0.12, this.fallSpeed * 0.037));
      this.fallSpeed = 0;
    }
    if (!input.grounded) {
      this.airTime += dt;
      this.fallSpeed = Math.max(this.fallSpeed, -input.verticalVelocity);
    } else this.airTime = 0;
    this.grounded = input.grounded;
    this.sequence = input.jumpSequence;
    // Stable integration even after a slow frame; 2 cm travel is a hard limit.
    // A tiny airborne float follows vertical speed continuously through the apex.
    const target = input.grounded ? 0 : Math.max(-0.003, Math.min(0.003, -input.verticalVelocity * 0.00035));
    let remaining = Math.min(Math.max(dt, 0), 0.1);
    while (remaining > 1e-8) {
      const step = Math.min(remaining, 1 / 120);
      this.velocity += (230 * (target - this.displacement) - 20 * this.velocity) * step;
      this.displacement += this.velocity * step;
      if (Math.abs(this.displacement) > 0.02) {
        this.displacement = Math.sign(this.displacement) * 0.02;
        this.velocity = 0;
      }
      remaining -= step;
    }
    // No pitch/yaw/roll while aiming or attacking, including tongue return.
    this.offsetY = this.displacement * (input.straight ? 0.15 : 1);
  }
}
