import { advance, freeze } from "./virtual-time";
import { CrosshairHUD, type CrosshairKick } from "../../src/ui/CrosshairHUD";
import { HitmarkerHUD } from "../../src/ui/HitmarkerHUD";
import { HitZone } from "../../src/combat/HitZone";
import { DEFAULT_CROSSHAIR, applyCrosshairSettings, type CrosshairSettings } from "../../src/ui/CrosshairSettings";

/**
 * Crosshair preview entry: the REAL CrosshairHUD + HitmarkerHUD + applyCrosshairSettings, driven
 * exactly like Game.ts drives them (fire on a real shot, setAiming on RMB, show() on a confirmed
 * hit). Time is virtual (virtual-time.ts) so every frame is deterministic. Exposed as window.ch.
 */
type Op =
  | { op: "aim"; on: boolean }
  | { op: "fire"; kick?: CrosshairKick }
  | { op: "hit"; zone?: "BODY" | "HEAD"; kill?: boolean; dur?: number };
interface Step {
  t: number;
  do: Op;
}
interface Scenario {
  note: string;
  steps: Step[];
  /** Total length to record (ms). */
  length: number;
}

const burst = (from: number, n: number, every: number, kick: CrosshairKick): Step[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + i * every, do: { op: "fire", kick } as Op }));

const scenarios: Record<string, Scenario> = {
  rest: { note: "repos (rien ne bouge)", length: 200, steps: [] },
  aim: {
    note: "entree puis sortie de visee (125 ms)",
    length: 700,
    steps: [{ t: 40, do: { op: "aim", on: true } }, { t: 400, do: { op: "aim", on: false } }],
  },
  shot: { note: "tir isole", length: 300, steps: [{ t: 20, do: { op: "fire", kick: "medium" } }] },
  burst: {
    note: "rafale 10 coups/s : pas d'empilement",
    length: 700,
    steps: burst(20, 7, 100, "light"),
  },
  aimshot: {
    note: "tir pendant la transition de visee",
    length: 400,
    steps: [{ t: 20, do: { op: "aim", on: true } }, { t: 60, do: { op: "fire", kick: "heavy" } }],
  },
  miss: { note: "tir rate : aucun marqueur d'impact", length: 300, steps: [{ t: 20, do: { op: "fire", kick: "heavy" } }] },
  hit: {
    note: "tir puis impact confirme 80 ms plus tard (corps)",
    length: 400,
    steps: [{ t: 20, do: { op: "fire", kick: "medium" } }, { t: 100, do: { op: "hit", zone: "BODY" } }],
  },
  head: {
    note: "impact tete",
    length: 400,
    steps: [{ t: 20, do: { op: "fire", kick: "heavy" } }, { t: 60, do: { op: "hit", zone: "HEAD" } }],
  },
  kill: {
    note: "elimination, puis touche tardive non letale a +90 ms (ne doit pas ecraser)",
    length: 500,
    steps: [
      { t: 20, do: { op: "fire", kick: "heavy" } },
      { t: 60, do: { op: "hit", zone: "BODY", kill: true } },
      { t: 150, do: { op: "hit", zone: "BODY" } },
    ],
  },
  tick: {
    note: "paintball : touches courtes en rafale",
    length: 500,
    steps: [
      ...burst(20, 4, 100, "light"),
      ...[60, 160, 260, 360].map((t) => ({ t, do: { op: "hit", zone: "BODY", dur: 0.09 } as Op })),
    ],
  },
};

const settings: CrosshairSettings = { ...DEFAULT_CROSSHAIR };
const crosshair = new CrosshairHUD();
const hitmarker = new HitmarkerHUD();
applyCrosshairSettings(settings);

const BACKGROUNDS: Record<string, string> = {
  dark: "linear-gradient(180deg,#1b1b24,#0b0b10)",
  mid: "linear-gradient(180deg,#6a3f8a 0%,#c07a9a 45%,#b98556 46%,#8a6038 100%)",
  light: "linear-gradient(90deg,#f6f1e4 0 50%,#e7f0ff 50% 100%)",
  bright: "radial-gradient(circle at 50% 50%,#fffbe0 0 30%,#ffe98a 70%,#ffd23f 100%)",
  busy: "repeating-conic-gradient(#fbf1da 0 12.5%,#3ee0c5 0 25%,#ff4fa8 0 37.5%,#1b1b24 0 50%)",
};

function apply(op: Op): void {
  if (op.op === "aim") crosshair.setAiming(op.on);
  else if (op.op === "fire") crosshair.fire(op.kick ?? "medium");
  else hitmarker.show(op.zone === "HEAD" ? HitZone.HEAD : HitZone.BODY, op.dur, op.kill === true);
  freeze(); // start the freshly created CSS animations / transitions at t = 0
}

const commit = (): void => applyCrosshairSettings(settings);

(window as unknown as { ch: unknown }).ch = {
  scenarios,
  backgrounds: Object.keys(BACKGROUNDS),
  apply,
  /** Advance the virtual clock by ms. */
  step(ms: number): void {
    advance(ms);
  },
  bg(name: string): void {
    document.body.style.background = BACKGROUNDS[name] ?? BACKGROUNDS.dark;
  },
  options(o: { contrast?: boolean; reduced?: boolean; scale?: number; shape?: CrosshairSettings["shape"]; color?: string }): void {
    if (o.contrast !== undefined) settings.highContrast = o.contrast;
    if (o.reduced !== undefined) settings.reducedMotion = o.reduced;
    if (o.scale !== undefined) settings.scale = o.scale;
    if (o.shape !== undefined) settings.shape = o.shape;
    if (o.color !== undefined) settings.color = o.color;
    commit();
  },
  /** Centre of the dot (proves the centre never moves). */
  probe(): { cx: number; cy: number; w: number; classes: string } {
    const el = document.getElementById("crosshair")!;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, classes: el.className };
  },
  /** Distance (px) of each tick's inner end from the centre + its length. */
  bars(): { inner: number[]; len: number[] } {
    const dot = document.getElementById("crosshair")!.getBoundingClientRect();
    const cx = dot.left + dot.width / 2;
    const cy = dot.top + dot.height / 2;
    const inner: number[] = [];
    const len: number[] = [];
    document.querySelectorAll(".cx-bar").forEach((b) => {
      const r = b.getBoundingClientRect();
      const pts = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
      inner.push(Math.min(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy))));
      len.push(Math.max(r.width, r.height));
    });
    return { inner, len };
  },
  /** State of the hitmarker (opacity 0 = fully faded). */
  hm(): { cls: string; opacity: number } {
    const root = document.getElementById("hitmarker")!;
    const arm = root.querySelector(".hm-arm") as HTMLElement;
    return { cls: root.className, opacity: Number(getComputedStyle(arm).opacity) };
  },
};