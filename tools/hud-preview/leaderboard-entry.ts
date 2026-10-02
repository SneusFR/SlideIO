import { advance, freeze } from "./virtual-time";
import { LeaderboardHUD } from "../../src/ui/LeaderboardHUD";
import { PlayerMatchStats, compareMatchStats } from "../../src/stats/MatchStatsManager";

/**
 * Leaderboard preview entry: the REAL LeaderboardHUD fed with the real ranking
 * comparator, exactly like Game.ts feeds it. Time is virtual (virtual-time.ts),
 * so every capture is deterministic. Exposed as window.lb.
 */
const ME = 99;
type Scores = Record<number, number>;
interface Step {
  t: number;
  scores: Scores;
}
interface Scenario {
  init: Scores;
  steps: Step[];
  note: string;
}

const BASE: Scores = { 11: 19, 13: 15, 14: 14, [ME]: 13, 12: 12 };
const one = (note: string, init: Scores, scores: Scores): Scenario => ({ note, init, steps: [{ t: 0, scores }] });

const scenarios: Record<string, Scenario> = {
  point: one("+1 without overtaking", { ...BASE, [ME]: 10 }, { ...BASE, [ME]: 11 }),
  single: one("simple overtake (4th -> 3rd)", BASE, { ...BASE, [ME]: 15 }),
  multi: one("several places gained (4th -> 2nd)", BASE, { ...BASE, [ME]: 17 }),
  lead: one("take the lead from 4th", BASE, { ...BASE, [ME]: 20 }),
  loss: one("lose one place (opponent passes me)", BASE, { ...BASE, 12: 14 }),
  lostlead: one("lose the lead", { ...BASE, [ME]: 20 }, { ...BASE, [ME]: 20, 11: 21 }),
  tie: one("tie: official order unchanged, only the counter reacts", BASE, { ...BASE, [ME]: 14 }),
  opponent: one("opponent update (discreet)", BASE, { ...BASE, 14: 16 }),
  newmatch: one("new match: instant rebuild", BASE, { 11: 0, 13: 0, 14: 0, [ME]: 0, 12: 0 }),
  long: one("long names + multi-digit scores", { 11: 1234, 13: 87, 14: 12345, [ME]: 9, 12: 100 }, { 11: 1234, 13: 87, 14: 12345, [ME]: 99, 12: 100 }),
  rapid: {
    note: "+1 x4 every 90 ms, then an opponent moves mid-slide",
    init: BASE,
    steps: [
      { t: 0, scores: { ...BASE, [ME]: 14 } },
      { t: 90, scores: { ...BASE, [ME]: 15 } },
      { t: 180, scores: { ...BASE, [ME]: 16 } },
      { t: 270, scores: { ...BASE, [ME]: 17 } },
      { t: 330, scores: { ...BASE, [ME]: 17, 12: 18 } },
    ],
  },
  interrupt: {
    note: "an opponent passes me while my own slide is running",
    init: BASE,
    steps: [
      { t: 0, scores: { ...BASE, [ME]: 17 } },
      { t: 160, scores: { ...BASE, [ME]: 17, 12: 18 } },
    ],
  },
  joinleave: {
    note: "BOT 1 disconnects, then BOT 5 joins",
    init: BASE,
    steps: [
      { t: 0, scores: { 13: 15, 14: 14, [ME]: 13, 12: 12 } },
      { t: 500, scores: { 13: 15, 14: 14, [ME]: 13, 12: 12, 15: 0 } },
    ],
  },
};

const hud = new LeaderboardHUD();
const NAMES: Record<number, string> = { 11: "BOT 1", 12: "BOT 2", 13: "BOT 3", 14: "BOT 4", 15: "BOT 5", [ME]: "VALENTIN" };
const LONG: Record<number, string> = { 11: "ALEXANDRE-LE-GRAND", 12: "BOT 2", 13: "XXXXXXXXXXXXXXXXXXXX", 14: "MARIE-ANTOINETTE II", [ME]: "VALENTIN" };
let longNames = false;

function toStats(scores: Scores): PlayerMatchStats[] {
  return Object.entries(scores)
    .map(([id, kills]) => ({
      combatantId: Number(id),
      displayName: (longNames ? LONG : NAMES)[Number(id)] ?? `BOT ${id}`,
      isLocalPlayer: Number(id) === ME,
      kills,
      deaths: 0,
      assists: 0,
    }))
    .sort(compareMatchStats);
}

