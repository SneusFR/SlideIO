import { MedalType } from "../medals/MedalType";
import { MedalStyles, MedalConfig as mc } from "../medals/MedalConfig";
import { MedalDisplay } from "../medals/MedalManager";
import { medalIconSvg, MEDAL_STAR_SVG, ribbonTailSvg } from "./hudIcons";
import { replayAnim } from "./hudKit";

/** Chain length from which the badge goes "hype" (faster rays, bigger pop). */
const HYPE_CHAIN = 2;

/**
 * Medal display — a "Bean Sticker Arcade" badge (same family as the
 * killstreak medallions): round parchment disc with the medal art, gold
 * tier stars on top, a notched ribbon with the name, sunburst rays and a
 * confetti burst. Sits above the crosshair clear zone, under the
 * top-centre stack.
 *
 *    ★ ★ ★        ← tier stars (combo medals only)
 *   ( ◉ art )     ← disc, rim in the medal's accent colour
 *  <═ LABEL ═>    ← ribbon
 *
 * Every node is built ONCE here (all 9 arts pre-rendered, one visible);
 * show() only swaps classes / text / one CSS variable, and one-shot
 * animations restart through replayAnim (no forced reflow).
 */
export class MedalHUD implements MedalDisplay {
  private readonly root = document.getElementById("medal-display") as HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly arts = new Map<MedalType, SVGElement>();

  private current: MedalType | null = null;
  private lastStars = -1;
  private lastHype: boolean | null = null;

  constructor() {
    // Configurable animation durations → CSS variables (single source: MedalConfig).
    this.root.style.setProperty("--medal-enter", `${mc.medalEnterDuration}s`);
    this.root.style.setProperty("--medal-exit", `${mc.medalExitDuration}s`);

    const allMedals = Object.values(MedalType) as MedalType[];
    this.root.innerHTML = `
      <div class="md-body">
        <div class="md-stars">${MEDAL_STAR_SVG.repeat(3)}</div>
        <div class="md-medallion">
          <div class="md-rays"></div>
          <div class="md-disc">
            <div class="md-art">${allMedals.map((m) => medalIconSvg(m)).join("")}</div>
          </div>
          <div class="md-confetti">${"<i></i>".repeat(8)}</div>
        </div>
        <div class="md-ribbon">
          ${ribbonTailSvg("l")}${ribbonTailSvg("r")}
          <div class="md-plank"><span class="md-label"></span></div>
        </div>
      </div>`;

    this.body = this.root.querySelector(".md-body")!;
    this.label = this.root.querySelector(".md-label")!;
    for (const svg of this.root.querySelectorAll<SVGElement>(".md-icon")) {
      this.arts.set(svg.dataset.medal as MedalType, svg);
    }
  }

  show(medal: MedalType, chainIndex: number): void {
    const style = MedalStyles[medal];

    if (medal !== this.current) {
      if (this.current !== null) this.arts.get(this.current)?.classList.remove("on");
      this.arts.get(medal)?.classList.add("on");
      this.current = medal;
      this.label.textContent = style.label;
      this.root.style.setProperty("--md", style.color);
    }

    if (style.stars !== this.lastStars) {
      if (this.lastStars > 0) this.root.classList.remove(`stars-${this.lastStars}`);
      if (style.stars > 0) this.root.classList.add(`stars-${style.stars}`);
      this.lastStars = style.stars;
    }

    // The badge gets louder as the chain of medals grows.
    const hype = chainIndex >= HYPE_CHAIN;
    if (hype !== this.lastHype) {
      this.root.classList.toggle("hype", hype);
      this.lastHype = hype;
    }

    this.root.classList.remove("hidden", "exiting");
    // Re-trigger the pop even when medals chain quickly.
    replayAnim(this.body, "pop");
  }

  beginExit(): void {
    this.root.classList.add("exiting");
  }

  hide(): void {
    this.root.classList.add("hidden");
    this.root.classList.remove("exiting");
  }
}