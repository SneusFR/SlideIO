import { PoisonWeapon } from "../weapons/poison/PoisonWeapon";
import { createGauge, WeaponPlate } from "./hudKit";

const ACCENT = "#7bff4d";

/**
 * Lance-Poison plate — the flask badge + a bubbling toxic-green tube. The
 * level is the SAME charge the gameplay drains and the 3D liquid tank
 * displays:
 *
 *     (flask)  POISON
 *              73%   [≈≈≈≈≈≈≈≈≈░░░]
 *
 * DOM is only touched when the shown state actually changes.
 */
export class PoisonHUD {
  private readonly plate: WeaponPlate;
  private readonly setLevel: (ratio: number) => void;

  private lastPercent = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.plate = new WeaponPlate("poison-hud", "POISON", "poison", ACCENT, null, "poison");
    this.setLevel = createGauge(this.plate.ammo, "poison");
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: PoisonWeapon): void {
    if (this.lastVisible === false) return;

    const percent = Math.round(weapon.fillFraction * 100);
    const reloading = weapon.isReloading;
    if (percent === this.lastPercent && reloading === this.lastReloading) return;
    this.lastPercent = percent;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "REFILLING" : undefined);
    this.plate.setCount(`${percent}%`);
    this.plate.setState(reloading ? "reload" : percent <= 20 ? "low" : "");
    this.plate.setRing(reloading ? percent / 100 : -1);
    this.setLevel(percent / 100);
  }
}
