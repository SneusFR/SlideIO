import { Health } from "../combat/Combatant";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { hudFeed } from "./HudFeed";
import { BEAN_BUDDY_SVG } from "./hudIcons";
import { replayAnim } from "./hudKit";

/** Min seconds between two "hurt" punches (continuous beams hit at 60 Hz). */
const HURT_PUNCH_INTERVAL = 0.14;
/** How long the Bean Buddy keeps its "ouch" face after a hit. */
const OUCH_FACE_TIME = 0.35;
/** The white "ghost" bar waits this long before catching up with the HP. */
const GHOST_HOLD = 0.4;
/** Ghost catch-up speed (HP ratio per second). */
const GHOST_SPEED = 0.9;

type Mood = "happy" | "worried" | "panic" | "dead";

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
 * Player combat UI:
 *  - the BEAN BUDDY (bottom-left): a bean portrait whose face follows the
 *    HP (happy → worried → panic → dead), squashes + grimaces on hits and
 *    sparkles on heals, with a jelly HP tube (+ white "ghost" of the damage
 *    just taken) and a bouncing HP number;
 *  - continuous damage vignette (throttled), DIRECTIONAL damage bites,
 *    the persistent low-health vignette, heal flash + "+N" floating up
 *    from the HP tube;
 *  - kill feedback → a "BEANED!" sticker in the top-centre event feed
 *    (never over the aim point); knockdown banner (bottom-centre);
 *  - the death screen.
 */
export class CombatHUD {
  private readonly buddy = document.getElementById("bean-buddy")!;
  private readonly buddyArt = document.getElementById("buddy-portrait")!;
  private readonly healthHud = document.getElementById("health-hud")!;
  private readonly healthFill = document.getElementById("health-fill")!;
  private readonly healthGhost = document.getElementById("health-ghost")!;
  private readonly healthValue = document.getElementById("health-value")!;
  private readonly healthMax = document.getElementById("health-max")!;
  private readonly nameTag = document.getElementById("buddy-name")!;
  private readonly vignette = document.getElementById("damage-vignette")!;
  private readonly lowHpVignette = document.getElementById("lowhp-vignette")!;
  private readonly healFlash = document.getElementById("heal-flash")!;
  private readonly healFeedback = document.getElementById("heal-feedback")!;
  private readonly deathScreen = document.getElementById("death-screen")!;
  private readonly deathTimerEl = document.getElementById("death-timer")!;
  private readonly knockdownHint = document.getElementById("knockdown-hint")!;
  private lastHurtPunch = -1;
  private lastHpBand = "";
  private lastMood: Mood | "" = "";
  private ouchTimer = 0;
  private lastOuch = false;
  private ghostRatio = 1;
  private ghostHold = 0;
  private lastGhostShown = -1;
  private hpRatio = 1;
  private lastDeathText = "";
  private lastDeadShown: boolean | null = null;

  private readonly dirSlots: DirSlot[] = [];

  private vignetteOpacity = 0;
  private lastVignetteShown = -1;
  private lastLowHpShown = -1;
  private lastHpShown = -1;
  private lastMaxShown = -1;
  private lastName = "";
  private healTimer = 0;
  private healFlashOpacity = 0;
  private lastHealFlashShown = -1;
  private clock = 0;

