import { AnimHost } from "./leaderboardAnim";
import { LbMotion } from "./leaderboardMotion";
import { Row, cancelRowAnims } from "./leaderboardRows";

const y = (px: number): string => `translateY(${px}px)`;

/** The drawn scale of an element (animations included), so a new shell animation continues from it. */
function drawnScale(el: Element): { x: number; y: number } {
  const mtx = new DOMMatrix(getComputedStyle(el).transform);
  return { x: mtx.a || 1, y: mtx.d || 1 };
}

function drawnTranslate(el: Element): string {
  const t = getComputedStyle(el).translate;
  return !t || t === "none" ? "0px 0px" : t.includes(" ") ? t : `${t} 0px`;
}

/**
 * Row movement recipes. Position (transform on the row), lateral kick
 * (`translate` on the row) and hull deformation (transform on the shell) are
 * three separate animations on purpose: the text never deforms and a new
 * update can restart each one from where it is DRAWN.
 */
export class RowMover {
  constructor(
    private readonly host: AnimHost,
    private readonly motion: () => LbMotion,
    private readonly isReduced: () => boolean,
  ) {}

  /** Overtake: slight lateral advance, slide, 2-3px overshoot, settle. */
  hero(row: Row, from: number, top: number, ms: number, lead: boolean): void {
    const m = this.motion();
    const dir = Math.sign(top - from) || -1;
    row.move = this.host.play(
      row.el,
      [
        { transform: y(from), easing: "cubic-bezier(0.3, 0.05, 0.2, 1)" },
        { transform: y(top + dir * m.gainOvershoot), offset: 0.78, easing: "ease-out" },
        { transform: y(top) },
      ],
      { duration: ms },
      () => {
        row.move = null;
      },
    );
    const lat = m.gainLateral;
    const start = drawnTranslate(row.el);
    row.lateral?.cancel();
    row.lateral = this.host.play(
      row.el,
      [
        { translate: start, easing: "ease-out" },
        { translate: `${-lat}px 0px`, offset: 0.24 },
        { translate: `${-lat}px 0px`, offset: lead ? 0.7 : 0.66, easing: "ease-in-out" },
        { translate: "0px 0px" },
      ],
      { duration: ms },
      () => {
        row.lateral = null;
      },
    );
    this.shell(row, ms, m.gainShell);
  }

  /** Losing places: a quieter descent, tiny overshoot, no lateral kick, no reward. */
  loss(row: Row, from: number, top: number): void {
    const m = this.motion();
    const dir = Math.sign(top - from) || 1;
    row.move = this.host.play(
      row.el,
      [
        { transform: y(from), easing: "cubic-bezier(0.3, 0.05, 0.25, 1)" },
        { transform: y(top + dir * m.lossOvershoot), offset: 0.82, easing: "ease-out" },
        { transform: y(top) },
      ],
      { duration: m.lossMoveMs },
      () => {
        row.move = null;
      },
    );
    this.shell(row, m.lossMoveMs, m.lossShell);
  }

  /** Plain slide: yielding rows, opponents and reduced motion. */
  slide(row: Row, from: number, top: number, ms: number): void {
    row.move = this.host.play(
      row.el,
      [{ transform: y(from) }, { transform: y(top) }],
      { duration: ms, easing: this.isReduced() ? "ease-out" : "cubic-bezier(0.3, 0.1, 0.2, 1)" },
      () => {
        row.move = null;
      },
    );
    row.lateral?.cancel();
    row.lateral = null;
  }

  /** Capsule-only squash & stretch: stretch while travelling, squash on touch-down. */
  private shell(row: Row, ms: number, amount: number): void {
    if (amount <= 0) return;
    const cur = drawnScale(row.shell);
    row.shellAnim?.cancel();
    row.shellAnim = this.host.play(
      row.shell,
      [
        { transform: `scale(${cur.x}, ${cur.y})` },
        { transform: `scale(${1 - amount * 0.5}, ${1 + amount})`, offset: 0.36, easing: "ease-out" },
        { transform: `scale(${1 + amount * 0.6}, ${1 - amount * 0.8})`, offset: 0.8, easing: "ease-out" },
        { transform: "scale(1, 1)" },
      ],
      { duration: ms },
      () => {
        row.shellAnim = null;
      },
    );
  }

  /** A player joined: the capsule fades in from the side, no teleport. */
  enter(row: Row): void {
    const dx = this.isReduced() ? 0 : 10;
    this.host.play(
      row.el,
      [
        { opacity: 0, translate: `${dx}px 0px` },
        { opacity: 1, translate: "0px 0px" },
      ],
      { duration: this.motion().quietMs, easing: "ease-out" },
    );
  }

  /** A player left: the capsule fades out where it is drawn, then is removed. */
  retire(row: Row, atY: number, leaving: Set<HTMLElement>): void {
    cancelRowAnims(row);
    const el = row.el;
    el.style.transform = y(atY);
    leaving.add(el);
    this.host.play(
      el,
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: Math.min(180, this.motion().quietMs), fill: "forwards" },
      () => {
        el.remove();
        leaving.delete(el);
      },
    );
  }
}
