import { FrisbeeLauncherWeapon } from "../weapons/frisbee/FrisbeeLauncherWeapon";

/**
 * Frisbee Launcher ammo readout (row inside the ATTACKS card, like the popcorn / famas):
 *
 *     LANCE-FRISBEE        ⬤  ● ● ● ● ●
 *
 * One BIG disc = the disc on the deck, five small discs = the cage (they go out one by one as
 * the automatic re-cock takes them, and light up again when a full cage clicks in). While the
 * cage is swapped the label reads "CAGE" and pulses. DOM is only touched when the displayed
 * state actually changes — never per frame.
 */
export class FrisbeeLauncherHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly deck: HTMLElement;
  private readonly cage: HTMLElement[] = [];

  private lastDeck: boolean | null = null;
  private lastCage = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(cageCapacity: number) {
    this.root = document.createElement("div");
    this.root.id = "frisbee-launcher-hud";
    this.root.style.cssText = [
      "display:none",
      "flex-direction:row",
      "align-items:center",
      "justify-content:space-between",
      "gap:8px",
      "font-family:'Baloo 2','Segoe UI',sans-serif",
      "pointer-events:none",
    ].join(";");

    this.label = document.createElement("div");
    this.label.textContent = "LANCE-FRISBEE";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#fdba74;text-shadow:0 0 6px rgba(249,115,22,0.8);transition:opacity 0.2s";
    this.root.appendChild(this.label);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px";
    this.deck = document.createElement("span");
    this.deck.style.cssText = "width:17px;height:17px;border-radius:50%;transition:all 0.12s ease";
    row.appendChild(this.deck);
    const cage = document.createElement("div");
    cage.style.cssText = "display:flex;gap:4px";
    for (let i = 0; i < cageCapacity; i++) {
      const dot = document.createElement("span");
      dot.style.cssText = "width:9px;height:9px;border-radius:50%;transition:all 0.12s ease";
      cage.appendChild(dot);
      this.cage.push(dot);
    }
    row.appendChild(cage);
    this.root.appendChild(row);
    (document.getElementById("attack-rows") ?? document.body).appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(weapon: FrisbeeLauncherWeapon): void {
    if (this.lastVisible === false) return;
    const deck = weapon.deckLoaded;
    const cage = weapon.cageCount;
    const reloading = weapon.isReloading;
    if (deck === this.lastDeck && cage === this.lastCage && reloading === this.lastReloading) return;
    this.lastDeck = deck;
    this.lastCage = cage;
    this.lastReloading = reloading;

    this.label.textContent = reloading ? "CAGE" : "LANCE-FRISBEE";
    this.label.style.opacity = reloading ? "0.7" : "1";
    const on = "#fb923c";
    this.deck.style.border = `2px solid ${on}`;
    this.deck.style.background = deck ? on : "transparent";
    this.deck.style.boxShadow = deck ? `0 0 8px ${on}` : "none";
    for (let i = 0; i < this.cage.length; i++) {
      const dot = this.cage[i];
      const loaded = i < cage;
      dot.style.border = `1px solid ${on}99`;
      dot.style.background = loaded ? "#fed7aa" : "transparent";
      dot.style.boxShadow = loaded ? "0 0 5px rgba(253,186,116,0.9)" : "none";
    }
  }
}
