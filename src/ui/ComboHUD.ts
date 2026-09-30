import { ComboManager } from "../combo/ComboManager";
import { replayAnim } from "./hudKit";

/**
 * Combo TAG — a wooden tag hanging on two strings under the top-centre
 * mode badge (far from the aim point). "x3" in big letters, a tiny timer
 * rope that burns down, and on every kill the tag swings. It gets warmer
 * per tier (x2 / x3+) and, when the combo is lost, falls off its strings.
 */
export class ComboHUD {
  private readonly root = document.getElementById("combo-hud") as HTMLDivElement;
  private readonly tag = document.getElementById("combo-tag") as HTMLDivElement;
  private readonly count = document.getElementById("combo-count") as HTMLSpanElement;
  private readonly fill = document.getElementById("combo-fill") as HTMLDivElement;

  private lastCount = 0;
  private lastFill = -1;
  private lastEnding: boolean | null = null;
  private lastTier = 0;
  private shown = false;

  /** A kill just refreshed the timer: swing the tag. */
  notifyKill(): void {
    replayAnim(this.tag, "swing");
  }

  /** Observe the combo state every frame (display only, no gameplay). */
  update(combo: ComboManager): void {
    if (!combo.active) {
      if (this.shown) {
        this.shown = false;
        // Falls off its strings (CSS), then stays hidden.
        this.root.classList.remove("show");
        this.root.classList.add("drop");
      }
      this.lastCount = 0;
      this.lastTier = 0;
      return;
    }

    if (!this.shown) {
      this.shown = true;
      this.root.classList.remove("drop");
      this.root.classList.add("show");
    }

    if (combo.comboCount !== this.lastCount) {
      this.lastCount = combo.comboCount;
      this.count.textContent = `x${combo.comboCount}`;
    }

    const fill = Math.round(combo.ratio * 200) / 200;
    if (fill !== this.lastFill) {
      this.lastFill = fill;
      this.fill.style.transform = `scaleX(${fill})`;
    }
    // Last second: the rope blinks — hurry up!
    const ending = combo.timeRemaining < 1;
    if (ending !== this.lastEnding) {
      this.lastEnding = ending;
      this.root.classList.toggle("ending", ending);
    }

    const tier = combo.comboCount >= 3 ? 3 : combo.comboCount === 2 ? 2 : 1;
    if (tier !== this.lastTier) {
      this.lastTier = tier;
      this.root.classList.toggle("tier-2", tier === 2);
      this.root.classList.toggle("tier-3", tier === 3);
    }
  }
}
