import { createPips, setPips, WeaponPlate, RING_SPIN } from "./hudKit";
import { FrisbeeMechanism } from "./frisbee/FrisbeeMechanism";

const ACCENT = "#ff8a3d";

/** What the plate reads from the launcher (FrisbeeLauncherWeapon satisfies it; the HUD preview fakes it). */
export interface FrisbeeHudSource {
  readonly deckLoaded: boolean;
  readonly cageCount: number;
  /** A disc taken from the cage for the re-cock, not on the deck yet (still on the weapon). */
  readonly discInHand: boolean;
  readonly isReloading: boolean;
  /** Bumped once per disc ACTUALLY thrown. */
  readonly shotSerial: number;
}

/**
 * Frisbee Launcher plate — same family as the Paintball plate (charcoal face,
 * thin cream / turquoise shell, tab, cream digits first), with the weapon
 * badge replaced by a small REAL 3D launcher fork (FrisbeeMechanism) on the
 * left edge: the seated disc in the navy cords, the short stack rising out of
 * the well.
 *
 *     ╭fork╮  ╭ FRISBEE ╮
 *     │ ▭▭ │   6 /6
 *     ╰well╯  ╭ ◖◖◖◖◖◖ ╮   ← rail: one small disc per real disc
 *
 * Count = deck + disc in hand + cage: a disc moving from the cage to the deck
 * during the automatic re-cock never makes the number flicker. The 3D shot
 * reaction fires ONLY when the weapon reports a disc actually thrown
 * (`shotSerial`), the count updates the same frame. While the cage is swapped
 * the tab reads "CAGE". DOM / 3D are only touched when the state changes.
 */
export class FrisbeeLauncherHUD {
  private readonly plate: WeaponPlate;
  private readonly rail: HTMLSpanElement[];
  private readonly mech: FrisbeeMechanism;
  private readonly capacity: number;

  private lastTotal = -1;
  private lastDeck: boolean | null = null;
  private lastReloading: boolean | null = null;
  private lastShot = -1;
  private lastVisible: boolean | null = null;

  constructor(cageCapacity: number) {
    this.capacity = cageCapacity + 1;
    this.plate = new WeaponPlate("frisbee-launcher-hud", "FRISBEE", "frisbee", ACCENT, this.capacity);
    this.rail = createPips(this.plate.ammo, this.capacity, "frisbee");
    this.mech = new FrisbeeMechanism(this.plate.root, this.capacity);
    // No WebGL / context lost: the plate shows its flat badge again (the HUD stays complete).
    this.mech.onAvailability = (ok) => this.plate.root.classList.toggle("mech-3d", ok);
  }

  /** The 3D mechanism (preview / debug: slow motion via `timeScale`). */
  get mechanism(): FrisbeeMechanism {
    return this.mech;
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
    this.mech.setVisible(visible);
  }

  update(weapon: FrisbeeHudSource): void {
    if (this.lastVisible === false) return;
    const deck = weapon.deckLoaded;
    const total = (deck ? 1 : 0) + (weapon.discInHand ? 1 : 0) + weapon.cageCount;
    const reloading = weapon.isReloading;
    const serial = weapon.shotSerial;
    if (total === this.lastTotal && deck === this.lastDeck && reloading === this.lastReloading && serial === this.lastShot) return;

    const first = this.lastShot < 0;
    // A REAL shot (and only one reaction per frame, however many serials passed: spam stays capped).
    if (!first && serial !== this.lastShot) {
      this.mech.shot();
      this.plate.kick();
    }
    this.mech.setState(total, deck, first);
    this.lastShot = serial;
    this.lastTotal = total;
    this.lastDeck = deck;
    this.lastReloading = reloading;

    this.plate.setName(reloading ? "CAGE" : undefined);
    this.plate.setCount(String(total));
    this.plate.setState(reloading ? "reload" : total <= 1 ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPips(this.rail, total);
  }
}
