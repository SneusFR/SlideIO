import { weaponIconSvg, WeaponIconKey } from "./hudIcons";

/**
 * Toy-box HUD kit — shared building blocks for the "Bean Sticker Arcade" HUD.
 *
 *  - replayAnim(): restarts a one-shot CSS animation WITHOUT forcing a
 *    reflow, by swapping two identical keyframe classes (`name-a` ⇄ `name-b`).
 *  - Weapon PLATES: every weapon readout mounts ONE illustrated wooden plate
 *    in the bottom-right column (#weapon-slot). Anatomy:
 *
 *        (icon badge)  ╭ NAME ribbon ─────────────╮
 *        ◯ reload ring │  24 /32   ● ● ● ● ○ ○     │   ← ammo drawn as the
 *                      ╰──────────────────────────╯     weapon's own ammo
 *
 *    Only the equipped weapon's plate is visible (`is-visible`).
 *  - Ability CHIPS (spear rush…): a small round button with a key cap and a
 *    conic cooldown sweep, mounted next to the plate (#ability-slot).
 *  - aimTicker: the ONLY element near the crosshair — a tiny hint that shows
 *    up just when ammo is low / the weapon reloads, then disappears.
 *
 * Every setter is change-detected: callers may call them every frame.
 */

/** Restart a one-shot animation by alternating `name-a` / `name-b`. */
export function replayAnim(el: Element, name: string): void {
  const a = name + "-a";
  const b = name + "-b";
  if (el.classList.contains(a)) {
    el.classList.remove(a);
    el.classList.add(b);
  } else {
    el.classList.remove(b);
    el.classList.add(a);
  }
}

/** Visual state of a plate (drives colours / wobble / aim ticker). */
export type PlateState = "" | "low" | "reload" | "hot";

/** setRing() value for an indeterminate reload: a spinning dashed ring. */
export const RING_SPIN = 2;

// NOTE on one-shot animations: two replayAnim() names must NEVER target the
// same element (their persisting `x-a/x-b` classes would fight in the
// cascade). Each name below owns its own element:
//   enter → plate root · kick → .wpn-badge · refilled → .wpn-badge-face ·
//   stamp → .wpn-stamp (via root class) · tick → .wpn-count-value ·
//   pip → each ammo pip (CSS picks spent / refill keyframes from `.on`).

export class WeaponPlate {
  readonly root: HTMLDivElement;
  /** Container the weapon fills with its own ammo visual. */
  readonly ammo: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private readonly badgeFace: HTMLDivElement;
  private readonly stampEl: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly countEl: HTMLSpanElement;
  private readonly ring: HTMLDivElement;
  private readonly baseName: string;

  private visible = false;
  private lastName = "";
  private lastCount: string | null = null;
  private lastState: PlateState | null = null;
  private lastRing = -2;

  constructor(id: string, name: string, icon: WeaponIconKey, color: string, max: number | null) {
    this.baseName = name;
    this.root = document.createElement("div");
    this.root.id = id;
    this.root.className = "wpn-plate";
    this.root.style.setProperty("--wpn", color);
    this.root.innerHTML = `
      <div class="wpn-badge">
        <div class="wpn-ring"></div>
        <div class="wpn-badge-face">${weaponIconSvg(icon)}</div>
      </div>
      <div class="wpn-body">
        <div class="wpn-ribbon"><span class="wpn-name"></span></div>
        <div class="wpn-main">
          <div class="wpn-count"><span class="wpn-count-value"></span><span class="wpn-count-max"></span></div>
          <div class="wpn-ammo"></div>
        </div>
      </div>
      <div class="wpn-stamp">RELOAD!</div>`;
    this.badge = this.root.querySelector(".wpn-badge")!;
    this.badgeFace = this.root.querySelector(".wpn-badge-face")!;
    this.stampEl = this.root.querySelector(".wpn-stamp")!;
    this.nameEl = this.root.querySelector(".wpn-name")!;
    this.countEl = this.root.querySelector(".wpn-count-value")!;
    this.ring = this.root.querySelector(".wpn-ring")!;
    this.ammo = this.root.querySelector(".wpn-ammo")!;
    const maxEl = this.root.querySelector<HTMLSpanElement>(".wpn-count-max")!;
    maxEl.textContent = max !== null ? `/${max}` : "";
    this.setName(name);
    (document.getElementById("weapon-slot") ?? document.body).appendChild(this.root);
  }

