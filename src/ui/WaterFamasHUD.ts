import { WaterFamasWeapon } from "../weapons/waterfamas/WaterFamasWeapon";

/**
 * Water FAMAS ammo readout (row inside the ATTACKS card, like the paintball /
 * popcorn):
 *
 *     FAMAS À EAU        6 / 9   ▮▮▮▮▮▮▯▯▯
 *
 * Counter + a 9-segment gauge (one per jet, three bursts of three); while the
 * tank is refilled the label reads "REMPLISSAGE" and pulses. DOM is only
 * touched when the displayed state actually changes — never per frame.
 */
export class WaterFamasHUD {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly count: HTMLElement;
  private readonly segments: HTMLElement[] = [];
  private readonly capacity: number;

  private lastAmmo = -1;
  private lastReloading: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.root = document.createElement("div");
    this.root.id = "water-famas-hud";
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
    this.label.textContent = "FAMAS À EAU";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#bae6fd;text-shadow:0 0 6px rgba(56,189,248,0.8);transition:opacity 0.2s";
    this.root.appendChild(this.label);

    const right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:8px";
    this.count = document.createElement("div");
    this.count.style.cssText = "font-size:13px;font-weight:700;color:#f0f9ff;min-width:40px;text-align:right";
    right.appendChild(this.count);
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:2px";
    for (let i = 0; i < capacity; i++) {
      const seg = document.createElement("span");
      // a slightly wider gap after each burst of 3
      seg.style.cssText = `width:5px;height:11px;border-radius:2px;transition:all 0.1s ease;margin-right:${i % 3 === 2 && i < capacity - 1 ? 3 : 0}px`;
      bar.appendChild(seg);
      this.segments.push(seg);
    }
    right.appendChild(bar);
    this.root.appendChild(right);
    (document.getElementById("attack-rows") ?? document.body).appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(weapon: WaterFamasWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.label.textContent = reloading ? "REMPLISSAGE" : "FAMAS À EAU";
    this.label.style.opacity = reloading ? "0.7" : "1";
    this.count.textContent = `${ammo} / ${this.capacity}`;
    this.count.style.color = ammo <= 3 ? "#fca5a5" : "#f0f9ff";
    const c = "#38bdf8";
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const filled = ammo > i;
      seg.style.border = `1px solid ${c}99`;
      seg.style.background = filled ? c : "transparent";
      seg.style.boxShadow = filled ? `0 0 5px ${c}cc` : "none";
    }
  }
}
