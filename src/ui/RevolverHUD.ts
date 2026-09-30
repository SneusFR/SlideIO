import { RevolverWeapon } from "../weapons/revolver/RevolverWeapon";
import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

const ACCENT = "#e8d3a8"; // neutral parchment — legacy weapon, no own theme
const CYLINDER = 6;

/**
 * Legacy revolver plate — kept functional, same plate anatomy as every
 * other weapon (no special treatment): six brass bullets that pop out in
 * real time (fan fire syncs 6→0 with the actual shots). During
 * materialization the ribbon reads "MATERIALIZING".
 */
export class RevolverHUD {
  private readonly plate: WeaponPlate;
  private readonly bullets: HTMLSpanElement[];

  private lastAmmo = -1;
  private lastMaterializing: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.plate = new WeaponPlate("revolver-hud", "REVOLVER", "revolver", ACCENT, null);
    this.bullets = createPips(this.plate.ammo, CYLINDER, "bullet");
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: RevolverWeapon): void {
    if (this.lastVisible === false) return;

    const ammo = weapon.currentAmmo;
    const materializing = weapon.isMaterializing;
    if (ammo === this.lastAmmo && materializing === this.lastMaterializing) return;
    if (ammo < this.lastAmmo && !materializing) this.plate.kick();
    this.lastAmmo = ammo;
    this.lastMaterializing = materializing;

    this.plate.setName(materializing ? "MATERIALIZING" : undefined);
    this.plate.setCount(materializing ? "…" : String(ammo));
    this.plate.setState(materializing ? "reload" : ammo <= 1 ? "low" : "");
    this.plate.setRing(materializing ? RING_SPIN : -1);
    setPips(this.bullets, materializing ? 0 : ammo);
  }
}
