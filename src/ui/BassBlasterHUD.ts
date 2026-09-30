import { BassBlasterWeapon } from "../weapons/bassblaster/BassBlasterWeapon";
import { createGauge, WeaponPlate } from "./hudKit";

const ACCENT = "#ff7ac8"; // bubble-gum pink: a goofy boombox, not a neon synth

/**
 * Bass Blaster plate — the boombox badge + a pink "equalizer" tube that
 * drains with the magazine; during the musical reload it refills with the
 * reload progress (dancing stripes) and the ribbon reads "♫ RECHARGE…":
 *
 *     (boombox)  ♪ BASS BLASTER
 *                30   [▮▮▮▮▮▮▮▮▮▮░░]
 *
 * DOM is only touched when the displayed state changes.
 */
export class BassBlasterHUD {
  private readonly plate: WeaponPlate;
  private readonly setLevel: (ratio: number) => void;

  private lastAmmo = -1;
  private lastReloadPct = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.plate = new WeaponPlate("bassblaster-hud", "\u266A BASS BLASTER", "bass", ACCENT, null);
    this.setLevel = createGauge(this.plate.ammo, "eq");
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: BassBlasterWeapon): void {
    if (this.lastVisible === false) return;

    const ammo = weapon.currentAmmo;
    const reloading = weapon.isReloading;
    const reloadPct = reloading ? Math.round(weapon.reloadProgress * 100) : -1;
    if (
      ammo === this.lastAmmo &&
      reloading === this.lastReloading &&
      reloadPct === this.lastReloadPct
    ) {
      return;
    }
    this.lastAmmo = ammo;
    this.lastReloading = reloading;
    this.lastReloadPct = reloadPct;

    if (reloading) {
      this.plate.setName("\u266B RECHARGE\u2026");
      this.plate.setCount("\u266A\u266B");
      this.plate.setState("reload");
      this.plate.setRing(reloadPct / 100);
      this.setLevel(reloadPct / 100);
      return;
    }

    const ratio = ammo / weapon.maxAmmo;
    this.plate.setName();
    this.plate.setCount(String(ammo));
    this.plate.setState(ratio <= 0.2 ? "low" : "");
    this.plate.setRing(-1);
    this.setLevel(ratio);
  }
}