  /** Show / hide the plate; the visible plate also owns the aim ticker. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle("is-visible", visible);
    if (visible) {
      replayAnim(this.root, "enter");
      aimTicker.claim(this);
      const s = this.lastState;
      this.lastState = null; // re-push the current state to the ticker
      if (s !== null) this.setState(s);
    } else {
      aimTicker.release(this);
    }
  }

  /** Ribbon text (defaults back to the weapon name when omitted). */
  setName(name: string = this.baseName): void {
    if (name === this.lastName) return;
    this.lastName = name;
    this.nameEl.textContent = name;
  }

  /** Big sticker number. A change makes it hop. */
  setCount(text: string): void {
    if (text === this.lastCount) return;
    const had = this.lastCount !== null;
    this.lastCount = text;
    this.countEl.textContent = text;
    if (had) replayAnim(this.countEl, "tick");
  }

  /** low / reload / hot styling (+ the aim ticker near the crosshair). */
  setState(state: PlateState): void {
    if (state === this.lastState) return;
    const prev = this.lastState;
    this.lastState = state;
    this.root.classList.toggle("low", state === "low");
    this.root.classList.toggle("reloading", state === "reload");
    this.root.classList.toggle("hot", state === "hot");
    if (prev !== null) {
      if (state === "reload" && prev !== "reload") this.stamp("RELOAD!");
      if (prev === "reload" && state !== "reload") replayAnim(this.badgeFace, "refilled");
    }
    aimTicker.set(this, state);
  }

  /** Slam a rubber stamp on the plate ("RELOAD!", "TOO HOT!"…). */
  stamp(text: string): void {
    if (this.stampEl.textContent !== text) this.stampEl.textContent = text;
    replayAnim(this.root, "stamp");
  }

  /**
   * Ring around the icon badge: 0..1 = determinate progress (reload /
   * cooldown), RING_SPIN = indeterminate spinning dashes, <0 = hidden.
   */
  setRing(progress: number): void {
    const v = progress < 0 ? -1 : progress > 1 ? 999 : Math.round(progress * 100);
    if (v === this.lastRing) return;
    this.lastRing = v;
    this.ring.style.setProperty("--p", String(Math.max(0, Math.min(100, v))));
    this.ring.classList.toggle("on", v >= 0);
    this.ring.classList.toggle("spin", v === 999);
  }

  /** Short recoil kick on the icon badge (call when a shot leaves). */
  kick(): void {
    replayAnim(this.badge, "kick");
  }
}

// ---------------------------------------------------------------------------
// AMMO VISUALS — each weapon draws its ammo as its own kind of object.
// ---------------------------------------------------------------------------

/**
 * A row of ammo "objects" (paint balls, popcorn puffs, frisbees, bullets…).
 * `cls` picks the CSS shape (`ammo-<cls>`); `colors` cycles per pip
 * (--pip); `groupEvery` adds a gap after each group (bursts); `inner` =
 * optional inner markup (SVG) for every pip.
 */
export function createPips(
  parent: HTMLElement,
  count: number,
  cls: string,
  colors: readonly string[] | null = null,
  groupEvery = 0,
  inner = "",
): HTMLSpanElement[] {
  const wrap = document.createElement("div");
  wrap.className = `ammo-pips ammo-${cls}`;
  const pips: HTMLSpanElement[] = [];
  for (let i = 0; i < count; i++) {
    const pip = document.createElement("span");
    pip.className = "ammo-pip on";
    if (inner) pip.innerHTML = inner;
    if (colors) pip.style.setProperty("--pip", colors[i % colors.length]);
    if (groupEvery > 0 && i % groupEvery === groupEvery - 1 && i < count - 1) {
      pip.classList.add("group-end");
    }
    wrap.appendChild(pip);
    pips.push(pip);
  }
  parent.appendChild(wrap);
  return pips;
}

/** Light / empty one pip — plays a "spent" pop or a "refill" bounce. */
export function setPip(pip: HTMLElement, on: boolean): void {
  if (pip.classList.contains("on") === on) return;
  pip.classList.toggle("on", on);
  replayAnim(pip, "pip"); // CSS: .on.pip-x = refill bounce, :not(.on).pip-x = spent pop
}

