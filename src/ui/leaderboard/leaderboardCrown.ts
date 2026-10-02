import { AnimHost } from "./leaderboardAnim";
import { LbMotion } from "./leaderboardMotion";
import { Row } from "./leaderboardRows";

const CROWN_SVG = `
<svg viewBox="0 0 26 20" aria-hidden="true">
  <path d="M3 17 L1.6 5.4 L8.2 10.2 L13 2 L17.8 10.2 L24.4 5.4 L23 17 Z" fill="#ffd60a" stroke="#0b0b10" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M5.2 14.2 H20.8" stroke="#0b0b10" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
</svg>`;

export type CrownMove = "none" | "lead-gain" | "lead-loss";

/**
 * The crown: ONE element, ever. Owning it = being its DOM parent, so it can never
 * be shown twice, and it travels with its row. Ownership changes are animated as
 * a FLIP from the crown's DRAWN position (so an interrupted flight continues, it
 * never teleports); the DOM parent switches immediately.
 */
export class Crown {
  readonly el: HTMLDivElement;
  ownerId: number | null = null;
  private anim: Animation | null = null;

  constructor(private readonly host: AnimHost) {
    this.el = document.createElement("div");
    this.el.className = "lb-crown";
    this.el.innerHTML = CROWN_SVG;
  }

  /** Drawn rect BEFORE anything changes (null when the crown is not on screen). */
  measure(): DOMRect | null {
    return this.el.isConnected ? this.el.getBoundingClientRect() : null;
  }

  /** Instant placement (first build / rebuild / reset). */
  set(owner: Row | null, rows: Iterable<Row>): void {
    this.anim?.cancel();
    this.anim = null;
    for (const r of rows) r.el.classList.toggle("has-crown", r === owner);
    if (owner) owner.el.appendChild(this.el);
    else this.el.remove();
    this.ownerId = owner ? owner.id : null;
  }

  /**
   * Ownership change with motion. Call AFTER the rows' own animations were started,
   * so the new owner is measured where it is drawn at t=0.
   */
  move(
    owner: Row | null,
    rows: Iterable<Row>,
    from: DOMRect | null,
    kind: CrownMove,
    m: LbMotion,
    scale: number,
  ): void {
    const id = owner ? owner.id : null;
    if (id === this.ownerId && (owner === null || this.el.parentElement === owner.el)) return;
    this.anim?.cancel();
    this.anim = null;
    for (const r of rows) r.el.classList.toggle("has-crown", r === owner);
    if (!owner) {
      this.el.remove();
      this.ownerId = null;
      return;
    }
    owner.el.appendChild(this.el);
    this.ownerId = id;
    const done = (): void => {
      this.anim = null;
    };

    // Reduced motion: no flight, no bounce — a plain fade-in on the new owner.
    if (!m.bounce) {
      this.anim = this.host.play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: m.quietMs }, done);
      return;
    }

    // Nobody wore it before: it comes down onto the badge (one bounce on a take-over).
    if (!from) {
      this.anim = this.host.play(
        this.el,
        [
          { transform: `translateY(${-m.crownDropFrom}px) scale(0.7)`, opacity: 0, easing: "cubic-bezier(0.3, 0, 0.3, 1)" },
          { transform: "translateY(0) scale(1)", opacity: 1, offset: 0.55, easing: "ease-out" },
          { transform: "translateY(-5px) scale(1)", opacity: 1, offset: 0.78, easing: "ease-in" },
          { transform: "translateY(0) scale(1)", opacity: 1 },
        ],
        { duration: m.leadTotalMs },
        done,
      );
      return;
    }

    const to = this.el.getBoundingClientRect();
    const s = scale || 1;
    const dx = (from.left - to.left) / s;
    const dy = (from.top - to.top) / s;
    const at = (x: number, y: number): string => `translate(${x}px, ${y}px)`;
    if (kind === "lead-gain") {
      // Same slide as my row, then the crown settles with a SINGLE bounce.
      this.anim = this.host.play(
        this.el,
        [
          { transform: at(dx, dy), easing: "cubic-bezier(0.35, 0.05, 0.25, 1)" },
          { transform: at(0, 0), offset: 0.6, easing: "ease-out" },
          { transform: at(0, -6), offset: 0.78, easing: "ease-in" },
          { transform: at(0, 0) },
        ],
        { duration: m.leadTotalMs },
        done,
      );
    } else {
      // Losing the lead / opponents trading it: it just joins the real first, no flourish.
      const ms = kind === "lead-loss" ? m.lossMoveMs : m.quietMs + 80;
      this.anim = this.host.play(
        this.el,
        [{ transform: at(dx, dy) }, { transform: at(0, 0) }],
        { duration: ms, easing: "cubic-bezier(0.32, 0.05, 0.2, 1)" },
        done,
      );
    }
  }
}
