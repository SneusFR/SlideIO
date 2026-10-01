import { PaintballRifleWeapon } from "../weapons/paintball/PaintballRifleWeapon";
import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

const ACCENT = "#ff5fa2";
/** The three paint colours, cycled over the balls. */
const PAINT = ["#22c7ea", "#ff4fa3", "#ffd23f"] as const;
/** One ball on the plate = capacity / BALLS real balls (32 / 8 = 4). */
const BALLS = 8;

/**
 * Paintball Rifle plate — the hopper drawn as 8 glossy paint balls (three
 * paint colours) that POP one by one as the magazine drains:
 *
 *     (gun)  PAINTBALL
 *            24 /32   ● ● ● ● ● ● ○ ○
 *
 * While the hopper is swapped the ribbon reads "RECHARGE", the badge ring
 * spins and the balls bounce back in. DOM only touched on state change.
 */
export class PaintballRifleHUD {
  private readonly plate: WeaponPlate;
  private readonly balls: HTMLSpanElement[];
  private readonly capacity: number;

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.plate = new WeaponPlate("paintball-rifle-hud", "PAINTBALL", "paintball", ACCENT, capacity, "paintball");
    this.balls = createPips(this.plate.ammo, BALLS, "ball", PAINT);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: PaintballRifleWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    if (ammo < this.lastAmmo && !reloading) this.plate.kick();
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    const low = ammo <= this.capacity / 4;
    this.plate.setName(reloading ? "RECHARGE" : undefined);
    this.plate.setCount(String(ammo));
    this.plate.setState(reloading ? "reload" : low ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPips(this.balls, Math.ceil(ammo / (this.capacity / BALLS)));
  }
}