/** The first `loaded` pips are lit, the rest are empty. */
export function setPips(pips: readonly HTMLElement[], loaded: number): void {
  for (let i = 0; i < pips.length; i++) setPip(pips[i], i < loaded);
}

/**
 * A liquid gauge (water tank, poison flask, heat tube, music bar): a
 * rounded glass tube with a wavy liquid. Returns a change-detected setter
 * (0..1) that only writes a GPU-friendly scaleX transform.
 */
export function createGauge(parent: HTMLElement, cls: string): (ratio: number) => void {
  const tube = document.createElement("div");
  tube.className = `ammo-gauge gauge-${cls}`;
  tube.innerHTML =
    `<div class="gauge-liquid"></div><div class="gauge-wave"></div><div class="gauge-shine"></div>`;
  parent.appendChild(tube);
  const liquid = tube.firstElementChild as HTMLDivElement;
  let last = -1;
  return (ratio: number) => {
    const v = Math.round(Math.max(0, Math.min(1, ratio)) * 200) / 2; // 0.5 % steps
    if (v === last) return;
    last = v;
    liquid.style.transform = `scaleX(${v / 100})`;
    tube.style.setProperty("--level", `${v}%`);
  };
}

// ---------------------------------------------------------------------------
// AIM TICKER — the only info allowed near the crosshair, and only when it
// matters (LOW ammo / RELOADING). Owned by the visible plate.
// ---------------------------------------------------------------------------
class AimTicker {
  private owner: object | null = null;
  private el: HTMLElement | null = null;
  private lastState: PlateState | null = null;

  private ensure(): boolean {
    if (!this.el) this.el = document.getElementById("aim-ticker");
    return !!this.el;
  }

  claim(owner: object): void {
    this.owner = owner;
    this.apply("");
  }

  release(owner: object): void {
    if (owner !== this.owner) return;
    this.owner = null;
    this.apply("");
  }

  set(owner: object, state: PlateState): void {
    if (owner !== this.owner) return;
    this.apply(state);
  }

  private apply(state: PlateState): void {
    if (state === this.lastState || !this.ensure()) return;
    this.lastState = state;
    const el = this.el!;
    const show = state === "low" || state === "reload";
    el.classList.toggle("show", show);
    el.classList.toggle("low", state === "low");
    el.classList.toggle("reload", state === "reload");
    if (show) el.textContent = state === "reload" ? "RELOAD" : "LOW AMMO";
  }
}

export const aimTicker = new AimTicker();

// ---------------------------------------------------------------------------
// ABILITY CHIP — round button with key cap + conic cooldown sweep.
// ---------------------------------------------------------------------------
export class AbilityChip {
  readonly root: HTMLDivElement;
  private readonly timeEl: HTMLSpanElement;
  private lastP = -1;
  private lastText: string | null = null;
  private lastReady: boolean | null = null;
  private lastActive: boolean | null = null;
  private visible = false;

  constructor(id: string, label: string, keyCap: string, icon: WeaponIconKey, color: string) {
    this.root = document.createElement("div");
    this.root.id = id;
    this.root.className = "ability-chip";
    this.root.style.setProperty("--chip", color);
    this.root.innerHTML = `
      <div class="chip-disc">
        <div class="chip-sweep"></div>
        <div class="chip-face">${weaponIconSvg(icon)}</div>
        <span class="chip-time"></span>
      </div>
      <div class="chip-text"><span class="chip-key">${keyCap}</span><span class="chip-label">${label}</span></div>`;
    this.timeEl = this.root.querySelector(".chip-time")!;
    (document.getElementById("ability-slot") ?? document.body).appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle("is-visible", visible);
  }

  /** progress 0..1 of the cooldown refill; text = remaining time or "". */
  set(progress: number, text: string, ready: boolean, active: boolean): void {
    const p = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (p !== this.lastP) {
      this.lastP = p;
      this.root.style.setProperty("--p", String(p));
    }
    if (text !== this.lastText) {
      this.lastText = text;
      this.timeEl.textContent = text;
    }
    if (ready !== this.lastReady) {
      const wasCooling = this.lastReady === false;
      this.lastReady = ready;
      this.root.classList.toggle("ready", ready);
      if (ready && wasCooling) replayAnim(this.root, "ready");
    }
    if (active !== this.lastActive) {
      this.lastActive = active;
      this.root.classList.toggle("active", active);
    }
  }
}
