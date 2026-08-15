import { MedalType } from "../medals/MedalType";
import { MedalAssets, MedalConfig as mc } from "../medals/MedalConfig";
import { MedalDisplay } from "../medals/MedalManager";

/**
 * Top-center medal display (DOM/CSS — responsive, % based, never covers
 * the crosshair). Uses the REAL medal image assets, preloaded at
 * construction so a kill never triggers an asset load.
 *
 * Presentation (driven by the MedalManager state machine + CSS):
 *   scale 0 → pop/overshoot → settle → visible → fade + drift out
 * with a violet aura (radial glow + drop-shadow) and a quick back-flash.
 */
export class MedalHUD implements MedalDisplay {
  private readonly root = document.getElementById("medal-display") as HTMLDivElement;
  private readonly img = document.getElementById("medal-img") as HTMLImageElement;
  private readonly glow = document.getElementById("medal-glow") as HTMLDivElement;
  private readonly flash = document.getElementById("medal-flash") as HTMLDivElement;
  /** Keep strong refs so the browser caches every medal image up-front. */
  private readonly preloaded: HTMLImageElement[] = [];

  constructor() {
    // Configurable animation durations → CSS variables (single source: MedalConfig).
    this.root.style.setProperty("--medal-enter", `${mc.medalEnterDuration}s`);
    this.root.style.setProperty("--medal-exit", `${mc.medalExitDuration}s`);

    for (const url of Object.values(MedalAssets)) {
      const image = new Image();
      image.src = url;
      this.preloaded.push(image);
    }
  }

  show(medal: MedalType, chainIndex: number): void {
    this.img.src = MedalAssets[medal];

    // Aura slightly more intense as the medal chain grows — kept elegant,
    // never a giant neon rectangle.
    const glowAlpha = Math.min(0.35 + chainIndex * 0.06, 0.6);
    this.root.style.setProperty("--medal-glow-alpha", glowAlpha.toFixed(2));

    this.root.classList.remove("hidden", "exiting");
    // Retrigger the enter animations even when chaining medals fast.
    this.restartAnimation(this.img);
    this.restartAnimation(this.glow);
    this.restartAnimation(this.flash);
  }

  beginExit(): void {
    this.root.classList.add("exiting");
  }

  hide(): void {
    this.root.classList.add("hidden");
    this.root.classList.remove("exiting");
  }

  /** Force-restart a CSS animation on an element (classic reflow trick). */
  private restartAnimation(el: HTMLElement): void {
    el.style.animation = "none";
    void el.offsetWidth; // reflow
    el.style.animation = "";
  }
}