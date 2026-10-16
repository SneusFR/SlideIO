/**
 * MATCH INTRO — layout + timeline (PURE functions, no Three.js / DOM).
 *
 * Everything the intro shows at time `t` is a deterministic function of
 * (t, player count, aspect): blade polygons, character framing, tag
 * placement, flashes, shakes… The renderer and the DOM overlay only read
 * the `IntroFrame` produced here, which makes the cinematic scrubbable
 * (preview `?t=5.2`) and trivially testable.
 *
 * Coordinates are NORMALIZED screen units: x 0 → 1 left → right,
 * y 0 → 1 top → bottom. Outer edges overscan the screen (E) so the ink
 * outline only shows on the inner cuts.
 *
 * Final tableau ("versus arcade"):
 *   ┌──────────────┬╲─────╲─────╲─────╲
 *   │              │ ╲ P2  ╲ P3  ╲ P4  ╲   challengers fill the right part,
 *   │     MVP      ▷  ──────────────────   one by one, in chevron-cut
 *   │  (best one)  │ ╱ P5  ╱ P6  ╱ P7  ╱   blades pointing at the champion
 *   └──────────────┴╱─────╱─────╱─────╱
 */

export type Vec2 = [number, number];
/** 6 vertices (x, y) — fixed count so every shape can morph into any other. */
export type Poly = number[];

const E = 0.06; // overscan beyond the screen edges

// ---------------------------------------------------------------- easing
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);
export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(t)));
export const easeOutBack = (t: number, k = 1.9): number => {
  const x = clamp01(t) - 1;
  return 1 + (k + 1) * x * x * x + k * x * x;
};
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** 0 → 1 → 0 pulse over [a, b] (fast attack, smooth decay). */
const pulse = (t: number, a: number, b: number): number => {
  if (t < a || t > b) return 0;
  const x = (t - a) / (b - a);
  return x < 0.15 ? x / 0.15 : Math.pow(1 - (x - 0.15) / 0.85, 2);
};

export function lerpPoly(a: Poly, b: Poly, t: number): Poly {
  const out = new Array<number>(12);
  for (let i = 0; i < 12; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export function polyCentroid(p: Poly): Vec2 {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 6; i++) {
    x += p[i * 2];
    y += p[i * 2 + 1];
  }
  return [x / 6, y / 6];
}

export function polyBounds(p: Poly): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 6; i++) {
    x0 = Math.min(x0, p[i * 2]);
    x1 = Math.max(x1, p[i * 2]);
    y0 = Math.min(y0, p[i * 2 + 1]);
    y1 = Math.max(y1, p[i * 2 + 1]);
  }
  return { x0, y0, x1, y1 };
}

/** Horizontal extent [xl, xr] of a polygon on the horizontal line y. */
export function polySpanAt(p: Poly, y: number): [number, number] {
  let xl = Infinity;
  let xr = -Infinity;
  for (let i = 0; i < 6; i++) {
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const j = (i + 1) % 6;
    const bx = p[j * 2];
    const by = p[j * 2 + 1];
    if ((ay - y) * (by - y) > 0 || ay === by) continue;
    const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
    xl = Math.min(xl, x);
    xr = Math.max(xr, x);
  }
  if (!Number.isFinite(xl)) {
    const c = polyCentroid(p);
    return [c[0], c[0]];
  }
  return [xl, xr];
}

