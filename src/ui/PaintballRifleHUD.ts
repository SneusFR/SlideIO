import { PaintballRifleWeapon } from "../weapons/paintball/PaintballRifleWeapon";

/**
 * Paintball Rifle ammo readout (row inside the ATTACKS card, like the
 * revolver / popcorn):
 *
 *     PAINTBALL        24 / 32   ▮▮▮▮▮▮▮▯
 *
 * Counter + a thin 8-segment gauge (4 balls per segment); while the hopper
 * is swapped the label reads "RECHARGE" and pulses. DOM is only touched
 * when the displayed state actually changes — never per frame.
 */
export class PaintballRifleHUD {
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
    this.root.id = "paintball-rifle-hud";
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
    this.label.textContent = "PAINTBALL";
    this.label.style.cssText =
      "font-size:10px;letter-spacing:3px;color:#99f6e4;text-shadow:0 0 6px rgba(45,212,191,0.8);transition:opacity 0.2s";
    this.root.appendChild(this.label);

    const right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:8px";
    this.count = document.createElement("div");
    this.count.style.cssText = "font-size:13px;font-weight:700;color:#f0fdfa;min-width:48px;text-align:right";
    right.appendChild(this.count);
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:2px";
    const colors = ["#f87171", "#facc15", "#2dd4bf"]; // the three paint colours
    for (let i = 0; i < 8; i++) {
      const seg = document.createElement("span");
      seg.dataset.color = colors[i % colors.length];
      seg.style.cssText = "width:5px;height:11px;border-radius:2px;transition:all 0.1s ease";
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

  update(weapon: PaintballRifleWeapon): void {
    if (this.lastVisible === false) return;
    const ammo = weapon.ammo;
    const reloading = weapon.isReloading;
    if (ammo === this.lastAmmo && reloading === this.lastReloading) return;
    this.lastAmmo = ammo;
    this.lastReloading = reloading;

    this.label.textContent = reloading ? "RECHARGE" : "PAINTBALL";
    this.label.style.opacity = reloading ? "0.7" : "1";
    this.count.textContent = `${ammo} / ${this.capacity}`;
    this.count.style.color = ammo <= this.capacity / 4 ? "#fca5a5" : "#f0fdfa";
    const perSeg = this.capacity / this.segments.length;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const filled = ammo > i * perSeg;
      const c = seg.dataset.color ?? "#fff";
      seg.style.border = `1px solid ${c}99`;
      seg.style.background = filled ? c : "transparent";
      seg.style.boxShadow = filled ? `0 0 5px ${c}cc` : "none";
    }
  }
}
