import { POPCORN_PIP_SVG } from "./hudIcons";
import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";
import { PopcornMechanism } from "./popcorn/PopcornMechanism";

const ACCENT = "#ffd23f";
const KERNEL = "#fff3c4";

/** What the plate reads from the shotgun (PopcornShotgunWeapon satisfies it; the HUD preview fakes it). */
export interface PopcornHudSource {
  /** Real loads left in the tank. */
  readonly ammo: number;
  readonly isReloading: boolean;
  /** Bumped once per shot ACTUALLY fired (a refused dry-fire click never bumps it). */
  readonly shotSerial: number;
}

/**
 * Popcorn Shotgun plate — same family as the Paintball and Frisbee plates
 * (charcoal face, thin cream edge, yellow "POPCORN" tab, cream digits first),
 * with the weapon badge replaced by a small REAL 3D popcorn machine
 * (PopcornMechanism) on the left edge: red satin frame, ivory base, window
 * with one heap of grains per real load, hinged red lid.
 *
 *     ╭machine╮  ╭ POPCORN ╮
 *     │ ░░░░░ │   2
 *     ╰───────╯  ╭ ☁ ☁ ╮      ← rail: one puff per real load (no max, no "/n")
 *
 * Data = the weapon's real ammo and charge indicators only. The 3D shot
 * reaction fires ONLY when the weapon reports a shot actually fired
 * (`shotSerial`); the count and the rail update the same frame. The lid
 * opens only while the weapon really reloads (tab reads "RECHARGE").
 * DOM / 3D are only touched when the state changes.
 */
export class PopcornShotgunHUD {
  private readonly plate: WeaponPlate;
  private readonly puffs: HTMLSpanElement[];
  private readonly mech: PopcornMechanism;

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastShot = -1;
  private lastVisible: boolean | null = null;

  constructor(shots: number) {
    this.plate = new WeaponPlate("popcorn-shotgun-hud", "POPCORN", "popcorn", ACCENT, null);
    this.puffs = createPips(this.plate.ammo, shots, "puff", [KERNEL], 0, POPCORN_PIP_SVG);
    this.mech = new PopcornMechanism(this.plate.root, shots);
    // No WebGL / context lost: the plate shows its flat badge again (the HUD stays complete).
    this.mech.onAvailability = (ok) => this.plate.root.classList.toggle("mech-3d", ok);
  }

  /** The 3D mechanism (preview / debug: slow motion via `timeScale`). */
  get mechanism(): PopcornMechanism {
    return this.mech;
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
    this.mech.setVisible(visible);
    // Weapon switch: the next update is a clean first sync (no replayed reaction, no stale serial).
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

    const first = this.lastShot < 0;
    // A REAL shot (one reaction per frame, however many serials passed: spam stays capped).
    if (!first && serial !== this.lastShot) {
      this.mech.shot();
      if (!this.mech.available) this.plate.kick(); // flat badge fallback keeps its recoil
    }
    this.mech.setState(ammo, reloading, first);
    this.lastShot = serial;
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "RECHARGE" : undefined);
    this.plate.setCount(String(ammo));
    this.plate.setState(reloading ? "reload" : ammo === 0 ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPips(this.puffs, ammo);
  }
}
