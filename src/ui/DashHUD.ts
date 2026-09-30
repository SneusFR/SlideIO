import { PlayerMovement } from "../player/PlayerMovement";
import { MovementConfig as cfg } from "../player/MovementConfig";
import { BOLT_SVG } from "./hudIcons";
import { replayAnim } from "./hudKit";

/**
 * Dash readout — the lightning pill under the Bean Buddy's health tube:
 * the pill refills like a liquid (scaleX, GPU only) during the cooldown,
 * the E key cap hops + the pill sparkles when the dash is back, and it
 * flashes white while dashing. Every DOM write is change-detected.
 */
export class DashHUD {
  private readonly hudEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  private lastText = "";
  private lastPercent = -1;
  private wasReady = true;
  private lastReady: boolean | null = null;
  private lastDashing: boolean | null = null;

  constructor() {
    this.hudEl = document.getElementById("dash-hud")!;
    this.fillEl = document.getElementById("dash-fill")!;
    this.statusEl = document.getElementById("dash-status")!;
    const boltSlot = document.getElementById("dash-bolt-slot");
    if (boltSlot) boltSlot.innerHTML = BOLT_SVG;
  }

  update(_dt: number, movement: PlayerMovement): void {
    const remaining = movement.dashCooldownRemaining;
    const ready = remaining <= 0;

    // Sparkle pop the moment the cooldown finishes.
    if (ready && !this.wasReady) replayAnim(this.hudEl, "recharged");
    this.wasReady = ready;

    const text = ready ? "" : remaining.toFixed(1);
    if (text !== this.lastText) {
      this.lastText = text;
      this.statusEl.textContent = text;
    }

    const percent = ready ? 100 : Math.round((1 - remaining / cfg.dashCooldown) * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.fillEl.style.transform = `scaleX(${percent / 100})`;
    }

    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.hudEl.classList.toggle("ready", ready);
    }
    const dashing = movement.isDashing;
    if (dashing !== this.lastDashing) {
      this.lastDashing = dashing;
      this.hudEl.classList.toggle("dashing", dashing);
    }
  }
}
