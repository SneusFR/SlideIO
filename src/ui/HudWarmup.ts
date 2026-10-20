import { MedalStyles } from "../medals/MedalConfig";
import { MedalType } from "../medals/MedalType";
import { hudFeed } from "./HudFeed";
import { MEDAL_ACCENT_PARTS } from "./MedalHUD";

/** A HUD part with STATE (leaderboard…) warmed through its own API. */
export interface HudWarmupHook {
  /** Put the part in its rare states (called once the DOM states are set). */
  show(): void;
  /** Back to its exact initial state (always called, even on failure). */
  hide(): void;
}

/**
 * LOAD-TIME HUD WARM-UP — the HUD states of the match (kill medal, BEANED!
 * sticker, combo tag, killstreak capsules, hitmarker, damage numbers,
 * damage / low-HP / heal vignettes, bean faces, death screen…) are drawn
 * while the loading screen is still up: under it, at full opacity, the
 * loading screen letting 0.4 % of them through (invisible — at most one
 * level out of 255 on a pixel; style.css, html.hud-warm).
 *
 * Why: the FIRST time the browser draws a new kind of effect (gradients
 * behind a mask or a rounded clip, blurred shadows, stroked text, SVG
 * filters) its GPU rasterizer compiles new shaders (D3D11 on Windows: tens
 * of ms each) — on the first kill that landed as 40-175 ms frames without
 * any game-code cost. Paid here, during the loading, instead.
 *
 * Those shaders depend on HOW an element is drawn, not only on what it is:
 * mid-animation (in a compositing layer of its own, turned or scaled) or at
 * rest (axis-aligned, in the HUD's layer, under its parents' rounded
 * clips), alone or under a filter (the grey "dead" bean wraps the whole
 * portrait), partly filled (a bar's scaleX). So the warm-up replays real
 * situations one after the other — the plain first kill, a fight, the rare
 * looks, death — each with the exact classes / fills the game sets, and
 * every animation they start is drawn running and paused at several points
 * of its timeline, then at rest, then through its exit (medal leaving,
 * sticker leaving, combo tag falling). Each of those states is held until
 * the browser has really drawn it (holdUntilDrawn): ~2 s in all at
 * 60 Hz, a little more on a first launch (the shaders compile then).
 * Where the browser compiles WebGL shaders in parallel, the whole pass runs
 * DURING the GPU warm-up's shader compile (Game.warmUpRendering, step 3a)
 * instead of after it — `gpuBusy`: the budget below only starts counting
 * once that compile is over.
 *
 * Pure DOM, no game state: every class / text / inline style touched here is
 * recorded and restored exactly (the HUD classes never notice). Parts with a
 * state of their own (the leaderboard) come as `hooks` (replayed with the
 * first kill).
 */
export async function warmUpHud(
  hooks: readonly HudWarmupHook[] = [],
  gpuBusy: Promise<unknown> | null = null,
): Promise<void> {
  if (document.hidden) return; // no frames would come: nothing to warm
  const root = new DomPatch();
  try {
    hudFeed(); // the 3 pooled stickers exist from now on
    await measureDisplayFrames();
    holdDeadline = performance.now() + WARM_BUDGET_MS;
    // Run alongside the GPU warm-up's shader compiles (Game.warmUpRendering):
    // while they share the machine, states may need longer to be drawn —
    // the budget only starts counting once they are done.
    void gpuBusy?.then(() => {
      holdDeadline = Math.max(holdDeadline, performance.now() + WARM_BUDGET_MS);
    });
    root.add(document.documentElement, "hud-warm");
    await warmPass(killLook, killExit, hooks, true);
    await warmPass(hurtLook, hurtExit, [], false);
    await warmPass(rareLooks, killExit, [], false);
    await warmPass(deadLook, null, [], false);
  } finally {
    root.restore();
  }
}

/** Animations a pass played / paused (with their state when first touched). */
type Touched = Map<Animation, { time: CSSNumberish | null; running: boolean }>;

/**
 * One situation: its DOM states (+ hooks), every animation they start drawn
 * running then paused at several points, then at rest, then the exit
 * states the same way; everything restored at the end. `full` = more points
 * (the plain kill: the most frequent states of the match).
 */
