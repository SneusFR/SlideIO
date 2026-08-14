import { HeatSystem } from "../weapons/HeatSystem";

/**
 * Weapon HUD: permanent (discreet) heat bar + overheat warning with
 * live cooldown countdown, plus subtle crosshair hit feedback.
 * Reads DOM elements defined in index.html.
 */
export class WeaponHUD {
  private readonly hudEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly valueEl: HTMLElement;
  private readonly warningEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly coolingEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly crosshairEl: HTMLElement;

  private readyTimer = 0;
  private wasOverheated = false;
  private lastPercent = -1;

  constructor() {
    this.hudEl = document.getElementById("heat-hud")!;
    this.fillEl = document.getElementById("heat-fill")!;
    this.valueEl = document.getElementById("heat-value")!;
    this.warningEl = document.getElementById("overheat-warning")!;
    this.titleEl = document.getElementById("overheat-title")!;
    this.coolingEl = document.getElementById("overheat-cooling")!;
    this.timeEl = document.getElementById("overheat-time")!;
    this.crosshairEl = document.getElementById("crosshair")!;
  }

  update(dt: number, heat: HeatSystem, hittingTarget: boolean): void {
    const ratio = heat.ratio;

    // Heat bar (only touch the DOM when the value actually changed).
    const percent = Math.round(ratio * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.fillEl.style.width = `${percent}%`;
      this.valueEl.textContent = `${percent}%`;
    }
    this.hudEl.classList.toggle("hot", ratio > 0.7 && !heat.overheated);
    this.hudEl.classList.toggle("overheated", heat.overheated);

    // Overheat warning + cooldown countdown / READY flash.
    if (heat.overheated) {
      this.wasOverheated = true;
      this.readyTimer = 0;
      this.warningEl.classList.remove("hidden", "ready");
      this.titleEl.textContent = "WEAPON OVERHEATED";
      this.coolingEl.style.display = "";
      this.timeEl.textContent = heat.cooldownRemaining.toFixed(1);
    } else if (this.wasOverheated) {
      // Just recovered: flash READY briefly.
      this.wasOverheated = false;
      this.readyTimer = 0.8;
      this.warningEl.classList.remove("hidden");
      this.warningEl.classList.add("ready");
      this.titleEl.textContent = "READY";
      this.coolingEl.style.display = "none";
    } else if (this.readyTimer > 0) {
      this.readyTimer -= dt;
      if (this.readyTimer <= 0) {
        this.warningEl.classList.add("hidden");
        this.warningEl.classList.remove("ready");
      }
    }

    // Subtle crosshair hit feedback.
    this.crosshairEl.classList.toggle("hit", hittingTarget);
  }
}