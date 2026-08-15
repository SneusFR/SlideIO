import { Health } from "../combat/Combatant";
import { CombatConfig as cc } from "../combat/CombatConfig";

/** One directional damage indicator slot (rotated blob around the crosshair). */
interface DirSlot {
  el: HTMLElement;
  timer: number;
  intensity: number;
  angle: number; // rad, 0 = front, +PI/2 = right (screen clockwise)
  lastOpacity: number;
  lastAngleDeg: number;
}

const DIR_SLOTS = 6;

/**
 * Player combat UI: health bar, continuous damage vignette (throttled —
 * no per-hit flashes at 60 Hz), DIRECTIONAL damage indicators, the
 * persistent low-health vignette, heal feedback, kill feedback and the
 * death screen.
 */
export class CombatHUD {
  private readonly healthHud = document.getElementById("health-hud")!;
  private readonly healthFill = document.getElementById("health-fill")!;
  private readonly healthValue = document.getElementById("health-value")!;
  private readonly vignette = document.getElementById("damage-vignette")!;
  private readonly lowHpVignette = document.getElementById("lowhp-vignette")!;
  private readonly healFlash = document.getElementById("heal-flash")!;
  private readonly healFeedback = document.getElementById("heal-feedback")!;
  private readonly killFeedback = document.getElementById("kill-feedback")!;
  private readonly deathScreen = document.getElementById("death-screen")!;
  private readonly deathTimerEl = document.getElementById("death-timer")!;

  private readonly dirSlots: DirSlot[] = [];

  private vignetteOpacity = 0;
  private lastVignetteShown = -1;
  private lastLowHpShown = -1;
  private lastHpShown = -1;
  private killTimer = 0;
  private healTimer = 0;
  private healFlashOpacity = 0;
  private lastHealFlashShown = -1;
  private clock = 0;

  constructor() {
    // Directional indicator pool (created once, rotated + faded via style).
    const container = document.getElementById("damage-dir-container")!;
    for (let i = 0; i < DIR_SLOTS; i++) {
      const el = document.createElement("div");
      el.className = "damage-dir";
      container.appendChild(el);
      this.dirSlots.push({
        el,
        timer: 0,
        intensity: 0,
        angle: 0,
        lastOpacity: -1,
        lastAngleDeg: 361,
      });
    }
  }

  /**
   * Call when the player takes damage (any amount, any frequency).
   * @param angle relative direction of the damage source in radians
   *              (0 = straight ahead, +PI/2 = right, ±PI = behind),
   *              or null when the source is unknown (environment).
   */
  notifyDamage(amount: number, angle: number | null = null): void {
    // Continuous-friendly: opacity rises with damage, decays over time.
    this.vignetteOpacity = Math.min(
      cc.damageVignetteMax,
      this.vignetteOpacity + amount * 0.02,
    );

    if (angle === null) return;

    // Continuous sources (plasma) refresh the SAME indicator instead of
    // spawning a new flash 60×/s: reuse the closest active slot.
    let slot: DirSlot | null = null;
    for (const s of this.dirSlots) {
      if (s.timer > 0 && Math.abs(angleDiff(s.angle, angle)) < cc.damageDirectionMergeAngle) {
        slot = s;
        break;
      }
    }
    if (!slot) {
      // Take the most faded slot.
      slot = this.dirSlots[0];
      for (const s of this.dirSlots) if (s.timer < slot.timer) slot = s;
      slot.intensity = 0;
    }
    slot.angle = angle;
    slot.timer = cc.damageDirectionDuration;
    slot.intensity = Math.min(1, slot.intensity + 0.35 + amount * 0.03);
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

  /** Call when a medkit heal is actually applied. */
  notifyHeal(amount: number): void {
    this.healTimer = cc.healFeedbackDuration;
    this.healFlashOpacity = 0.3;
    this.healFeedback.textContent = `+${Math.round(amount)} HP`;
    this.healFeedback.classList.remove("hidden");
    (this.healFeedback as HTMLElement).style.animation = "none";
    void (this.healFeedback as HTMLElement).offsetWidth; // reflow
    (this.healFeedback as HTMLElement).style.animation = "";
  }

  update(dt: number, health: Health, deathTimer: number): void {
    this.clock += dt;

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

    // ---- Directional damage indicators (temporary, per-direction) ----
    for (const s of this.dirSlots) {
      if (s.timer <= 0 && s.lastOpacity === 0) continue;
      s.timer = Math.max(0, s.timer - dt);
      const k = s.timer / cc.damageDirectionDuration;
      const opacity =
        Math.round(k * s.intensity * cc.damageDirectionMaxOpacity * 50) / 50;
      if (opacity !== s.lastOpacity) {
        s.lastOpacity = opacity;
        s.el.style.opacity = String(opacity);
      }
      if (s.timer <= 0) {
        s.intensity = 0;
        continue;
      }
      const deg = Math.round((s.angle * 180) / Math.PI);
      if (deg !== s.lastAngleDeg) {
        s.lastAngleDeg = deg;
        s.el.style.transform = `rotate(${deg}deg)`;
      }
    }

    // ---- Low-health vignette (persistent, HP-driven, pulses when critical) ----
    let lowHp = 0;
    if (health.alive && health.ratio < cc.lowHealthThreshold) {
      const t = (cc.lowHealthThreshold - health.ratio) / cc.lowHealthThreshold;
      lowHp = Math.pow(t, 1.5) * cc.damageOverlayIntensity;
      if (health.ratio <= cc.lowHealthCriticalRatio) {
        lowHp *= 0.85 + 0.15 * Math.sin(this.clock * 6.5); // critical pulse
      }
    }
    const lowShown = Math.round(lowHp * 100) / 100;
    if (lowShown !== this.lastLowHpShown) {
      this.lastLowHpShown = lowShown;
      (this.lowHpVignette as HTMLElement).style.opacity = String(lowShown);
    }

    // ---- Heal feedback (short green flash + "+N HP") ----
    if (this.healFlashOpacity > 0) {
      this.healFlashOpacity = Math.max(0, this.healFlashOpacity - dt * 1.2);
    }
    const healShown = Math.round(this.healFlashOpacity * 50) / 50;
    if (healShown !== this.lastHealFlashShown) {
      this.lastHealFlashShown = healShown;
      (this.healFlash as HTMLElement).style.opacity = String(healShown);
    }
    if (this.healTimer > 0) {
      this.healTimer -= dt;
      if (this.healTimer <= 0) this.healFeedback.classList.add("hidden");
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

/** Shortest signed angular difference (rad). */
function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}