async function warmPass(
  enter: (p: DomPatch) => void,
  exit: ((p: DomPatch) => void) | null,
  hooks: readonly HudWarmupHook[],
  full: boolean,
): Promise<void> {
  const patch = new DomPatch();
  const shown: HudWarmupHook[] = [];
  const touched: Touched = new Map();
  // Animations left alone by the stepping: the HUD's own idle loops (already
  // drawn every frame), then the entry animations once settled.
  const skip = new Set(typeof document.getAnimations === "function" ? document.getAnimations() : []);
  try {
    enter(patch);
    for (const hook of hooks) {
      shown.push(hook);
      hook.show();
    }
    await holdUntilDrawn();
    // Early on, at the overshoot, at the end: RUNNING (an animated element
    // is drawn in a compositing layer of its own), then PAUSED (drawn into
    // the HUD's layer, under its parents' clips)…
    await stepAnimations(full ? [0.25, 0.6, 1] : [0.3, 1], touched, skip, true);
    await stepAnimations(full ? [1, 0.55, 0.25] : [1, 0.4], touched, skip, false);
    // …then at REST, animations over: back axis-aligned at scale 1, an
    // element draws with other GPU shaders than the same element turned or
    // scaled by an animation.
    await settleAnimations(touched, skip);
    if (exit) {
      exit(patch);
      await holdUntilDrawn();
      await stepAnimations(full ? [0.35, 0.75] : [0.5], touched, skip, true);
      await stepAnimations(full ? [0.75, 0.35] : [0.5], touched, skip, false);
      await settleAnimations(touched, skip);
    }
  } finally {
    for (let i = shown.length - 1; i >= 0; i--) {
      try {
        shown[i].hide();
      } catch (err) {
        console.error("[hud warm-up]", err);
      }
    }
    patch.restore();
    endTouchedAnimations(touched);
  }
}

/**
 * After a pass: every CSS animation it played / paused is cancelled unless
 * its rule still applies to a rendered element. A CSS animation driven by
 * script outlives the class that started it — without this, the panicking
 * bean kept trembling, its rays spinning and the HP number throbbing at
 * full health for the whole match (and a hidden medal kept stale ones for
 * its next pop). The ones whose rule applies again (the dash chevrons, back
 * to READY) run on; Web Animations (leaderboard) are reset by their hook.
 */
function endTouchedAnimations(touched: Touched): void {
  for (const anim of touched.keys()) {
    const name = (anim as Animation & { animationName?: unknown }).animationName;
    if (typeof name !== "string") continue; // a Web Animation or a CSS transition
    try {
      const effect = anim.effect as KeyframeEffect | null;
      const target = effect?.target;
      const applies =
        !!target &&
        target.getClientRects().length > 0 &&
        getComputedStyle(target, effect.pseudoElement)
          .animationName.split(",")
          .some((n) => n.trim() === name);
      if (!applies) anim.cancel();
    } catch {
      /* element gone */
    }
  }
}

/**
 * The FIRST KILL exactly as the game shows it (and every later plain kill):
 * the KILL medal (one star, its own colour, no hype), one BEANED! sticker,
 * the combo tag at x1 swinging in, the bean's victory hop, the KILL
 * hitmarker, a body-shot kill number, the fire kick (+ the leaderboard climb,
 * through its hook).
 */
function killLook(p: DomPatch): void {
  const kill = MedalStyles[MedalType.KILL];
  const medal = byId("medal-display");
  p.remove(medal, "hidden");
  p.add(medal, `stars-${kill.stars}`);
  medalAccent(p, medal, kill.color);
  p.add(medal?.querySelector(".md-body"), "pop-a");
  p.add(medal?.querySelector(`.md-icon[data-medal="${MedalType.KILL}"]`), "on");
  p.text(medal?.querySelector(".md-label"), kill.label);

  const sticker = document.querySelector("#event-feed .feed-sticker");
  p.add(sticker, "show", "feed-kill", "in-a");
  p.text(sticker?.querySelector(".feed-title"), "BEANED!");
  p.text(sticker?.querySelector(".feed-sub"), "");

  p.add(byId("combo-hud"), "show");
  p.add(byId("combo-tag"), "swing-a");
  p.text(byId("combo-count"), "x1");
  p.style(byId("combo-fill"), "transform", "scaleX(0.6)"); // the rope burning down

  p.add(byId("bean-buddy"), "cheer-a");
  p.add(byId("hitmarker"), "hm-kill");
  p.add(byId("crosshair"), "cx-firing");
  damageNumber(p, "dmg-num dmg-kill", 44);
}

