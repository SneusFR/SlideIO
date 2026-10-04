/**
 * Crosshair animation layers (DOM/CSS, zero per-frame JS) — STICKER shape.
 *
 * The CENTER DOT never moves. The 4 radial ticks are built as three nested layers so
 * that independent effects never fight over one transform:
 *
 *   .cx-spread  (aim spacing — CSS transition on #crosshair.cx-aim, 125 ms)
 *     └ .cx-pulse (fire kick — restartable CSS animation, 32 ms out / 168 ms back)
 *         └ .cx-bar (the visible tick: cream + ink outline + turquoise tip)
 *
 * A burst RESTARTS the same fixed-amplitude pulse (never stacks), and a shot fired in the
 * middle of an aim transition simply plays on the inner layer. Impact / kill diagonals are
 * owned by HitmarkerHUD (a separate element), driven only by confirmed hits.
 */

/** Pulse amplitude (px at scale 1) per weapon — a real recoil, not one generic tick. */
export type CrosshairKick = "light" | "medium" | "heavy";

const KICK_PX: Record<CrosshairKick, number> = { light: 3.5, medium: 5, heavy: 7.5 };
/** The kick is softer while aiming (the ticks are already tight). */
const AIM_KICK_FACTOR = 0.65;

export class CrosshairHUD {
  private readonly root: HTMLElement | null;
  private aiming = false;
  private kick: CrosshairKick = "medium";

  constructor() {
    this.root = document.getElementById("crosshair");
    if (!this.root) return;
    for (let i = 0; i < 4; i++) {
      const spread = document.createElement("div");
      spread.className = "cx-spread";
      spread.style.setProperty("--r", `${i * 90}deg`);
      const pulse = document.createElement("div");
      pulse.className = "cx-pulse";
      const bar = document.createElement("div");
      bar.className = "cx-bar";
      pulse.appendChild(bar);
      spread.appendChild(pulse);
      this.root.appendChild(spread);
    }
  }

  /** True while a weapon is in a REAL aim mode (ADS / sight picture / zoom). Idempotent. */
  setAiming(on: boolean): void {
    if (!this.root || on === this.aiming) return;
    this.aiming = on;
    this.root.classList.toggle("cx-aim", on);
  }

  /** A shot was actually emitted by the local weapon. Restarts the pulse (no stacking). */
  fire(kick: CrosshairKick = "medium"): void {
    if (!this.root) return;
    this.kick = kick;
    const px = KICK_PX[kick] * (this.aiming ? AIM_KICK_FACTOR : 1);
    this.root.style.setProperty("--cx-kick", String(px));
    this.root.classList.remove("cx-firing");
    void this.root.offsetWidth; // reflow → restart the CSS animation
    this.root.classList.add("cx-firing");
  }

  /** Last kick class used (debug / preview). */
  get lastKick(): CrosshairKick {
    return this.kick;
  }
}
