import { PlayerMovement } from "../player/PlayerMovement";
import { MovementConfig as cfg } from "../player/MovementConfig";

/**
 * Dash HUD: discreet "DASH [E]" indicator with a cooldown bar,
 * a live countdown and a small READY flash when the dash comes back.
 * Reads DOM elements defined in index.html.
 */
export class DashHUD {
  private readonly hudEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  private lastText = "";
  private lastPercent = -1;
  private flashTimer = 0;
  private wasReady = true;

  constructor() {
    this.hudEl = document.getElementById("dash-hud")!;
    this.fillEl = document.getElementById("dash-fill")!;
    this.statusEl = document.getElementById("dash-status")!;
  }

  update(dt: number, movement: PlayerMovement): void {
    const remaining = movement.dashCooldownRemaining;
    const ready = remaining <= 0;

    // Brief flash when the cooldown just finished.
    if (ready && !this.wasReady) this.flashTimer = 0.6;
    this.wasReady = ready;
    this.flashTimer = Math.max(0, this.flashTimer - dt);

    // Status text (only touch the DOM when the value actually changed).
    const text = ready ? "READY" : `${remaining.toFixed(1)}s`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.statusEl.textContent = text;
    }

    // Cooldown recharge bar.
    const percent = ready
      ? 100
      : Math.round((1 - remaining / cfg.dashCooldown) * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.fillEl.style.width = `${percent}%`;
    }

    this.hudEl.classList.toggle("ready", ready);
    this.hudEl.classList.toggle("flash", this.flashTimer > 0);
    this.hudEl.classList.toggle("dashing", movement.isDashing);
  }
}