/**
 * EXIT states, same classes as the real exits: the medal leaving, the
 * stickers leaving, the combo tag falling (ComboHUD: "show" → "drop"; a
 * swinging tag would win over the fall).
 */
function killExit(p: DomPatch): void {
  p.add(byId("medal-display"), "exiting");
  document.querySelectorAll("#event-feed .feed-sticker.show").forEach((el) => p.add(el, "leaving"));
  const combo = byId("combo-hud");
  p.remove(combo, "show");
  p.add(combo, "drop");
  p.remove(byId("combo-tag"), "swing-a", "swing-b");
}

/**
 * A FIGHT: the bean grimaces and squashes, the HP tube shakes half empty
 * (mid band, the lost chunk held by the ghost bar), the damage bite +
 * damage / low-HP vignettes, LOW AMMO under the aim point, a dash and its
 * cooldown (the pill refilling).
 */
function hurtLook(p: DomPatch): void {
  const buddy = byId("bean-buddy");
  p.remove(buddy, "mood-happy");
  p.add(buddy, "mood-worried", "ouch");
  p.add(byId("buddy-portrait"), "hurt-a");
  hpTube(p, "mid", 0.45, 0.7, "45");
  p.add(byId("health-hud"), "hurt-a");
  p.add(byId("health-value"), "bump-a");
  const dash = byId("dash-hud");
  p.remove(dash, "ready");
  p.add(dash, "dashing");
  p.style(byId("dash-fill"), "transform", "scaleX(0.4)");
  p.text(byId("dash-status"), "1.2");
  for (const id of ["damage-vignette", "lowhp-vignette"]) p.style(byId(id), "opacity", "1");
  p.style(document.querySelector<HTMLElement>("#damage-dir-container .damage-dir"), "opacity", "1");
  const ticker = byId("aim-ticker");
  p.add(ticker, "show", "low");
  p.text(ticker, "LOW AMMO");
}

/** The grimace ends (the worried face), the dash is back (its pop). */
function hurtExit(p: DomPatch): void {
  p.remove(byId("bean-buddy"), "ouch");
  const dash = byId("dash-hud");
  p.remove(dash, "dashing");
  p.add(dash, "ready", "recharged-a");
  p.style(byId("dash-fill"), "transform", "scaleX(1)");
  p.text(byId("dash-status"), "READY");
}

/** The HP tube at `fill` (band class, ghost bar holding `ghost`, number). */
function hpTube(p: DomPatch, band: "mid" | "low", fill: number, ghost: number, value: string): void {
  const hud = byId("health-hud");
  p.remove(hud, "full", "ok", "mid", "low");
  p.add(hud, band);
  p.style(byId("health-fill"), "transform", `scaleX(${fill})`);
  p.style(byId("health-ghost"), "transform", `scaleX(${ghost})`);
  p.text(byId("health-value"), value);
}

/**
 * The RARE looks, all at once: the hype medal (three stars, every art), the
 * three sticker flavours, the hottest combo with its blinking rope, READY
 * killstreak capsules, the panicking bean on a throbbing low-HP tube, a heal
 * (flash, "+N", sparkles), the phase glow, the knockdown banner, a headshot
 * kill number.
 */
