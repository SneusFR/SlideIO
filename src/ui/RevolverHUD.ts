import { RevolverWeapon } from "../weapons/revolver/RevolverWeapon";

/**
 * Discreet revolver ammo readout (bottom-right, above the melee zone):
 *
 *     REVOLVER
 *     ● ● ● ● ● ●
 *
 * Dots empty in real time (fan fire syncs 6→0 with the actual shots);
 * during materialization the chip pulses violet. DOM is only touched
 * when the displayed state actually changes — never per frame.
 */
export class RevolverHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly dots: HTMLElement[] = [];

  private lastAmmo = -1;
  private lastMaterializing: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "revolver-hud";
    // Row inside the ATTACKS card (bottom-right column) — the card owns
    // the chrome, this element only lays out label + ammo dots.
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
    this.label.textContent = "REVOLVER";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#c084fc;text-shadow:0 0 6px rgba(168,85,247,0.8)";
    this.root.appendChild(this.label);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px";
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement("span");
      dot.style.cssText =
        "width:9px;height:9px;border-radius:50%;background:#e9d5ff;" +
        "box-shadow:0 0 6px rgba(216,180,254,0.9);transition:all 0.12s ease";
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

  update(weapon: RevolverWeapon): void {
    if (this.lastVisible === false) return;

    const ammo = weapon.currentAmmo;
    const materializing = weapon.isMaterializing;
    if (ammo === this.lastAmmo && materializing === this.lastMaterializing) return;
    this.lastAmmo = ammo;
    this.lastMaterializing = materializing;

    if (materializing) {
      this.label.textContent = "MATERIALIZING";
      this.label.style.color = "#a855f7";
      for (const dot of this.dots) {
        dot.style.background = "transparent";
        dot.style.boxShadow = "0 0 5px rgba(168,85,247,0.7)";
        dot.style.border = "1px solid rgba(168,85,247,0.8)";
      }
      return;
    }

    this.label.textContent = "REVOLVER";
    this.label.style.color = "#c084fc";
    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      const loaded = i < ammo;
      dot.style.border = "1px solid rgba(216,180,254,0.5)";
      dot.style.background = loaded ? "#e9d5ff" : "transparent";
      dot.style.boxShadow = loaded ? "0 0 6px rgba(216,180,254,0.9)" : "none";
    }
  }
}