/** Even-odd point-in-polygon test (works on the concave chevron blades). */
export function pointInPoly(p: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = 5; i < 6; j = i++) {
    const xi = p[i * 2];
    const yi = p[i * 2 + 1];
    const xj = p[j * 2];
    const yj = p[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- layout
export interface SlotLayout {
  /** Final blade polygon. */
  poly: Poly;
  /** Where the character's chest lands (normalized screen). */
  focus: Vec2;
  /** Meters of character framed over the blade bounding-box height. */
  frameH: number;
  /** Camera look-at height on the character (m): portrait vs full body. */
  lookY: number;
  /** Name tag anchor (center of the tag) and the y used to fit its width. */
  tag: Vec2;
  /** Row of the slot: 0 single row, 1 top, 2 bottom, -1 MVP. */
  row: number;
}

export interface IntroLayout {
  aspect: number;
  count: number;
  mvp: SlotLayout;
  /** Challenger slots, in presentation order (weakest first). */
  slots: SlotLayout[];
  /** Tip of the chevron between the MVP and the challengers (VS stamp). */
  vsAt: Vec2;
  fullScreen: Poly;
}

/** Chevron cut ">" with its tip at x = c (y = 0.5). */
function chevronX(c: number, y: number, s: number): number {
  return c - s * Math.abs(2 * y - 1);
}

function rectPoly(x0: number, y0: number, x1: number, y1: number): Poly {
  const ym = (y0 + y1) / 2;
  return [x0, y0, x1, y0, x1, ym, x1, y1, x0, y1, x0, ym];
}

/**
 * Blade between two chevron lines (tips a < b), full height. The last blade
 * of a row (`b` = null) bleeds off the right edge with a straight cut.
 */
function chevronBlade(a: number, b: number | null, s: number): Poly {
  const R = 1 + E;
  return [
    chevronX(a, -E, s), -E,
    b === null ? R : chevronX(b, -E, s), -E,
    b === null ? R : b, 0.5,
    b === null ? R : chevronX(b, 1 + E, s), 1 + E,
    chevronX(a, 1 + E, s), 1 + E,
    a, 0.5,
  ];
}

/** Half-height tile between two chevron lines, over rows [y0, y1] (`b` = null: bleeds off the right edge). */
function chevronTile(a: number, b: number | null, y0: number, y1: number, s: number): Poly {
  const ym = (y0 + y1) / 2;
  const R = 1 + E;
  return [
    chevronX(a, y0, s), y0,
    b === null ? R : chevronX(b, y0, s), y0,
    b === null ? R : chevronX(b, ym, s), ym,
    b === null ? R : chevronX(b, y1, s), y1,
    chevronX(a, y1, s), y1,
    chevronX(a, ym, s), ym,
  ];
}

export function computeLayout(count: number, aspect: number): IntroLayout {
  const n = Math.max(1, Math.min(8, Math.floor(count)));
  const c = n - 1;
  // Constant PIXEL slant / gutters whatever the aspect ratio.
  const s = 0.10 / aspect; // chevron depth: ~10 % of the screen height
  const gx = 0.012 / aspect; // gutter width
  const gy = 0.012; // gutter height
  const fullScreen = rectPoly(-E, -E, 1 + E, 1 + E);
  const tx = n <= 2 ? 0.53 : n <= 5 ? 0.5 : 0.47; // chevron tip (MVP right edge)

  const mvpPoly: Poly =
    n === 1
      ? fullScreen
      : [
          -E, -E,
          chevronX(tx, -E, s) - gx / 2, -E,
          tx - gx / 2, 0.5,
          chevronX(tx, 1 + E, s) - gx / 2, 1 + E,
          -E, 1 + E,
          -E, 0.5,
        ];
  const mvp: SlotLayout = {
    poly: mvpPoly,
    focus: n === 1 ? [0.5, 0.5] : [tx * 0.54, 0.53],
    frameH: 3.05,
    lookY: 1.12,
    tag: n === 1 ? [0.5, 0.84] : [Math.max(0.2, tx * 0.46), 0.83],
    row: -1,
  };

  const slots: SlotLayout[] = [];
  // Chevron lines are spaced so every blade shows the same visible width;
  // the last blade of a row bleeds off the right edge (straight cut).
  const right = 1 + s * 0.5;
  if (c >= 1 && c <= 4) {
    const w = (right - tx) / c;
    for (let k = 0; k < c; k++) {
      const a = tx + k * w + gx / 2;
      const b = k === c - 1 ? null : tx + (k + 1) * w - gx / 2;
      const poly = chevronBlade(a, b, s);
      const [xl, xr] = polySpanAt(poly, 0.45);
      const [tl, tr] = polySpanAt(poly, 0.86);
      slots.push({
        poly,
        focus: [(xl + Math.min(xr, 1)) / 2, 0.46],
        frameH: c === 1 ? 3.05 : 3.3,
        lookY: 1.18,
        tag: [(tl + Math.min(tr, 1.0)) / 2, 0.86],
        row: 0,
      });
    }
  } else if (c >= 5) {
    const top = Math.ceil(c / 2);
    const bottom = c - top;
    const yT1 = 0.5 - gy / 2;
    const yB0 = 0.5 + gy / 2;
    const rows: Array<[number, number, number, number]> = [
      [top, -E, yT1, 1],
      [bottom, yB0, 1 + E, 2],
    ];
    for (const [cnt, y0, y1, row] of rows) {
      const w = (right - tx) / cnt;
      for (let k = 0; k < cnt; k++) {
        const a = tx + k * w + gx / 2;
        const b = k === cnt - 1 ? null : tx + (k + 1) * w - gx / 2;
        const poly = chevronTile(a, b, y0, y1, s);
        const yc = row === 1 ? 0.25 : 0.73;
        const yTag = row === 1 ? 0.425 : 0.925;
        const [xl, xr] = polySpanAt(poly, yc);
        const [tl, tr] = polySpanAt(poly, yTag);
        slots.push({
          poly,
          focus: [(xl + Math.min(xr, 1)) / 2, yc],
          frameH: 2.1,
          lookY: 1.4,
          tag: [(tl + Math.min(tr, 1.0)) / 2, yTag],
          row,
        });
      }
    }
  }
  // VS stamp on the chevron tip; with two rows it leans onto the MVP side so
  // it never sits on the first top tile's name.
  const vsAt: Vec2 = [tx - gx / 2 - (c >= 5 ? 0.075 : 0.035), 0.5];
  return { aspect, count: n, mvp, slots, vsAt, fullScreen };
}

/** Wide tilted band where each challenger is revealed before taking its slot. */
function revealBand(open: number): Poly {
  // Center line rises slightly to the right; the band opens from it.
  const cl = 0.53;
  const cr = 0.47;
  const hl = lerp(0.004, 0.36, open);
  const hr = lerp(0.004, 0.36, open);
  return [
    -E, cl - hl,
    1 + E, cr - hr,
    1 + E, cr,
    1 + E, cr + hr,
    -E, cl + hl,
    -E, cl,
  ];
}

// ---------------------------------------------------------------- schedule
export interface IntroSchedule {
  count: number;
  open: number;
  window: number;
  challengerStart: number[];
  mvpStart: number;
  mvpDuration: number;
  finalStart: number;
  finalDuration: number;
  exitStart: number;
  end: number;
}

export function computeSchedule(count: number, targetDuration = 12): IntroSchedule {
  const n = Math.max(1, Math.min(8, Math.floor(count)));
  const c = n - 1;
  const open = 0.62;
  const mvpDuration = n === 1 ? 2.6 : 3.0;
  const finalDuration = n === 1 ? 1.0 : 1.8;
  const budget = Math.max(0, targetDuration - open - mvpDuration - finalDuration);
  const window = c > 0 ? Math.min(1.5, Math.max(0.8, budget / c)) : 0;
  const challengerStart: number[] = [];
  for (let k = 0; k < c; k++) challengerStart.push(open + k * window);
  const mvpStart = open + c * window;
  const finalStart = mvpStart + mvpDuration;
  const exitStart = finalStart + finalDuration * 0.72;
  return {
    count: n,
    open,
    window,
    challengerStart,
    mvpStart,
    mvpDuration,
    finalStart,
    finalDuration,
    exitStart,
    end: finalStart + finalDuration,
  };
}

// ---------------------------------------------------------------- frame state
export type BladeMode = "empty" | "silhouette" | "live";
export type TagMode = "hidden" | "reveal" | "slot" | "mvpBig" | "mvpSlot";

export interface BladeFrame {
  visible: boolean;
  /** Draw order (higher = on top). */
  z: number;
  poly: Poly;
  mode: BladeMode;
  /** 0 → 1: silhouette (ink + rim) → full color. */
  colorIn: number;
  /** White flash over the blade (entrance hit). */
  flash: number;
  /** Gold sunburst behind the character (MVP). */
  burst: number;
  /** Character framing. */
  focus: Vec2;
  frameH: number;
  lookY: number;
  /** Character yaw (rad, 0 = facing the camera, + = turned to screen right). */
  yaw: number;
  /** Camera distance multiplier (push-ins). */
  dolly: number;
  /** Camera orbit around the character (rad). */
  orbit: number;
  /** Entrance pop of the character (0 → 1). */
  pop: number;
  /** Seconds since this player's entrance (pose clock), < 0 before. */
  poseTime: number;
  /** 0 → 1: the character breaks out of the blade's top edge (comic pop-out). */
  popOut: number;
  /** 0 → 1: the camera recenters on the character's head (slot portraits). */
  track: number;
  /**
   * In its final slot / panel with only a slow drift left: the player may
   * refresh this blade's 3D render at a lower rate (cached between frames).
   */
  settled: boolean;
}

export interface TagFrame {
  mode: TagMode;
  x: number;
  y: number;
  /** Width (normalized) available for the tag in slot mode. */
  fitWidth: number;
  /** Scale in reveal / big mode (× the overlay's own fit). */
  scale: number;
  /** 0 → 1: reveal/big scale → fitted slot scale. */
  toSlot: number;
  rot: number;
  opacity: number;
  /** 0 → 1 stats counters / pills. */
  stats: number;
  /** MVP badge + crown (0 → 1). */
  badge: number;
  /** Comic impact star behind the name (0 → 1). */
  burst: number;
}

export interface IntroFrame {
  t: number;
  blades: BladeFrame[]; // index 0..c-1 challengers (presentation order), last = MVP
  placeholders: { poly: Poly; visible: boolean; question: number; tag: Vec2 }[]; // per challenger
  tags: TagFrame[]; // same indexing as blades
  shake: Vec2; // normalized offsets
  zoom: number;
  flash: number;
  flashGold: number;
  slash: { active: boolean; p: number; index: number };
  title: { opacity: number; scale: number; y: number };
  vs: { opacity: number; scale: number; rot: number; ring: number; x: number; y: number };
  exit: number;
  done: boolean;
}

/** Pseudo-random but deterministic shake. */
function shakeAt(t: number, amp: number): Vec2 {
  if (amp <= 0) return [0, 0];
  return [
    amp * (Math.sin(t * 97.3) * 0.6 + Math.sin(t * 61.7 + 1.3) * 0.4),
    amp * (Math.sin(t * 83.1 + 0.7) * 0.6 + Math.sin(t * 53.9 + 2.1) * 0.4),
  ];
}

export function computeFrame(t: number, sch: IntroSchedule, lay: IntroLayout): IntroFrame {
  const n = sch.count;
  const c = n - 1;
  const blades: BladeFrame[] = [];
  const tags: TagFrame[] = [];
  const placeholders: IntroFrame["placeholders"] = [];
  let shakeAmp = 0;
  let flash = 0;
  let flashGold = 0;
  let slash = { active: false, p: 0, index: -1 };

  // ---- opening: the empty tableau drops in + title stamp
  const openIn = easeOutBack(seg(t, 0.0, 0.34), 1.4);
  const tableauOpacity = clamp01(t / 0.18);
  const title = {
    opacity: seg(t, 0.03, 0.12) * (1 - seg(t, sch.open - 0.16, sch.open)),
    scale: lerp(2.4, 1, easeOutBack(seg(t, 0.03, 0.22), 1.6)) * lerp(1, 0.7, easeInCubic(seg(t, sch.open - 0.16, sch.open))),
    y: 0.5 - 0.06 * easeInCubic(seg(t, sch.open - 0.16, sch.open)),
  };
  shakeAmp += 0.006 * pulse(t, 0.12, 0.42);

  // ---- challengers
  for (let k = 0; k < c; k++) {
    const slot = lay.slots[k];
    const s0 = sch.challengerStart[k];
    const u = (t - s0) / sch.window;
    const charLeft = k % 2 === 1; // alternate the reveal composition
    const placeholderVisible = u < 0.95 && tableauOpacity > 0;
    placeholders.push({
      poly: slot.poly,
      visible: placeholderVisible,
      question: placeholderVisible ? tableauOpacity * openIn : 0,
      tag: slot.focus,
    });
    if (u < 0) {
      blades.push(hiddenBlade(slot));
      tags.push(hiddenTag());
      continue;
    }
    if (u < 0.14) slash = { active: true, p: u / 0.14, index: k };
    shakeAmp += 0.004 * pulse(u, 0.06, 0.3);
    flash = Math.max(flash, 0.22 * pulse(u, 0.05, 0.2));

    const open = easeOutBack(seg(u, 0.04, 0.24), 1.3);
    const move = easeInOutCubic(seg(u, 0.64, 0.96));
    // the band slides in from the character's side while it opens
    const slideX = (charLeft ? -1 : 1) * 0.12 * (1 - easeOutCubic(seg(u, 0.04, 0.32)));
    const band = shiftPoly(revealBand(Math.max(0.0, open)), slideX);
    const poly = move > 0 ? lerpPoly(band, slot.poly, move) : band;
    const bandFocus: Vec2 = [(charLeft ? 0.33 : 0.67) + slideX, 0.47];
    const focus: Vec2 = [lerp(bandFocus[0], slot.focus[0], move), lerp(bandFocus[1], slot.focus[1], move)];
    const yawReveal = charLeft ? 0.62 : -0.62;
    blades.push({
      visible: true,
      z: u < 0.96 ? 50 + k : 10 + k,
      poly,
      mode: "live",
      colorIn: 1,
      flash: 0.6 * pulse(u, 0.04, 0.22) + 0.45 * pulse(u, 0.93, 1.05) + finalChase(t, sch, k),
      burst: 0,
      focus,
      frameH: lerp(2.75, slot.frameH, move),
      lookY: lerp(1.12, slot.lookY, move),
      yaw: lerp(yawReveal, -0.5, move),
      dolly: lerp(1.18, 1.0, easeOutCubic(seg(u, 0.06, 0.6))) * lerp(1, 1.0, move),
      orbit: 0.12 * Math.sin((t - s0) * 1.3 + k) * (1 - move) + 0.04 * Math.sin(t * 0.7 + k * 1.7),
      pop: easeOutBack(seg(u, 0.08, 0.3), 1.6),
      poseTime: t - s0,
      popOut: smooth(seg(u, 0.1, 0.22)) * (1 - smooth(seg(u, 0.6, 0.78))),
      track: move,
      settled: u >= 0.97,
    });
    const nameX = charLeft ? 0.7 : 0.31;
    const tagReveal = { x: nameX, y: 0.5 };
    const slam = easeOutBack(seg(u, 0.1, 0.27), 2.2);
    const tagMove = easeInOutCubic(seg(u, 0.62, 0.92));
    const [fl, fr] = polySpanAt(slot.poly, slot.tag[1]);
    tags.push({
      mode: tagMove >= 0.999 ? "slot" : "reveal",
      x: lerp(tagReveal.x, slot.tag[0], tagMove),
      y: lerp(tagReveal.y, slot.tag[1], tagMove),
      fitWidth: Math.min(fr, 1) - Math.max(fl, 0),
      scale: lerp(2.3, 1, slam),
      toSlot: tagMove,
      rot: lerp(lerp(-10, -3.5, slam), -2, tagMove),
      opacity: seg(u, 0.1, 0.16),
      stats: easeOutCubic(seg(u, 0.18, 0.5)),
      badge: 0,
      burst: easeOutBack(seg(u, 0.1, 0.28), 2.0) * (1 - easeInCubic(seg(u, 0.58, 0.7))),
    });
  }

  // ---- MVP: crack → extreme close-up on the champion → pull back (sunburst) → slot
  {
    const v = (t - sch.mvpStart) / sch.mvpDuration;
    const full = lay.fullScreen;
    const grow = easeOutExpo(seg(v, 0.01, 0.08));
    const back = easeInOutCubic(seg(v, 0.66, 0.86));
    let poly = lay.mvp.poly;
    if (v >= 0 && n > 1) poly = lerpPoly(lerpPoly(lay.mvp.poly, full, grow), lay.mvp.poly, back);
    const reveal = smooth(seg(v, 0.04, 0.12));
    const pull = easeInOutCubic(seg(v, 0.1, 0.33));
    const bigFocus: Vec2 = [lerp(0.5, 0.64, pull), lerp(0.44, 0.5, pull)];
    const growFocus = n > 1 ? grow * (1 - back) : v >= 0 ? 1 : 0;
    const silhouetteIn = tableauOpacity * easeOutCubic(seg(t, 0.12, 0.45));
    const sweep = easeInOutCubic(seg(v, 0.3, 0.76));
    blades.push({
      visible: silhouetteIn > 0,
      z: v >= 0 && v < 0.86 ? 200 : 30,
      poly,
      mode: v >= 0.04 ? "live" : "silhouette",
      colorIn: reveal,
      flash: 0.9 * pulse(v, 0.0, 0.07) + 0.35 * pulse(v, 0.84, 0.95),
      burst: v >= 0 ? smooth(seg(v, 0.12, 0.3)) : 0,
      focus: [lerp(lay.mvp.focus[0], bigFocus[0], growFocus), lerp(lay.mvp.focus[1], bigFocus[1], growFocus)],
      frameH: lerp(lay.mvp.frameH, 2.75, growFocus),
      lookY: v >= 0 ? lerp(lerp(1.64, 1.15, pull), lay.mvp.lookY, back) : lay.mvp.lookY,
      yaw: lerp(0.5, 0.22, growFocus),
      dolly: v >= 0 ? lerp(lerp(0.38, 1.0, pull), 1.0, back) : 1.0,
      orbit:
        v >= 0
          ? lerp(lerp(0.0, -0.45, pull) + 0.62 * sweep, 0.05, back) + 0.04 * Math.sin(t * 0.8)
          : 0.03 * Math.sin(t * 0.8),
      pop: 1,
      poseTime: v >= 0 ? t - sch.mvpStart : -1,
      popOut: 0,
      track: v >= 0 ? 0.5 * back : 0.5,
      settled: v < 0 || v >= 0.87,
    });
    if (v >= 0) {
      shakeAmp += 0.016 * pulse(v, 0.0, 0.14) + 0.008 * pulse(v, 0.26, 0.42);
      flashGold = Math.max(flashGold, 0.85 * pulse(v, 0.0, 0.06));
    }
    const slam = easeOutBack(seg(v, 0.28, 0.38), 2.0);
    const tagBack = easeInOutCubic(seg(v, 0.66, 0.86));
    const bigTag: Vec2 = n > 1 ? [0.31, 0.72] : [0.5, 0.8];
    tags.push({
      mode: v < 0.28 ? "hidden" : tagBack >= 0.999 ? "mvpSlot" : "mvpBig",
      x: lerp(bigTag[0], lay.mvp.tag[0], tagBack),
      y: lerp(bigTag[1], lay.mvp.tag[1], tagBack),
      fitWidth: n > 1 ? lay.vsAt[0] * 0.92 : 0.9,
      scale: lerp(3.0, 1.0, slam),
      toSlot: tagBack,
      rot: lerp(lerp(-12, -4, slam), -3, tagBack),
      opacity: seg(v, 0.28, 0.32),
      stats: easeOutCubic(seg(v, 0.38, 0.62)),
      badge: easeOutBack(seg(v, 0.34, 0.45), 1.8),
      burst: easeOutBack(seg(v, 0.28, 0.4), 2.0) * (1 - easeInCubic(seg(v, 0.6, 0.7))),
    });
  }

  // ---- final face-off
  const w = (t - sch.finalStart) / sch.finalDuration;
  const vsIn = easeOutBack(seg(w, 0.0, 0.12), 2.4);
  const vs = {
    opacity: n > 1 ? seg(w, 0.0, 0.04) : 0,
    scale: lerp(3.6, 1, vsIn),
    rot: lerp(-28, -8, vsIn),
    ring: seg(w, 0.03, 0.4),
    x: lay.vsAt[0],
    y: lay.vsAt[1],
  };
  if (w >= 0) {
    shakeAmp += 0.014 * pulse(w, 0.02, 0.22);
    flash = Math.max(flash, 0.45 * pulse(w, 0.02, 0.12));
  }
  // ---- occlusion: DOM marks / tags never float over a blade drawn above them
  const coverers = blades
    .map((b, i) => ({ b, i }))
    .filter((e) => e.b.visible && e.b.z >= 50);
  const covered = (x: number, y: number, z: number, self: number): boolean =>
    coverers.some((e) => e.i !== self && e.b.z > z && pointInPoly(e.b.poly, x, y));
  for (const ph of placeholders) {
    if (ph.visible && covered(ph.tag[0], ph.tag[1], 0, -1)) ph.question = 0;
  }
  tags.forEach((tg, i) => {
    if (tg.mode === "hidden" || tg.opacity <= 0) return;
    if (covered(tg.x, tg.y, blades[i].z, i)) tg.opacity = 0;
  });

  const zoom = lerp(0.96, 1, openIn) * (1 + 0.03 * easeOutCubic(seg(w, 0.1, 0.72)));
  const exit = easeInCubic(seg(t, sch.exitStart, sch.end));

  return {
    t,
    blades,
    placeholders,
    tags,
    shake: shakeAt(t, shakeAmp),
    zoom,
    flash,
    flashGold,
    slash,
    title,
    vs,
    exit,
    done: t >= sch.end,
  };
}

/** Light chase across the challenger tiles when the VS stamp lands. */
function finalChase(t: number, sch: IntroSchedule, k: number): number {
  const w = (t - sch.finalStart) / sch.finalDuration;
  if (w < 0 || w > 1) return 0;
  return 0.42 * pulse(w, 0.05 + 0.035 * k, 0.24 + 0.035 * k);
}

function shiftPoly(p: Poly, dx: number): Poly {
  if (dx === 0) return p;
  const out = p.slice();
  for (let i = 0; i < 6; i++) out[i * 2] += dx;
  return out;
}

function hiddenBlade(slot: SlotLayout): BladeFrame {
  return {
    visible: false,
    z: 0,
    poly: slot.poly,
    mode: "empty",
    colorIn: 0,
    flash: 0,
    burst: 0,
    focus: slot.focus,
    frameH: slot.frameH,
    lookY: slot.lookY,
    yaw: 0,
    dolly: 1,
    orbit: 0,
    pop: 0,
    poseTime: -1,
    popOut: 0,
    track: 0,
    settled: false,
  };
}

function hiddenTag(): TagFrame {
  return { mode: "hidden", x: 0, y: 0, fitWidth: 0, scale: 1, toSlot: 0, rot: 0, opacity: 0, stats: 0, badge: 0, burst: 0 };
}
