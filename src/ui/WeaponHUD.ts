import { HeatSystem } from "../weapons/HeatSystem";
import { createGauge, WeaponPlate } from "./hudKit";

const ACCENT = "#a8d94a"; // bean green (menu --mm-green-bright)

/**
 * Beam weapon HEAT plate — a flame badge + a heat tube that goes green →
 * orange → red. OVERHEAT happens ON THE PLATE (no sticker over the aim):
 * the plate shakes and turns red, the ribbon reads "TOO HOT!", the count
 * shows the live cooling countdown and the badge ring drains with it; on
 * recovery the ribbon pops "READY!" for a moment.
 * Also drives the subtle crosshair hit feedback.
 */
export class WeaponHUD {
  private readonly plate: WeaponPlate;
  private readonly setLevel: (ratio: number) => void;
  private readonly crosshairEl: HTMLElement;

  private readyTimer = 0;
  private wasOverheated = false;
  private coolTotal = 0;
  private lastPercent = -1;
  private lastTime = "";
  private lastHit: boolean | null = null;
  private visible: boolean | null = null;

  constructor() {
    this.plate = new WeaponPlate("heat-hud", "HEAT", "heat", ACCENT, null);
    this.setLevel = createGauge(this.plate.ammo, "heat");
    this.crosshairEl = document.getElementById("crosshair")!;
  }

  /** The heat plate only exists while the heat weapon is equipped. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.plate.setVisible(visible);
    if (visible) this.lastPercent = -1;
  }

  update(dt: number, heat: HeatSystem, hittingTarget: boolean): void {
    // Subtle crosshair hit feedback (independent of the plate).
    if (hittingTarget !== this.lastHit) {
      this.lastHit = hittingTarget;
      this.crosshairEl.classList.toggle("hit", hittingTarget);
    }
    if (!this.visible) return;

    const ratio = heat.ratio;
    const overheated = heat.overheated;

    if (overheated) {
      if (!this.wasOverheated) {
        this.wasOverheated = true;
        this.readyTimer = 0;
        this.coolTotal = Math.max(0.01, heat.cooldownRemaining);
        this.plate.setName("TOO HOT!");
        this.plate.setState("low");
        this.plate.root.classList.add("overheat");
        this.plate.stamp("TOO HOT!");
      }
      const t = heat.cooldownRemaining.toFixed(1);
      if (t !== this.lastTime) {
        this.lastTime = t;
        this.plate.setCount(`${t}s`);
      }
      this.plate.setRing(heat.cooldownRemaining / this.coolTotal);
      this.setLevel(1);
      return;
    }

    if (this.wasOverheated) {
      // Just recovered: pop READY! briefly on the ribbon.
      this.wasOverheated = false;
      this.readyTimer = 0.8;
      this.lastPercent = -1;
      this.lastTime = "";
      this.plate.root.classList.remove("overheat");
      this.plate.setName("READY!");
      this.plate.setRing(-1);
    } else if (this.readyTimer > 0) {
      this.readyTimer -= dt;
      if (this.readyTimer <= 0) this.plate.setName();
    }

    const percent = Math.round(ratio * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.plate.setCount(`${percent}%`);
      this.plate.setState(ratio > 0.7 ? "hot" : "");
      this.setLevel(ratio);
    }
  }
}
