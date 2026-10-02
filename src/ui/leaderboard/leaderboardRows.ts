import { BEAN_BUDDY_SVG } from "../hudIcons";
import { AnimHost } from "./leaderboardAnim";
import { LbMotion } from "./leaderboardMotion";
import { LbEntry, scoreDigitsClass } from "./leaderboardLogic";

/**
 * One DOM row per player, created once and reused (identity = stable player id).
 * Three independent things animate, on three different elements:
 *   el    → position (transform: translateY) + lateral kick (translate)
 *   shell → squash / stretch of the capsule ONLY (text never deforms)
 *   score → the independent counter
 */
export interface Row {
  id: number;
  isLocal: boolean;
  el: HTMLDivElement;
  shell: HTMLDivElement;
  badge: HTMLDivElement;
  nameText: HTMLSpanElement;
  score: HTMLDivElement;
  scoreVal: HTMLSpanElement;
  gain: HTMLSpanElement | null;
  /** Target top (design px) — the position the row RESTS at. */
  top: number;
  rank: number;
  scoreValue: number;
  name: string;
  digits: string;
  gainSum: number;
  move: Animation | null;
  lateral: Animation | null;
  shellAnim: Animation | null;
  scoreAnim: Animation | null;
  gainAnim: Animation | null;
}

/** The real player portrait (same art as the Bean Buddy card), with its own gradient ids. */
const AVATAR_SVG = BEAN_BUDDY_SVG.replaceAll("bb-body-grad", "lb-body-grad").replaceAll("bb-leaf-grad", "lb-leaf-grad");

export const LOCAL_LABEL = "VOUS";

export function displayName(e: LbEntry): string {
  return e.isLocal ? LOCAL_LABEL : e.name;
}

export function createRow(e: LbEntry): Row {
  const el = document.createElement("div");
  el.className = e.isLocal ? "lb-row local" : "lb-row";
  el.dataset.id = String(e.id);
  el.innerHTML = `
    <div class="lb-shell"></div>
    <div class="lb-badge"></div>
    <div class="lb-name">${e.isLocal ? `<span class="lb-avatar">${AVATAR_SVG}</span>` : ""}<span class="lb-name-text"></span></div>
    <div class="lb-score"><span class="lb-score-val"></span></div>
    ${e.isLocal ? '<span class="lb-gain"></span>' : ""}`;
  return {
    id: e.id,
    isLocal: e.isLocal,
    el,
    shell: el.querySelector(".lb-shell") as HTMLDivElement,
    badge: el.querySelector(".lb-badge") as HTMLDivElement,
    nameText: el.querySelector(".lb-name-text") as HTMLSpanElement,
    score: el.querySelector(".lb-score") as HTMLDivElement,
    scoreVal: el.querySelector(".lb-score-val") as HTMLSpanElement,
    gain: el.querySelector(".lb-gain") as HTMLSpanElement | null,
    top: 0,
    rank: -1,
    scoreValue: -1,
    name: "",
    digits: "?",
    gainSum: 0,
    move: null,
    lateral: null,
    shellAnim: null,
    scoreAnim: null,
    gainAnim: null,
  };
}

/** Change-detected content update (values are written immediately, never animated). */
export function updateRow(row: Row, e: LbEntry, rank: number): void {
  if (row.rank !== rank) {
    row.rank = rank;
    row.badge.textContent = String(rank + 1);
    row.el.classList.toggle("r1", rank === 0);
  }
  const name = displayName(e);
  if (row.name !== name) {
    row.name = name;
    row.nameText.textContent = name;
  }
  if (row.scoreValue !== e.score) {
    row.scoreValue = e.score;
    row.scoreVal.textContent = String(e.score);
    const d = scoreDigitsClass(e.score);
    if (d !== row.digits) {
      row.digits = d;
      row.score.className = d ? `lb-score ${d}` : "lb-score";
    }
  }
}

/** Where the row is DRAWN right now (design px), including any running animation. */
export function displayedY(el: Element): number {
  return new DOMMatrix(getComputedStyle(el).transform).m42;
}

function displayedScale(el: Element): { x: number; y: number } {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return { x: m.a || 1, y: m.d || 1 };
}

export function cancelRowAnims(row: Row): void {
  row.move?.cancel();
  row.lateral?.cancel();
  row.shellAnim?.cancel();
  row.scoreAnim?.cancel();
  row.gainAnim?.cancel();
  row.move = row.lateral = row.shellAnim = row.scoreAnim = row.gainAnim = null;
  row.gainSum = 0;
}

/** The counter alone reacts: compression → slight overshoot → back to shape. */
export function popScore(host: AnimHost, row: Row, m: LbMotion, reduced: boolean): void {
  const cur = displayedScale(row.score);
  row.scoreAnim?.cancel();
  const clear = (): void => {
    row.scoreAnim = null;
  };
  if (reduced) {
    row.scoreAnim = host.play(
      row.score,
      [{ backgroundColor: "#454554" }, { backgroundColor: "#121218" }],
      { duration: m.scoreMs },
      clear,
    );
    return;
  }
  const k = row.isLocal ? 1 : 0.4; // opponents: the same gesture, discreetly
  const mix = (v: number): number => 1 + (v - 1) * k;
  row.scoreAnim = host.play(
    row.score,
    [
      { transform: `scale(${cur.x}, ${cur.y})` },
      { transform: `scale(${mix(m.scoreSquash[0])}, ${mix(m.scoreSquash[1])})`, offset: 0.28, easing: "ease-out" },
      { transform: `scale(${mix(m.scoreOver[0])}, ${mix(m.scoreOver[1])})`, offset: 0.62, easing: "ease-out" },
      { transform: "scale(1, 1)" },
    ],
    { duration: m.scoreMs },
    clear,
  );
}

/** "+N" lives INSIDE the row: it follows the row wherever it goes. Rapid points add up. */
export function showGain(host: AnimHost, row: Row, delta: number, m: LbMotion): void {
  const el = row.gain;
  if (!el) return;
  const startOpacity = row.gainAnim ? Number(getComputedStyle(el).opacity) || 0 : 0;
  row.gainAnim?.cancel();
  row.gainSum += delta;
  el.textContent = `+${row.gainSum}`;
  const pop = m.bounce ? 1.08 : 1;
  row.gainAnim = host.play(
    el,
    [
      { opacity: startOpacity, transform: `translateY(${m.gainRise ? 5 : 0}px) scale(${m.bounce ? 0.8 : 1})` },
      { opacity: 1, transform: `translateY(-2px) scale(${pop})`, offset: 0.2, easing: "ease-out" },
      { opacity: 1, transform: `translateY(${-m.gainRise * 0.4}px) scale(1)`, offset: 0.68 },
      { opacity: 0, transform: `translateY(${-m.gainRise}px) scale(1)` },
    ],
    { duration: m.gainMs },
    () => {
      row.gainAnim = null;
      row.gainSum = 0;
    },
  );
}