function rareLooks(p: DomPatch): void {
  const triple = MedalStyles[MedalType.TRIPLE_KILL];
  const medal = byId("medal-display");
  p.remove(medal, "hidden");
  p.add(medal, "stars-3", "hype");
  medalAccent(p, medal, triple.color);
  p.add(medal?.querySelector(".md-body"), "pop-a");
  medal?.querySelectorAll(".md-icon").forEach((el) => p.add(el, "on"));
  p.text(medal?.querySelector(".md-label"), triple.label);

  const feed: [string, string, string][] = [
    ["kill", "BEANED!", ""],
    ["streak", "MOLE STRIKE READY", "[W]"],
    ["heal", "+35 HP", ""],
  ];
  document.querySelectorAll("#event-feed .feed-sticker").forEach((el, i) => {
    const [kind, title, sub] = feed[i % feed.length];
    p.add(el, "show", `feed-${kind}`, "in-a");
    p.text(el.querySelector(".feed-title"), title);
    p.text(el.querySelector(".feed-sub"), sub);
  });

  p.add(byId("combo-hud"), "show", "tier-3", "ending");
  p.add(byId("combo-tag"), "swing-a");
  p.text(byId("combo-count"), "x3");
  p.style(byId("combo-fill"), "transform", "scaleX(0.15)");

  const ks = byId("killstreak-hud");
  p.remove(ks, "hidden");
  ks?.querySelectorAll(".ks-cap").forEach((cap) => {
    p.add(cap, "on", "ready", "pulse-a");
    const count = cap.querySelector(".ks-count");
    if (count && !count.textContent) p.text(count, "3/3");
    const key = cap.querySelector(".ks-key");
    if (key && !key.textContent) p.text(key, "W");
  });

  const buddy = byId("bean-buddy");
  p.remove(buddy, "mood-happy");
  p.add(buddy, "mood-panic");
  hpTube(p, "low", 0.2, 0.35, "20");
  p.add(buddy?.querySelector(".buddy-frame"), "heal-a");
  p.style(byId("heal-flash"), "opacity", "1");
  p.remove(byId("heal-feedback"), "hidden");
  p.style(byId("phase-overlay"), "opacity", "1");
  p.remove(byId("knockdown-hint"), "hidden");
  damageNumber(p, "dmg-num dmg-head dmg-kill", 56);
  damageNumber(p, "dmg-num", 32);
}

/** DEATH: the death card, the grey slumped bean. */
function deadLook(p: DomPatch): void {
  p.remove(byId("death-screen"), "hidden");
  p.add(byId("hud"), "player-dead");
  const buddy = byId("bean-buddy");
  p.remove(buddy, "mood-happy");
  p.add(buddy, "mood-dead");
}

/** The medal's accent colour, written where MedalHUD.show writes it. */
function medalAccent(p: DomPatch, medal: HTMLElement | null, color: string): void {
  medal?.querySelectorAll<HTMLElement | SVGElement>(MEDAL_ACCENT_PARTS).forEach((el) => p.style(el, "--md", color));
}

/** A temporary damage number (removed by the patch). */
function damageNumber(p: DomPatch, cls: string, xVw: number): void {
  const numbers = byId("damage-numbers");
  if (!numbers) return;
  const el = document.createElement("div");
  el.className = cls;
  el.style.display = "block";
  el.style.transform = `translate(${xVw}vw, 40vh)`;
  const inner = document.createElement("span");
  inner.className = "dmg-num-inner dmg-pop";
  inner.textContent = "100";
  el.appendChild(inner);
  p.append(numbers, el);
}

/** True for an element of the warmed HUD (the game HUD, hitmarker, damage numbers). */
function inWarmedHud(target: Element | null | undefined): boolean {
  return !!target?.closest("#hud, #hitmarker, #damage-numbers");
}

/**
 * Every animation of the warmed HUD set at `p` × its duration (first
 * iteration, after its delay), one progress point after the other:
 * `running` → it plays on from there (the compositor takes it over),
 * otherwise → it is paused there. Each point is held until drawn.
 */
async function stepAnimations(
  points: readonly number[],
  touched: Touched,
  skip: ReadonlySet<Animation>,
  running: boolean,
): Promise<void> {
  if (typeof document.getAnimations !== "function") return;
  for (const p of points) {
    for (const anim of document.getAnimations()) {
      if (skip.has(anim)) continue;
      const effect = anim.effect as KeyframeEffect | null;
      if (!effect || !inWarmedHud(effect.target)) continue;
      const timing = effect.getComputedTiming();
      const duration = typeof timing.duration === "number" ? timing.duration : 0;
      if (!(duration > 0)) continue;
      if (!touched.has(anim)) touched.set(anim, { time: anim.currentTime, running: anim.playState === "running" });
      try {
        anim.currentTime = (timing.delay ?? 0) + duration * Math.min(p, 0.999);
        if (running) anim.play();
        else anim.pause();
      } catch {
        /* cancelled meanwhile */
      }
    }
    await holdUntilDrawn();
  }
}

/**
 * The end of every animation touched by stepAnimations (finite ones are
 * finished, endless ones play on), those states at rest held until drawn.
 * They are left alone from then on (`skip`).
 */
