import { CombatConfig as cc } from "../combat/CombatConfig";

/**
 * Bot count section of the Escape / pause overlay.
 * [-] N [+] — changes are applied instantly via the callback.
 * Clicks inside the menu never re-lock the pointer (stopPropagation).
 */
export class BotsMenu {
  private count: number;
  private readonly countEl = document.getElementById("bots-count")!;

  constructor(onChange: (count: number) => void) {
    this.count = cc.defaultBotCount;
    this.countEl.textContent = String(this.count);

    const menu = document.getElementById("bots-menu")!;
    // Don't let menu clicks bubble to the overlay's click-to-play handler.
    menu.addEventListener("click", (e) => e.stopPropagation());

    document.getElementById("bots-minus")!.addEventListener("click", () => {
      this.setCount(this.count - 1, onChange);
    });
    document.getElementById("bots-plus")!.addEventListener("click", () => {
      this.setCount(this.count + 1, onChange);
    });
  }

  get botCount(): number {
    return this.count;
  }

  private setCount(n: number, onChange: (count: number) => void): void {
    const clamped = Math.max(0, Math.min(cc.maxBotCount, n));
    if (clamped === this.count) return;
    this.count = clamped;
    this.countEl.textContent = String(clamped);
    onChange(clamped);
  }
}