  constructor() {
    // Bean Buddy portrait art (all mood faces live in the SVG, CSS picks one).
    this.buddyArt.innerHTML = BEAN_BUDDY_SVG;
    this.buddy.classList.add("mood-happy");
    this.lastMood = "happy";

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

  /** Player name on the card's name tag (upper-cased, change-detected). */
  setPlayerName(name: string): void {
    const text = name.trim().toUpperCase() || "PLAYER";
    if (text === this.lastName) return;
    this.lastName = text;
    this.nameTag.textContent = text;
  }

  // DOM writes only on actual state changes (same discipline as the rest).
  private lastKnockdownShown = false;
  private lastCanGetUpShown = false;

  /**
   * Knockdown state banner (§ ragdoll): "KNOCKED DOWN" while forced to
   * the ground, then a pulsing "PRESS SPACE TO GET UP" once the player
   * can stand back up. Pure display — the input lives in PlayerMovement.
   */
  setKnockdown(down: boolean, canGetUp: boolean): void {
    if (down !== this.lastKnockdownShown) {
      this.lastKnockdownShown = down;
      this.knockdownHint.classList.toggle("hidden", !down);
    }
    if (!down) canGetUp = false;
    if (canGetUp !== this.lastCanGetUpShown) {
      this.lastCanGetUpShown = canGetUp;
      this.knockdownHint.classList.toggle("can-get-up", canGetUp);
      this.knockdownHint.textContent = canGetUp
        ? "PRESS SPACE TO GET UP"
        : "KNOCKED DOWN";
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

    // Squishy "ouch": the bean squashes + grimaces and the HP tube shakes
    // (throttled so a continuous beam does not restart it every frame).
    if (amount > 0) {
      this.ouchTimer = OUCH_FACE_TIME;
      this.ghostHold = GHOST_HOLD;
      if (this.clock - this.lastHurtPunch >= HURT_PUNCH_INTERVAL) {
        this.lastHurtPunch = this.clock;
        replayAnim(this.buddyArt, "hurt");
        replayAnim(this.healthHud, "hurt");
      }
    }

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

  /** Call when the player kills a bot → "BEANED!" sticker in the top feed. */
  notifyKill(): void {
    hudFeed().push("kill", "BEANED!");
    replayAnim(this.buddy, "cheer"); // the bean does a little victory hop
  }

  /** Call when a medkit heal is actually applied. */
  notifyHeal(amount: number): void {
    this.healTimer = cc.healFeedbackDuration;
    this.healFlashOpacity = 0.3;
    this.healFeedback.textContent = `+${Math.round(amount)}`;
    this.healFeedback.classList.remove("hidden");
    replayAnim(this.healFeedback, "float");
    // Sparkles run on the portrait's frame: the art owns the "hurt" squash
    // (two animations on one element would override each other).
    replayAnim(this.buddy.querySelector(".buddy-frame") ?? this.buddy, "heal");
  }

  update(dt: number, health: Health, deathTimer: number): void {
    this.clock += dt;

    // ---- HP tube + number + portrait mood ----
    const hp = Math.ceil(health.current);
    const ratio = Math.max(0, Math.min(1, health.ratio));
    const max = Math.round(health.max);
    if (max !== this.lastMaxShown) {
      this.lastMaxShown = max;
      this.healthMax.textContent = `/${max}`;
    }
    if (hp !== this.lastHpShown) {
      const healed = this.lastHpShown >= 0 && hp > this.lastHpShown;
      const hadValue = this.lastHpShown >= 0;
      this.lastHpShown = hp;
      this.hpRatio = ratio;
      this.healthFill.style.transform = `scaleX(${ratio})`;
      this.healthValue.textContent = String(hp);
      if (hadValue) replayAnim(this.healthValue, "bump");
      // Heals / respawn: the ghost jumps straight to the new value.
      if (healed || ratio >= this.ghostRatio) this.ghostRatio = ratio;

      const band = ratio >= 1 ? "full" : ratio <= 0.25 ? "low" : ratio <= 0.5 ? "mid" : "ok";
      if (band !== this.lastHpBand) {
        this.lastHpBand = band;
        this.healthHud.classList.toggle("low", band === "low");
        this.healthHud.classList.toggle("mid", band === "mid");
        this.healthHud.classList.toggle("full", band === "full");
      }
    }

    // Ghost bar: holds the lost chunk for a moment, then drains to the HP.
    if (this.ghostRatio > this.hpRatio) {
      if (this.ghostHold > 0) this.ghostHold -= dt;
      else this.ghostRatio = Math.max(this.hpRatio, this.ghostRatio - GHOST_SPEED * dt);
    }
    const ghostShown = Math.round(this.ghostRatio * 200) / 200;
    if (ghostShown !== this.lastGhostShown) {
      this.lastGhostShown = ghostShown;
      this.healthGhost.style.transform = `scaleX(${ghostShown})`;
    }

    const mood: Mood = !health.alive
      ? "dead"
      : ratio <= 0.3
        ? "panic"
        : ratio <= 0.6
          ? "worried"
          : "happy";
    if (mood !== this.lastMood) {
      if (this.lastMood) this.buddy.classList.remove(`mood-${this.lastMood}`);
      this.buddy.classList.add(`mood-${mood}`);
      this.lastMood = mood;
    }
    if (this.ouchTimer > 0) this.ouchTimer -= dt;
    const ouch = this.ouchTimer > 0 && health.alive;
    if (ouch !== this.lastOuch) {
      this.lastOuch = ouch;
      this.buddy.classList.toggle("ouch", ouch);
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

    // ---- Event feed (kill / streak stickers) ----
    hudFeed().update(dt);

    // ---- Death screen ----
    const dead = !health.alive;
    if (dead !== this.lastDeadShown) {
      this.lastDeadShown = dead;
      this.deathScreen.classList.toggle("hidden", !dead);
      // The aim ticker has nothing to say while dead.
      document.getElementById("hud")?.classList.toggle("player-dead", dead);
    }
    if (dead) {
      const text = Math.max(0, deathTimer).toFixed(1);
      if (text !== this.lastDeathText) {
        this.lastDeathText = text;
        this.deathTimerEl.textContent = text;
      }
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