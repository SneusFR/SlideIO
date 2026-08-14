import { WeaponConfig as cfg } from "./WeaponConfig";

/**
 * Heat / overheat state machine for the Plasma Rifle.
 *
 *   firing      → heat rises
 *   not firing  → heat falls
 *   heat == max → OVERHEATED: firing locked until heat drops below the
 *                 recovery threshold AND a minimum lock time has elapsed.
 */
export class HeatSystem {
  heat = 0;
  overheated = false;

  private lockTimer = 0;
  private overheatEvent = false;

  /** 0..1 fraction of max heat. */
  get ratio(): number {
    return this.heat / cfg.maxHeat;
  }

  /** Can the trigger actually produce a beam right now? */
  get canFire(): boolean {
    return !this.overheated;
  }

  /** Estimated seconds until the weapon re-arms (0 when not overheated). */
  get cooldownRemaining(): number {
    if (!this.overheated) return 0;
    const coolTime =
      Math.max(this.heat - cfg.overheatRecoveryThreshold, 0) /
      cfg.overheatCoolingPerSecond;
    return Math.max(coolTime, this.lockTimer);
  }

  /** True only once, on the frame the overheat triggered (for FX). */
  consumeOverheatEvent(): boolean {
    const e = this.overheatEvent;
    this.overheatEvent = false;
    return e;
  }

  /** @param firing true when the weapon is actually emitting the beam. */
  update(dt: number, firing: boolean): void {
    if (firing && !this.overheated) {
      this.heat += cfg.heatPerSecond * dt;
      if (this.heat >= cfg.maxHeat) {
        this.heat = cfg.maxHeat;
        this.overheated = true;
        this.lockTimer = cfg.overheatMinLockTime;
        this.overheatEvent = true;
      }
    } else {
      const rate = this.overheated
        ? cfg.overheatCoolingPerSecond
        : cfg.coolingPerSecond;
      this.heat = Math.max(0, this.heat - rate * dt);

      if (this.overheated) {
        this.lockTimer = Math.max(0, this.lockTimer - dt);
        if (this.lockTimer <= 0 && this.heat <= cfg.overheatRecoveryThreshold) {
          this.overheated = false;
        }
      }
    }
  }
}