import { BassBlasterWeapon } from "../weapons/bassblaster/BassBlasterWeapon";

/**
 * Discreet Bass Blaster ammo readout (bottom-right, above the melee zone —
 * same spot as the revolver chip, only one primary is ever visible):
 *
 *     BASS BLASTER          30/30
 *     ████████████████████████░░░
 *
 * The bar drains with the magazine; during the musical reload it turns
 * into a violet fill animating with the reload progress. DOM is only
 * touched when the displayed state actually changes — never per frame.
 */
export class BassBlasterHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly barFill: HTMLElement;

  private lastAmmo = -1;
  private lastReloadPct = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "bassblaster-hud";
    this.root.style.cssText = [
      "position:fixed",
      "right:26px",
      "bottom:150px",
      "display:none",
      "flex-direction:column",
      "gap:6px",
      "width:190px",
      "padding:8px 12px",
      "background:rgba(10,6,20,0.55)",
      "border:1px solid rgba(168,85,247,0.35)",
      "border-radius:8px",
      "font-family:'Segoe UI',system-ui,sans-serif",
      "pointer-events:none",
      "z-index:40",
      "backdrop-filter:blur(2px)",
    ].join(";");

    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;justify-content:space-between;align-items:baseline";

    this.label = document.createElement("div");
    this.label.textContent = "\u266A BASS BLASTER";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:2.5px;color:#c084fc;text-shadow:0 0 6px rgba(168,85,247,0.8)";

    this.counter = document.createElement("div");
    this.counter.style.cssText =
      "font-size:13px;font-weight:600;color:#e9d5ff;text-shadow:0 0 6px rgba(216,180,254,0.8)";

    topRow.append(this.label, this.counter);
    this.root.appendChild(topRow);

    const bar = document.createElement("div");
    bar.style.cssText = [
      "height:6px",
      "border-radius:3px",
      "background:rgba(124,58,237,0.15)",
      "border:1px solid rgba(168,85,247,0.25)",
      "overflow:hidden",
    ].join(";");
    this.barFill = document.createElement("div");
    this.barFill.style.cssText = [
      "height:100%",
      "width:100%",
      "border-radius:3px",
      "background:linear-gradient(90deg,#7c3aed,#d8b4fe)",
      "box-shadow:0 0 8px rgba(168,85,247,0.8)",
      "transition:width 0.08s linear",
    ].join(";");
    bar.appendChild(this.barFill);
    this.root.appendChild(bar);

    document.body.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(weapon: BassBlasterWeapon): void {
    if (this.lastVisible === false) return;

    const ammo = weapon.currentAmmo;
    const reloading = weapon.isReloading;
    const reloadPct = reloading ? Math.round(weapon.reloadProgress * 100) : -1;
    if (
      ammo === this.lastAmmo &&
      reloading === this.lastReloading &&
      reloadPct === this.lastReloadPct
    ) {
      return;
    }
    this.lastAmmo = ammo;
    this.lastReloading = reloading;
    this.lastReloadPct = reloadPct;

    if (reloading) {
      this.label.textContent = "\u266B RECHARGE\u2026";
      this.label.style.color = "#a855f7";
      this.counter.textContent = "\u266A \u266B \u266A";
      this.barFill.style.width = `${reloadPct}%`;
      this.barFill.style.background = "linear-gradient(90deg,#a855f7,#f0abfc)";
      return;
    }

    this.label.textContent = "\u266A BASS BLASTER";
    this.label.style.color = "#c084fc";
    this.counter.textContent = `${ammo}/${weapon.maxAmmo}`;
    this.barFill.style.width = `${(ammo / weapon.maxAmmo) * 100}%`;
    this.barFill.style.background = "linear-gradient(90deg,#7c3aed,#d8b4fe)";
  }
}