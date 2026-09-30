import { PopcornShotgunWeapon } from "../weapons/popcorn/PopcornShotgunWeapon";
import { POPCORN_PIP_SVG } from "./hudIcons";
import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

const ACCENT = "#ffd23f";
const KERNEL = "#fff3c4";

/**
 * Popcorn Shotgun plate — one fat popcorn PUFF per load; a shot makes the
 * puff jump off the plate, a reload bounces them back in:
 *
 *     (bucket)  POPCORN
 *               2   ☁ ☁
 *
 * DOM is only touched when the displayed state actually changes.
 */
export class PopcornShotgunHUD {
  private readonly plate: WeaponPlate;
  private readonly puffs: HTMLSpanElement[];

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(shots: number) {
    this.plate = new WeaponPlate("popcorn-shotgun-hud", "POPCORN", "popcorn", ACCENT, null);
    this.puffs = createPips(this.plate.ammo, shots, "puff", [KERNEL], 0, POPCORN_PIP_SVG);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: PopcornShotgunWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    if (ammo < this.lastAmmo && !reloading) this.plate.kick();
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "RECHARGE" : undefined);
    this.plate.setCount(String(ammo));
    this.plate.setState(reloading ? "reload" : ammo === 0 ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPips(this.puffs, ammo);
  }
}
