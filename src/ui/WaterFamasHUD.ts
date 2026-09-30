import { WaterFamasWeapon } from "../weapons/waterfamas/WaterFamasWeapon";
import { createGauge, createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

const ACCENT = "#38c6ff";
const JETS_PER_BURST = 3;

/**
 * Water FAMAS plate — a glass WATER TANK with a sloshing wave (drains jet
 * by jet) and one droplet per burst next to it:
 *
 *     (water gun)  FAMAS À EAU
 *                  6 /9   [≈≈≈≈≈≈≈≈░░░░]  💧💧○
 *
 * While the tank is refilled the ribbon reads "REMPLISSAGE". DOM is only
 * touched when the displayed state actually changes.
 */
export class WaterFamasHUD {
  private readonly plate: WeaponPlate;
  private readonly setLevel: (ratio: number) => void;
  private readonly drops: HTMLSpanElement[];
  private readonly capacity: number;

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.plate = new WeaponPlate("water-famas-hud", "FAMAS À EAU", "water", ACCENT, capacity);
    this.setLevel = createGauge(this.plate.ammo, "water");
    this.drops = createPips(this.plate.ammo, Math.ceil(capacity / JETS_PER_BURST), "drop");
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: WaterFamasWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    if (ammo < this.lastAmmo && !reloading) this.plate.kick();
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "REMPLISSAGE" : undefined);
    this.plate.setCount(String(ammo));
    this.plate.setState(reloading ? "reload" : ammo <= JETS_PER_BURST ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    this.setLevel(ammo / this.capacity);
    setPips(this.drops, Math.ceil(ammo / JETS_PER_BURST));
  }
}
