import { formatMatchClock } from "../../shared/match/MatchRules";

/** Width of the reference frame the capsule was measured on (= leaderboard's). */
const REF_WIDTH = 1816;

/**
 * Top-centre match clock: cream capsule [ FFA · ● · ⏱ 4:59 ]. Display only:
 * the owner (Game) feeds the remaining seconds every frame; the DOM is
 * touched only when the shown second changes. Last 30 s → "hurry" pulse
 * (hud.css). The capsule is drawn in the 1816px reference space and scaled
 * with the window like the leaderboard (--mc-s, updated on resize only).
 */
export class MatchClockHUD {
  private readonly el = document.getElementById("mode-time");
  private readonly pill = document.getElementById("mode-hud");
  private readonly stack = document.getElementById("top-center");
  private shown = "";
  private hurry = false;
  private readonly onResize = (): void => this.syncScale();

  constructor() {
    window.addEventListener("resize", this.onResize);
    this.syncScale();
  }

  /** Seconds left, or null = no clock (shows ∞). */
  set(secondsLeft: number | null): void {
    const text = secondsLeft === null ? "∞" : formatMatchClock(secondsLeft);
    if (text !== this.shown && this.el) {
      this.shown = text;
      this.el.textContent = text;
      this.el.classList.toggle("mt-inf", secondsLeft === null);
    }
    const hurry = secondsLeft !== null && secondsLeft <= 30;
    if (hurry !== this.hurry) {
      this.hurry = hurry;
      this.pill?.classList.toggle("mode-hurry", hurry);
    }
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
  }

  /**
   * Same rule as LeaderboardHUD (innerWidth / 1816, clamped), divided by the
   * zoom the responsive rules put on #top-center (2K / 4K) so the capsule
   * keeps exactly the reference proportion of the screen width.
   */
  private syncScale(): void {
    if (!this.pill) return;
    const s = Math.min(2.6, Math.max(0.7, window.innerWidth / REF_WIDTH));
    const stackZoom = this.stack ? Number.parseFloat(getComputedStyle(this.stack).zoom) || 1 : 1;
    this.pill.style.setProperty("--mc-s", (s / stackZoom).toFixed(4));
  }
}
