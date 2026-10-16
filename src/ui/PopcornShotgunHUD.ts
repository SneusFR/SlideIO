import { POPCORN_PIP_SVG } from "./hudIcons";
import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

/** Coral of the "POPCORN" tab. */
const ACCENT = "#ff5f6d";
/** Golden popcorn grain of the rail. */
const GRAIN = "#f7d27e";

/** What the plate reads from the shotgun (PopcornShotgunWeapon satisfies it; the HUD preview fakes it). */
export interface PopcornHudSource {
  /** Real loads left in the tank. */
  readonly ammo: number;
  readonly isReloading: boolean;
  /** Bumped once per shot ACTUALLY fired (a refused dry-fire click never bumps it). */
  readonly shotSerial: number;
}

/**
 * Popcorn Shotgun plate — built exactly like the Paintball plate (same
 * WeaponPlate anatomy, same 3D paint layer, same reactions):
 *
 *     ╭─────╮ ╭ POPCORN ╮            ← coral tab, black bold name
 *     │ gun │   2           ◖butter◗  ← dark face, cream edge, glossy yellow mass
 *     ╰─────╯ ╭ ✿ ✿ ╮                ← rail: one golden grain per real load
 *
 * The badge is a round cream disc (thick dark outline) holding the whole
 * shotgun drawn side-on, barrel to the left; the tab and the panels overlap
 * it slightly. No max ("/n") next to the count.
 *
 * Data = the weapon's real ammo / reload state only. The recoil kick (badge +
 * paint jelly) fires ONLY when the weapon reports a shot actually fired
 * (`shotSerial`): a refused dry-fire click changes nothing. While the weapon
 * really reloads the tab reads "RECHARGE" and the badge ring spins.
 * DOM only touched on state change.
 */
export class PopcornShotgunHUD {
  private readonly plate: WeaponPlate;
  private readonly grains: HTMLSpanElement[];

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastShot = -1;
  private lastVisible: boolean | null = null;

  constructor(shots: number) {
    this.plate = new WeaponPlate("popcorn-shotgun-hud", "POPCORN", "popcorn", ACCENT, null, "popcorn");
    this.grains = createPips(this.plate.ammo, shots, "puff", [GRAIN], 0, POPCORN_PIP_SVG);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
    // Weapon switch: the next update is a clean first sync (no replayed kick, no stale serial).
    if (!visible) {
      this.lastAmmo = -1;
      this.lastReloading = null;
      this.lastShot = -1;
    }
  }

  update(weapon: PopcornHudSource): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    const serial = weapon.shotSerial;
    if (ammo === this.lastAmmo && reloading === this.lastReloading && serial === this.lastShot) return;

    // A REAL shot (one kick per frame, however many serials passed: spam stays capped).
    if (this.lastShot >= 0 && serial !== this.lastShot) this.plate.kick();
    this.lastShot = serial;
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "RECHARGE" : undefined);
    this.plate.setCount(String(ammo));
    this.plate.setState(reloading ? "reload" : ammo === 0 ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPips(this.grains, ammo);
  }
}
