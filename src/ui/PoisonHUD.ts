import { PoisonWeapon } from "../weapons/poison/PoisonWeapon";

/**
 * Discreet Lance-Poison charge readout (bottom-right, ATTACKS card —
 * same slot pattern as the RevolverHUD):
 *
 *     POISON
 *     [██████████░░░░]  73%
 *
 * The bar is the SAME charge the gameplay drains and the liquid tank
 * displays. DOM is only touched when the shown state actually changes.
 */
export class PoisonHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly barFill: HTMLElement;
  private readonly value: HTMLElement;

  private lastPercent = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "poison-hud";
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
    this.label.textContent = "POISON";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#4ade80;text-shadow:0 0 6px rgba(57,255,20,0.8)";
    this.root.appendChild(this.label);

    const barWrap = document.createElement("div");
    barWrap.style.cssText =
      "flex:1;max-width:110px;height:8px;border-radius:4px;overflow:hidden;" +
      "background:rgba(20,40,20,0.7);border:1px solid rgba(57,255,20,0.35)";
    this.barFill = document.createElement("div");
    this.barFill.style.cssText =
      "height:100%;width:100%;background:linear-gradient(90deg,#16a34a,#39ff14);" +
      "box-shadow:0 0 8px rgba(57,255,20,0.8);transition:width 0.08s linear";
    barWrap.appendChild(this.barFill);
    this.root.appendChild(barWrap);

    this.value = document.createElement("div");
    this.value.textContent = "100%";
    this.value.style.cssText =
      "font-size:11px;min-width:34px;text-align:right;color:#bbf7d0;" +
      "text-shadow:0 0 5px rgba(57,255,20,0.6)";
    this.root.appendChild(this.value);

    (document.getElementById("attack-rows") ?? document.body).appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(weapon: PoisonWeapon): void {
    if (this.lastVisible === false) return;

    const percent = Math.round(weapon.fillFraction * 100);
    const reloading = weapon.isReloading;
    if (percent === this.lastPercent && reloading === this.lastReloading) return;
    this.lastPercent = percent;
    this.lastReloading = reloading;

    this.barFill.style.width = `${percent}%`;
    this.value.textContent = `${percent}%`;
    if (reloading) {
      this.label.textContent = "REFILLING";
      this.label.style.color = "#86efac";
    } else {
      this.label.textContent = "POISON";
      this.label.style.color = "#4ade80";
    }
  }
}
