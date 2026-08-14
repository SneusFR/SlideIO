import { PlayerMovement } from "../player/PlayerMovement";

/** Minimal development HUD: speed, state, velocity, FPS. */
export class DebugHUD {
  private el: HTMLElement;
  private frames = 0;
  private fps = 0;
  private fpsTimer = 0;
  private refreshTimer = 0;

  constructor() {
    this.el = document.getElementById("debug")!;
  }

  update(dt: number, movement: PlayerMovement): void {
    this.frames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTimer);
      this.frames = 0;
      this.fpsTimer = 0;
    }

    // Refresh text at ~15 Hz — enough for debugging, no DOM spam.
    this.refreshTimer += dt;
    if (this.refreshTimer < 1 / 15) return;
    this.refreshTimer = 0;

    const v = movement.velocity;
    const pd = movement.phaseDebug;
    this.el.textContent =
      `Speed:    ${movement.horizontalSpeed.toFixed(1)}\n` +
      `Grounded: ${movement.grounded}\n` +
      `State:    ${movement.state}\n` +
      `Velocity: ${v.x.toFixed(1)} / ${v.y.toFixed(1)} / ${v.z.toFixed(1)}\n` +
      `FPS:      ${this.fps}\n` +
      `\n` +
      `Dash:     ${movement.dashReady ? "READY" : "COOLDOWN"}\n` +
      `Phase:    ${movement.phaseEligible ? "YES" : "NO"}\n` +
      `Grace:    ${movement.phaseGraceActive ? "ACTIVE" : "INACTIVE"}\n` +
      `Phase Wall: ${pd.wallPhaseable ? "TRUE" : "FALSE"}\n` +
      `Exit Clear: ${pd.exitClear ? "TRUE" : "FALSE"}\n` +
      `Wall Thickness: ${pd.wallThickness.toFixed(1)}`;
  }
}
