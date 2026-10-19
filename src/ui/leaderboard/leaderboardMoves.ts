import { AnimHost } from "./leaderboardAnim";
import { LbMotion } from "./leaderboardMotion";
import { NO_SCALE, Row, Scale, cancelRowAnims, displayedScale } from "./leaderboardRows";

const y = (px: number): string => `translateY(${px}px)`;

function drawnTranslate(el: Element): string {
  const t = getComputedStyle(el).translate;
  return !t || t === "none" ? "0px 0px" : t.includes(" ") ? t : `${t} 0px`;
}

/**
 * What the hero / loss recipes continue from: the lateral kick (`translate`
 * of the row) and the capsule's squash / stretch (transform of the shell), as
 * DRAWN — read before the update writes anything (see leaderboardRows).
 */
export interface DrawnRow {
  translate: string;
  shell: Scale;
}

export function measureDrawn(row: Row): DrawnRow {
  return {
    translate: row.lateral || row.entering ? drawnTranslate(row.el) : "0px 0px",
    shell: row.shellAnim ? displayedScale(row.shell) : NO_SCALE,
  };
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
  hero(row: Row, from: number, top: number, ms: number, lead: boolean, drawn: DrawnRow): void {
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
    row.lateral?.cancel();
    row.lateral = this.host.play(
      row.el,
      [
        { translate: drawn.translate, easing: "ease-out" },
        { translate: `${-lat}px 0px`, offset: 0.24 },
        { translate: `${-lat}px 0px`, offset: lead ? 0.7 : 0.66, easing: "ease-in-out" },
        { translate: "0px 0px" },
      ],
      { duration: ms },
      () => {
        row.lateral = null;
      },
    );
    this.shell(row, ms, m.gainShell, drawn.shell);
  }

  /** Losing places: a quieter descent, tiny overshoot, no lateral kick, no reward. */
  loss(row: Row, from: number, top: number, drawn: DrawnRow): void {
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
    this.shell(row, m.lossMoveMs, m.lossShell, drawn.shell);
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
  private shell(row: Row, ms: number, amount: number, cur: Scale): void {
    if (amount <= 0) return;
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
    row.entering = this.host.play(
      row.el,
      [
        { opacity: 0, translate: `${dx}px 0px` },
        { opacity: 1, translate: "0px 0px" },
      ],
      { duration: this.motion().quietMs, easing: "ease-out" },
      () => {
        row.entering = null;
      },
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
