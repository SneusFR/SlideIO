/** Cosmetic timing only. World movement and collision remain owned by physics. */
export const JUMP_POSE = {
  takeoff: 11 / 30,
  apex: 19 / 30,
  preLand: 26 / 30,
  recovery: 1.10,
  end: 1.3,
} as const;

/** Continuous airborne sampling; also catches a bounce between network samples. */
export class JumpPresentation {
  time: number = JUMP_POSE.takeoff;
  private launchSpeed = 8.8;
  private falling = false;
  private elapsed = 0;

  start(verticalVelocity: number): void {
    this.launchSpeed = Math.max(4, verticalVelocity);
    this.falling = verticalVelocity < -0.5;
    this.elapsed = 0;
    this.time = verticalVelocity <= 0 ? JUMP_POSE.apex : JUMP_POSE.takeoff;
  }

  update(dt: number, verticalVelocity: number): boolean {
    this.elapsed += dt;
    const bounced = this.falling && verticalVelocity > 2 && this.elapsed > 0.12;
    if (bounced) this.start(verticalVelocity);
    if (verticalVelocity < -0.5) this.falling = true;
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    const phase = this.falling
      ? JUMP_POSE.apex + (JUMP_POSE.preLand - JUMP_POSE.apex) * clamp(-verticalVelocity / this.launchSpeed)
      : JUMP_POSE.takeoff + (JUMP_POSE.apex - JUMP_POSE.takeoff) * clamp(1 - verticalVelocity / this.launchSpeed);
    // Monotonic within a jump: noisy apex velocities cannot flap the knees.
    this.time = Math.max(this.time, phase);
    return bounced;
  }
}
