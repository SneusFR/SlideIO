import { PopcornShotgunWeapon } from "../weapons/popcorn/PopcornShotgunWeapon";

/**
 * Popcorn Shotgun ammo readout (row inside the ATTACKS card, like the
 * revolver):
 *
 *     POPCORN        ● ●
 *
 * Two dots = two popcorn loads; while reloading the label reads
 * "RECHARGE" and pulses. DOM is only touched when the displayed state
 * actually changes — never per frame.
 */
export class PopcornShotgunHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly dots: HTMLElement[] = [];

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(shots: number) {
    this.root = document.createElement("div");
    this.root.id = "popcorn-shotgun-hud";
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
    this.label.textContent = "POPCORN";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#fde68a;text-shadow:0 0 6px rgba(251,191,36,0.8);transition:opacity 0.2s";
    this.root.appendChild(this.label);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px";
    for (let i = 0; i < shots; i++) {
      const dot = document.createElement("span");
      dot.style.cssText =
        "width:11px;height:11px;border-radius:50%;background:#fff7d6;" +
        "box-shadow:0 0 6px rgba(253,230,138,0.9);transition:all 0.12s ease";
      row.appendChild(dot);
      this.dots.push(dot);
    }
    this.root.appendChild(row);
    (document.getElementById("attack-rows") ?? document.body).appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(weapon: PopcornShotgunWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.label.textContent = reloading ? "RECHARGE" : "POPCORN";
    this.label.style.opacity = reloading ? "0.7" : "1";
    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      const loaded = i < ammo;
      dot.style.border = "1px solid rgba(253,230,138,0.6)";
      dot.style.background = loaded ? "#fff7d6" : "transparent";
      dot.style.boxShadow = loaded ? "0 0 6px rgba(253,230,138,0.9)" : "none";
    }
  }
}
