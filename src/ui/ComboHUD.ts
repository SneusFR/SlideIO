import { ComboManager } from "../combo/ComboManager";

/**
 * Combo bar near the weapon zone (bottom-right, just above the HEAT HUD —
 * never covering the Plasma Rifle viewmodel).
 *
 * The bar shows the TIME REMAINING before the combo is lost (full right
 * after each kill, then draining), plus "COMBO xN" and the seconds left.
 * Violet identity with a glow that intensifies slightly per tier:
 *   x1 light glow · x2 stronger · x3+ energetic pulse — always elegant.
 */
export class ComboHUD {
  private readonly root = document.getElementById("combo-hud") as HTMLDivElement;
  private readonly count = document.getElementById("combo-count") as HTMLSpanElement;
  private readonly fill = document.getElementById("combo-fill") as HTMLDivElement;
  private readonly time = document.getElementById("combo-time") as HTMLDivElement;

  private lastCount = 0;

  /**
   * A kill just refreshed the timer: instant refill + violet punch/flash
   * ("I saved my combo at the last moment").
   */
  notifyKill(): void {
    this.root.classList.remove("pulse");
    void this.root.offsetWidth; // reflow → retrigger the one-shot animation
    this.root.classList.add("pulse");
  }

  /** Observe the combo state every frame (display only, no gameplay). */
  update(combo: ComboManager): void {
    if (!combo.active) {
      if (!this.root.classList.contains("hidden")) {
        this.root.classList.add("hidden");
        this.root.classList.remove("pulse", "tier-2", "tier-3");
      }
      this.lastCount = 0;
      return;
    }

    this.root.classList.remove("hidden");

    if (combo.comboCount !== this.lastCount) {
      this.lastCount = combo.comboCount;
      this.count.textContent = `x${combo.comboCount}`;
    }

    this.fill.style.width = `${(combo.ratio * 100).toFixed(1)}%`;
    this.time.textContent = `${combo.timeRemaining.toFixed(1)}s`;

    // Glow tiers: x1 (base) / x2 / x3+ (subtle pulse).
    this.root.classList.toggle("tier-2", combo.comboCount === 2);
    this.root.classList.toggle("tier-3", combo.comboCount >= 3);
  }
}