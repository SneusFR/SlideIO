import { FrisbeeLauncherWeapon } from "../weapons/frisbee/FrisbeeLauncherWeapon";
import { createPips, setPip, setPips, WeaponPlate, RING_SPIN } from "./hudKit";

const ACCENT = "#ff8a3d";
const CAGE_DISC = "#ffd0a8";

/**
 * Frisbee Launcher plate — the disc ON THE DECK is drawn big (it flies off
 * when fired), the cage is a STACK of small discs seen edge-on (they drop
 * out one by one as the automatic re-cock takes them, and pop back in
 * when a full cage clicks in):
 *
 *     (frisbee)  LANCE-FRISBEE
 *                6   ⬭  ▭▭▭▭▭
 *
 * While the cage is swapped the ribbon reads "CAGE". DOM is only touched
 * when the displayed state changes.
 */
export class FrisbeeLauncherHUD {
  private readonly plate: WeaponPlate;
  private readonly deck: HTMLSpanElement;
  private readonly cage: HTMLSpanElement[];

  private lastDeck: boolean | null = null;
  private lastCage = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(cageCapacity: number) {
    this.plate = new WeaponPlate("frisbee-launcher-hud", "LANCE-FRISBEE", "frisbee", ACCENT, null);
    this.deck = createPips(this.plate.ammo, 1, "deck", [ACCENT])[0];
    this.cage = createPips(this.plate.ammo, cageCapacity, "stack", [CAGE_DISC]);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.plate.setVisible(visible);
  }

  update(weapon: FrisbeeLauncherWeapon): void {
    if (this.lastVisible === false) return;
    const deck = weapon.deckLoaded;
    const cage = weapon.cageCount;
    const reloading = weapon.isReloading;
    if (deck === this.lastDeck && cage === this.lastCage && reloading === this.lastReloading) return;
    if (this.lastDeck === true && !deck && !reloading) this.plate.kick();
    this.lastDeck = deck;
    this.lastCage = cage;
    this.lastReloading = reloading;

    const total = (deck ? 1 : 0) + cage;
    this.plate.setName(reloading ? "CAGE" : undefined);
    this.plate.setCount(String(total));
    this.plate.setState(reloading ? "reload" : total <= 1 ? "low" : "");
    this.plate.setRing(reloading ? RING_SPIN : -1);
    setPip(this.deck, deck);
    setPips(this.cage, cage);
  }
}
