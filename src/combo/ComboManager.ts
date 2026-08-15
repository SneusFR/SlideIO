import { ComboConfig as cc } from "./ComboConfig";
import { ComboEndReason } from "./ComboEvents";

/**
 * Local-player kill combo state machine.
 *
 * - registerKill(): combo count +1, timer refilled to `comboDuration`.
 * - update(dt): counts the timer down; at 0 → combo lost (timeout).
 * - resetOnDeath(): immediate hard reset (the combo NEVER survives death).
 *
 * This manager only tracks state — HUD/audio/medals observe it through
 * getters and the two callbacks. It never touches gameplay.
 */
export class ComboManager {
  /** Fired every time the combo count increases (1, 2, 3…). */
  onComboChanged: ((count: number) => void) | null = null;
  /** Fired once when an active combo ends (timeout or player death). */
  onComboEnd: ((reason: ComboEndReason) => void) | null = null;

  private count = 0;
  private timer = 0;

  /** True while a combo is running. */
  get active(): boolean {
    return this.count > 0;
  }

  /** Current combo kill count (0 when inactive). */
  get comboCount(): number {
    return this.count;
  }

  /** Seconds left before the combo is lost. */
  get timeRemaining(): number {
    return this.timer;
  }

  /** 0..1 fraction of the combo window remaining (drives the bar fill). */
  get ratio(): number {
    return this.count > 0 ? Math.max(0, this.timer / cc.comboDuration) : 0;
  }

  /**
   * A confirmed local-player kill: bump the combo and refill the window.
   * Returns the NEW combo count (1 = combo start).
   */
  registerKill(): number {
    this.count++;
    this.timer = cc.comboDuration;
    this.onComboChanged?.(this.count);
    return this.count;
  }

  /** Tick the combo window down; fires onComboEnd on timeout. */
  update(dt: number): void {
    if (this.count === 0) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0;
      this.count = 0;
      this.onComboEnd?.("timeout");
    }
  }

  /** The player died: the combo is reset immediately, no exceptions. */
  resetOnDeath(): void {
    if (this.count === 0) return;
    this.count = 0;
    this.timer = 0;
    this.onComboEnd?.("death");
  }
}