async function settleAnimations(touched: Touched, skip: Set<Animation>): Promise<void> {
  for (const anim of touched.keys()) {
    if (skip.has(anim)) continue;
    skip.add(anim);
    try {
      const end = anim.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) anim.finish();
      else anim.play();
    } catch {
      /* cancelled meanwhile */
    }
  }
  await holdUntilDrawn();
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** Frame interval of this display (ms) — see measureDisplayFrames. */
let frameMs = 1000 / 60;
/**
 * Past this point (a very slow machine: every frame late), the remaining
 * states are only held a frame each — the loading screen never waits more.
 */
const WARM_BUDGET_MS = 8000;
let holdDeadline = Infinity;

let frameMeasure: Promise<void> | null = null;

/**
 * The display's frame interval, measured ONCE. main.ts starts it with the
 * boot, while the loading screen mostly waits on downloads; warmUpHud and
 * the GPU warm-up wait for it. Measured later — during the shader compile
 * the HUD warm-up runs alongside (Game.warmUpRendering, step 3a), whose
 * polling delays some frames — it could read 2× too long at 240 Hz, and
 * every "on time" test of holdUntilDrawn would then pass too easily.
 */
export function measureDisplayFrames(): Promise<void> {
  frameMeasure ??= measureFrameInterval();
  return frameMeasure;
}

/**
 * The display's interval (60 Hz → 16.7 ms, 240 Hz → 4.2 ms): the second
 * shortest of a dozen frame gaps. A frame comes late when the thread is busy
 * (a multiple of the interval), never early: the shortest gaps are the
 * display's own — the second one ignores a lone outlier.
 */
function measureFrameInterval(): Promise<void> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
      if (gaps.length >= 2) frameMs = Math.min(50, Math.max(4, gaps[1]));
      resolve();
    };
    // Hidden tab (no frames) or a thread busy for 2 s: the 60 Hz default.
    const timer = window.setTimeout(finish, 2000);
    const step = (now: number): void => {
      if (done) return;
      stamps.push(now);
      if (stamps.length < 13) {
        requestAnimationFrame(step);
        return;
      }
      window.clearTimeout(timer);
      finish();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Keeps the current HUD state on screen until the browser has really drawn
 * it. The GPU work of a new state (raster, shader compiles) runs after the
 * frame that shows it, and while the GPU process is busy the next frames
 * come late — so the state stays until two frames in a row come on time
 * again: at least 3 frames, at most `maxMs`. Changing it after 1-2 frames
 * (the 3rd-pass warm-up) cancelled most of that work before it ran: the
 * shaders were then compiled at the first kill anyway.
 */
function holdUntilDrawn(maxMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    maxMs = Math.min(maxMs, Math.max(0, holdDeadline - start));
    let last = -1;
    let count = 0;
    let onTime = 0;
    const timer = window.setTimeout(resolve, maxMs + 100);
    const step = (now: number): void => {
      if (last >= 0) onTime = now - last <= frameMs * 1.6 ? onTime + 1 : 0;
      last = now;
      count++;
      if ((count >= 3 && onTime >= 2) || performance.now() - start >= maxMs) {
        window.clearTimeout(timer);
        resolve();
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** DOM edits recorded with their exact undo, restored in reverse order. */
class DomPatch {
  private readonly undo: (() => void)[] = [];

  add(el: Element | null | undefined, ...names: string[]): void {
    if (!el) return;
    for (const name of names) {
      if (el.classList.contains(name)) continue;
      el.classList.add(name);
      this.undo.push(() => el.classList.remove(name));
    }
  }

  remove(el: Element | null | undefined, ...names: string[]): void {
    if (!el) return;
    for (const name of names) {
      if (!el.classList.contains(name)) continue;
      el.classList.remove(name);
      this.undo.push(() => el.classList.add(name));
    }
  }

  style(el: HTMLElement | SVGElement | null | undefined, prop: string, value: string): void {
    if (!el) return;
    const prev = el.style.getPropertyValue(prop);
    const priority = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value);
    this.undo.push(() => {
      if (prev) el.style.setProperty(prop, prev, priority);
      else el.style.removeProperty(prop);
    });
  }

  text(el: Element | null | undefined, text: string): void {
    if (!el) return;
    const prev = el.textContent ?? "";
    if (prev === text) return;
    el.textContent = text;
    this.undo.push(() => {
      el.textContent = prev;
    });
  }

  append(parent: Element, child: Element): void {
    parent.appendChild(child);
    this.undo.push(() => child.remove());
  }

  restore(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]();
    this.undo.length = 0;
  }
}