/** Paused (virtual-time) animations never finish by themselves: finish the ones that reached their end. */
const started = new Set<Animation>();
const nativeAnimate = Element.prototype.animate;
Element.prototype.animate = function (this: Element, kf: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions): Animation {
  const a = nativeAnimate.call(this, kf, o);
  started.add(a);
  return a;
};

function settleFinished(): void {
  // A paused animation past its end with fill:none leaves document.getAnimations(), so track our own set.
  for (const a of [...started]) {
    if (a.playState === "finished" || a.playState === "idle") {
      started.delete(a);
      continue;
    }
    const end = a.effect?.getComputedTiming().endTime;
    if (a.playState !== "paused" || typeof end !== "number" || !Number.isFinite(end) || Number(a.currentTime) < end - 0.01) continue;
    // A paused animation never dispatches "finish": hand it a start time that puts it exactly at its end.
    a.finish();
    started.delete(a);
  }
}

(window as unknown as { __host: unknown }).__host = () => (hud as unknown as { host: unknown }).host;
const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;

(window as unknown as { lb: unknown }).lb = {
  ids: Object.keys(scenarios),
  scenarios,
  /** Feed a snapshot exactly like Game.ts does (sorted by the official comparator). */
  apply(scores: Scores): void {
    hud.refresh(toStats(scores));
    freeze();
  },
  step(ms: number): void {
    let left = ms;
    while (left > 1e-6) {
      const d = Math.min(left, 1000 / 60);
      advance(d);
      settleFinished();
      left -= d;
    }
  },
  setReduced: (v: boolean | null) => hud.setReducedMotion(v),
  setSlow: (n: number) => hud.setTimeScale(n),
  setLongNames: (v: boolean) => {
    longNames = v;
  },
  pending: () => hud.pending,
  animations: () => document.getAnimations().length,
  crowns: () => document.querySelectorAll(".lb-crown").length,
  /** Running particle animations (the 8 pooled dots always exist in the DOM). */
  particles: () =>
    document.getAnimations().filter((a) => ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.classList?.contains("lb-p")).length,
  /** Geometry of the rows in DOM order (CSS px). */
  rows(): unknown[] {
    return [...document.querySelectorAll<HTMLElement>("#lb-list .lb-row")].map((el) => {
      const r = el.getBoundingClientRect();
      const sc = el.querySelector<HTMLElement>(".lb-score")!.getBoundingClientRect();
      const bd = el.querySelector<HTMLElement>(".lb-badge")!.getBoundingClientRect();
      const nm = el.querySelector<HTMLElement>(".lb-name")!;
      return {
        rank: el.querySelector(".lb-badge")!.textContent,
        name: el.querySelector(".lb-name-text")!.textContent,
        score: el.querySelector(".lb-score-val")!.textContent,
        x: r.x, y: r.y, w: r.width, h: r.height,
        scoreX: sc.x, scoreW: sc.width, badgeX: bd.x,
        nameOverflow: nm.scrollWidth > nm.clientWidth + 1,
        crown: !!el.querySelector(".lb-crown"),
        opacity: getComputedStyle(el).opacity,
      };
    }).sort((p, q2) => p.y - q2.y);
  },
  /** Debug: what the HUD still tracks (its AnimHost set + fading rows). */
  tracked(): unknown {
    const h = hud as unknown as { host: { live: Set<Animation> }; leaving: Set<HTMLElement> };
    return {
      live: [...h.host.live].map((a) => `${((a.effect as KeyframeEffect).target as HTMLElement).className} ${a.playState} ${Math.round(Number(a.currentTime))}`),
      leaving: h.leaving.size,
    };
  },
  /** Debug: what is still animating. */
  live(): unknown[] {
    return document.getAnimations().map((a) => {
      const t = a.effect as KeyframeEffect | null;
      const el = t?.target as HTMLElement | null;
      return `${el?.className || el?.tagName} ${a.playState} t=${Math.round(Number(a.currentTime))} end=${Math.round(Number(t?.getComputedTiming().endTime))}`;
    });
  },
  box(): { x: number; y: number; w: number; h: number } {
    const r = q("#leaderboard-hud").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  },
  /** Fresh board (instant rebuild) at the given scores. */
  load(init: Scores): void {
    hud.refresh(toStats(init));
    freeze();
  },
  dispose(): void {
    hud.dispose();
  },
};
(window as unknown as { lb: { load: (s: Scores) => void } }).lb.load(BASE);
