import { Health } from "../combat/Combatant";
import { CombatConfig as cc } from "../combat/CombatConfig";

/**
 * Player combat UI: health bar, continuous damage vignette (throttled —
 * no per-hit flashes at 60 Hz), kill feedback and the death screen.
 */
export class CombatHUD {
  private readonly healthHud = document.getElementById("health-hud")!;
  private readonly healthFill = document.getElementById("health-fill")!;
  private readonly healthValue = document.getElementById("health-value")!;
  private readonly vignette = document.getElementById("damage-vignette")!;
  private readonly killFeedback = document.getElementById("kill-feedback")!;
  private readonly deathScreen = document.getElementById("death-screen")!;
  private readonly deathTimerEl = document.getElementById("death-timer")!;

  private vignetteOpacity = 0;
  private lastVignetteShown = -1;
  private lastHpShown = -1;
  private killTimer = 0;

  /** Call when the player takes damage (any amount, any frequency). */
  notifyDamage(amount: number): void {
    // Continuous-friendly: opacity rises with damage, decays over time.
    this.vignetteOpacity = Math.min(
      cc.damageVignetteMax,
      this.vignetteOpacity + amount * 0.02,
    );
  }

  /** Call when the player kills a bot. */
  notifyKill(): void {
    this.killTimer = cc.killFeedbackDuration;
    // Restart the CSS pop animation.
    this.killFeedback.classList.remove("hidden");
    (this.killFeedback as HTMLElement).style.animation = "none";
    void (this.killFeedback as HTMLElement).offsetWidth; // reflow
    (this.killFeedback as HTMLElement).style.animation = "";
  }

  update(dt: number, health: Health, deathTimer: number): void {
    // ---- Health bar ----
    const hp = Math.ceil(health.current);
    if (hp !== this.lastHpShown) {
      this.lastHpShown = hp;
      this.healthFill.style.width = `${health.ratio * 100}%`;
      this.healthValue.textContent = String(hp);
      this.healthHud.classList.toggle("low", health.ratio <= 0.25);
      this.healthHud.classList.toggle(
        "mid",
        health.ratio > 0.25 && health.ratio <= 0.5,
      );
    }

    // ---- Damage vignette (decays smoothly) ----
    this.vignetteOpacity = Math.max(
      0,
      this.vignetteOpacity - cc.damageVignetteDecay * dt * this.vignetteOpacity - 0.15 * dt,
    );
    const shown = Math.round(this.vignetteOpacity * 50) / 50;
    if (shown !== this.lastVignetteShown) {
      this.lastVignetteShown = shown;
      (this.vignette as HTMLElement).style.opacity = String(shown);
    }

    // ---- Kill feedback ----
    if (this.killTimer > 0) {
      this.killTimer -= dt;
      if (this.killTimer <= 0) this.killFeedback.classList.add("hidden");
    }

    // ---- Death screen ----
    const dead = !health.alive;
    this.deathScreen.classList.toggle("hidden", !dead);
    if (dead) {
      this.deathTimerEl.textContent = Math.max(0, deathTimer).toFixed(1);
    }
  }
}