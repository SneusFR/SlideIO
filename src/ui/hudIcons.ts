/**
 * Hand-drawn SVG art for the in-game HUD (bean prairie style): chunky
 * shapes, dark-wood ink outline (#3a2814), toy colours. Injected once at
 * construction time (innerHTML) — never rebuilt per frame.
 */

import { MedalType } from "../medals/MedalType";

const INK = "#3a2814";
/** Common outline attributes for every hand-drawn icon. */
const o = (w: number): string =>
  `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const O = o(3);

// ---------------------------------------------------------------------------
// BEAN BUDDY — the player's portrait (bottom-left): the in-game character,
// a squat orange pear-shaped bean with a two-leaf sprout, big round eyes and
// two buck teeth. Every mood face is in the SVG; CSS shows one of them from
// the #bean-buddy mood class. The WHOLE bean fits in the viewBox (head top
// y≈12, belly y≈78): the die-cut cream sticker frame shows it head to toe.
// Outlined in near-black sticker ink (darker than the wood INK of the icons).
// ---------------------------------------------------------------------------
const BUDDY_INK = "#1d1512";

export const BEAN_BUDDY_SVG = `
<svg class="buddy-art" viewBox="0 0 80 80" aria-hidden="true">
  <defs>
    <radialGradient id="bb-body-grad" cx="36%" cy="32%" r="78%">
      <stop offset="0" stop-color="#ff9b5e"/>
      <stop offset="0.5" stop-color="#f0601f"/>
      <stop offset="1" stop-color="#b8400f"/>
    </radialGradient>
    <radialGradient id="bb-leaf-grad" cx="30%" cy="30%" r="90%">
      <stop offset="0" stop-color="#b6ea6a"/>
      <stop offset="1" stop-color="#5ea42a"/>
    </radialGradient>
  </defs>
  <!-- Sprout: stem + two leaves on top of the head -->
  <path d="M40 16c0-4 1-7 3-9" fill="none" stroke="${BUDDY_INK}" stroke-width="4.4" stroke-linecap="round"/>
  <path d="M40 16c0-4 1-7 3-9" fill="none" stroke="#6fb536" stroke-width="2" stroke-linecap="round"/>
  <path class="bb-leaf bb-leaf-l" d="M40.5 11c-3-4-9-5-13-2 2 4 8 6 13 2z" fill="url(#bb-leaf-grad)" stroke="${BUDDY_INK}" stroke-width="2.2" stroke-linejoin="round"/>
  <path class="bb-leaf" d="M43 8c3-5 10-6 15-3-2 5-9 7-15 3z" fill="url(#bb-leaf-grad)" stroke="${BUDDY_INK}" stroke-width="2.4" stroke-linejoin="round"/>
  <!-- Squat pear body: narrow head, round belly -->
  <path class="bb-body" d="M40 14C50 14 55 22 56 30C57 38 70 43 70 57C70 70 57 76 40 76C23 76 10 70 10 57C10 43 23 38 24 30C25 22 30 14 40 14Z"
    fill="url(#bb-body-grad)" stroke="${BUDDY_INK}" stroke-width="4" stroke-linejoin="round"/>
  <ellipse cx="34" cy="21" rx="4.5" ry="2.4" fill="#ffffff" opacity="0.4" transform="rotate(-35 34 21)"/>
  <ellipse cx="20" cy="56" rx="2.6" ry="6" fill="#ffffff" opacity="0.18" transform="rotate(18 20 56)"/>
  <circle cx="40" cy="67" r="1.3" fill="${BUDDY_INK}" opacity="0.75"/>

  <g transform="translate(0 6)" class="bb-face bb-happy">
    <g class="bb-eyes">
      <circle cx="31" cy="31" r="6.4" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
      <circle cx="49" cy="31" r="6.4" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
      <circle cx="32" cy="31.5" r="2.5" fill="${BUDDY_INK}"/>
      <circle cx="48" cy="31.5" r="2.5" fill="${BUDDY_INK}"/>
      <circle cx="33" cy="30.3" r="0.9" fill="#ffffff"/>
      <circle cx="49" cy="30.3" r="0.9" fill="#ffffff"/>
    </g>
    <path d="M27 42q13 2 26 0-1 15-13 15t-13-15z" fill="#6e1a14" stroke="${BUDDY_INK}" stroke-width="2.6" stroke-linejoin="round"/>
    <ellipse cx="40" cy="53" rx="7" ry="3.2" fill="#e25548"/>
    <path d="M35.5 43.2h4.2v5.6a0.8 0.8 0 0 1-0.8 0.8h-2.6a0.8 0.8 0 0 1-0.8-0.8z" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M40.3 43.2h4.2v5.6a0.8 0.8 0 0 1-0.8 0.8h-2.6a0.8 0.8 0 0 1-0.8-0.8z" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="1.5" stroke-linejoin="round"/>
  </g>

  <g transform="translate(0 6)" class="bb-face bb-worried">
    <path d="M24 23l9 3M56 23l-9 3" fill="none" stroke="${BUDDY_INK}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="31" cy="32" r="6" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
    <circle cx="49" cy="32" r="6" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
    <circle cx="29.5" cy="33.5" r="2.2" fill="${BUDDY_INK}"/>
    <circle cx="47.5" cy="33.5" r="2.2" fill="${BUDDY_INK}"/>
    <path d="M32 49q8-5 16 0-1 6-8 6t-8-6z" fill="#6e1a14" stroke="${BUDDY_INK}" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M36.2 46.8h3.6v3.6h-3.6zM40.2 46.8h3.6v3.6h-3.6z" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="1.3" stroke-linejoin="round"/>
  </g>

  <g transform="translate(0 6)" class="bb-face bb-panic">
    <path d="M23 22l9-4M57 22l-9-4" fill="none" stroke="${BUDDY_INK}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="31" cy="31" r="7.4" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
    <circle cx="49" cy="31" r="7.4" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.4"/>
    <circle cx="31" cy="31" r="1.5" fill="${BUDDY_INK}"/>
    <circle cx="49" cy="31" r="1.5" fill="${BUDDY_INK}"/>
    <ellipse cx="40" cy="51" rx="7.5" ry="8.5" fill="#6e1a14" stroke="${BUDDY_INK}" stroke-width="2.6"/>
    <path d="M36.3 43.2h3.4v4h-3.4zM40.3 43.2h3.4v4h-3.4z" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="1.3" stroke-linejoin="round"/>
    <ellipse cx="40" cy="56" rx="4.6" ry="2.4" fill="#e25548"/>
    <path class="bb-sweat" d="M62 17c3.4 5 3.4 8.4 0 9.4-3.4-1-3.4-4.4 0-9.4z" fill="#8fe3ff" stroke="${BUDDY_INK}" stroke-width="2"/>
  </g>

  <g transform="translate(0 6)" class="bb-face bb-ouch">
    <path d="M25 27l8 4-8 4M55 27l-8 4 8 4" fill="none" stroke="${BUDDY_INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="28" y="43" width="24" height="10" rx="5" fill="#ffffff" stroke="${BUDDY_INK}" stroke-width="2.6"/>
    <path d="M28.5 48h23M34 43.5v9M40 43.5v9M46 43.5v9" fill="none" stroke="${BUDDY_INK}" stroke-width="1.6"/>
  </g>

  <g transform="translate(0 6)" class="bb-face bb-dead">
    <path d="M26 27l9 9M35 27l-9 9M45 27l9 9M54 27l-9 9" fill="none" stroke="${BUDDY_INK}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M30 47q10 4 20 0" fill="none" stroke="${BUDDY_INK}" stroke-width="3" stroke-linecap="round"/>
    <path d="M42 48.6v4.4a3.2 3.2 0 0 0 6.4 0v-5.6" fill="#e25548" stroke="${BUDDY_INK}" stroke-width="2.2" stroke-linejoin="round"/>
  </g>
</svg>`;

/** Small popcorn puff used as the popcorn shotgun's ammo pip. */
export const POPCORN_PIP_SVG = `
<svg viewBox="0 0 24 22" aria-hidden="true">
  <path d="M5 16a5 5 0 0 1 1-9 6 6 0 0 1 11-1 5 5 0 0 1 2 9 5 5 0 0 1-7 4 5 5 0 0 1-7-3z"
    fill="currentColor" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="9" cy="9" r="1.6" fill="#ffffff" opacity="0.8"/>
</svg>`;

// ---------------------------------------------------------------------------
// WEAPON icons (48×48) — shown in the round badge of the weapon plate.
// ---------------------------------------------------------------------------
export type WeaponIconKey =
  | "paintball"
  | "popcorn"
  | "water"
  | "frisbee"
  | "bass"
  | "poison"
  | "heat"
  | "revolver"
  | "spear";

const WEAPON_ICONS: Record<WeaponIconKey, string> = {
  paintball: `
    <g fill="#17151c" stroke="#17151c" stroke-linejoin="round" stroke-linecap="round">
      <rect x="6" y="11" width="38" height="10" rx="4" stroke-width="1.6" transform="rotate(-11 25 16)"/>
      <path d="M9 21.5L26 18.5L28 27.5H18.5L16.5 29H10Z" stroke-width="2"/>
      <path d="M10.5 28L19 29.5L16 42.5L8 41Z" stroke-width="2"/>
      <path d="M20 29.5L23.5 31.5V35.5H29" fill="none" stroke-width="2.4"/>
      <rect x="22" y="12.5" width="6" height="3" rx="1.5" fill="#3a3744" stroke="none" transform="rotate(-11 25 14)"/>
    </g>`,
  popcorn: `
    <circle cx="15" cy="17" r="6.5" fill="#f4b73a" ${O}/>
    <circle cx="33" cy="17" r="6.5" fill="#f4b73a" ${O}/>
    <circle cx="24" cy="12" r="7.5" fill="#ffc94a" ${O}/>
    <path d="M10 20h28l-4 23H14z" fill="#ff4d6d"/>
    <path d="M19 21.5l1.4 20M29 21.5l-1.4 20" stroke="#fff6e0" stroke-width="4.5"/>
    <path d="M10 20h28l-4 23H14z" fill="none" ${O}/>`,
  water: `
    <rect x="13" y="8" width="15" height="11" rx="5" fill="#bdefff" ${O}/>
    <path d="M6 21h24l5-3h6v8h-6l-2 2h-6l-3 11h-8l3-11H6z" fill="#38c6ff" ${O}/>
    <path d="M45 31c0 3.6-4.6 3.6-4.6 0 0-2.2 2.3-4.6 2.3-4.6s2.3 2.4 2.3 4.6z" fill="#8fe3ff" ${o(2)}/>`,
  frisbee: `
    <path d="M4 17h8M2 23h7M5 29h6" fill="none" stroke="#ffd0a8" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="28" cy="26" rx="17" ry="9" fill="#ff8a3d" ${O}/>
    <ellipse cx="28" cy="24" rx="9" ry="4.2" fill="#ffd0a8" ${o(2.4)}/>`,
  bass: `
    <path d="M15 14v-5h18v5" fill="none" ${O}/>
    <rect x="4" y="14" width="40" height="25" rx="7" fill="#ff7ac8" ${O}/>
    <circle cx="15" cy="27" r="7" fill="#fff6e0" ${O}/>
    <circle cx="33" cy="27" r="7" fill="#fff6e0" ${O}/>
    <circle cx="15" cy="27" r="2.6" fill="${INK}"/>
    <circle cx="33" cy="27" r="2.6" fill="${INK}"/>`,
  poison: `
    <path d="M18 5h12v11l10 17a6 6 0 0 1-5 9H13a6 6 0 0 1-5-9l10-17z" fill="#effde6"/>
    <path d="M11.5 29h25l3.2 5.4a4 4 0 0 1-3.5 6.1H11.8a4 4 0 0 1-3.5-6.1z" fill="#7bff4d"/>
    <path d="M18 5h12v11l10 17a6 6 0 0 1-5 9H13a6 6 0 0 1-5-9l10-17z" fill="none" ${O}/>
    <circle cx="20" cy="35" r="2.2" fill="#e6ffd8"/>
    <circle cx="27" cy="32" r="1.5" fill="#e6ffd8"/>
    <path d="M16 5h16" fill="none" ${O}/>`,
  heat: `
    <path d="M24 4c2 8 13 12 13 25a13 13 0 0 1-26 0c0-7 4-10 6-14 1 4 3 6 5 6-1-6 0-12 2-17z" fill="#ff8a3d" ${O}/>
    <path d="M24 26c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3z" fill="#ffd23f"/>`,
  revolver: `
    <path d="M4 16h32v8H22l-2 4h-5l-3 13H5l3-13-4-4z" fill="#a9793a" ${O}/>
    <circle cx="23" cy="21" r="5.5" fill="#5e3f19" ${o(2.4)}/>
    <path d="M36 18h7" fill="none" ${O}/>`,
  spear: `
    <path d="M9 41L31 19" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
    <path d="M9 41L31 19" fill="none" stroke="#b07a3f" stroke-width="4" stroke-linecap="round"/>
    <path d="M29 10l14-5-5 14-7 3-5-5z" fill="#facc15" ${O}/>`,
};

export function weaponIconSvg(key: WeaponIconKey): string {
  return `<svg class="wpn-icon-art" viewBox="0 0 48 48" aria-hidden="true">${WEAPON_ICONS[key]}</svg>`;
}

// ---------------------------------------------------------------------------
// KILLSTREAK medallion icons (64×64) + accent colour per streak.
// ---------------------------------------------------------------------------
const KS_ICONS: Record<string, string> = {
  MOLE_STRIKE: `
    <path d="M17 46c0-15 7-25 15-25s15 10 15 25z" fill="#8a5c34" ${O}/>
    <path d="M22 29c-3-3-3-7 1-8M42 29c3-3 3-7-1-8" fill="none" ${o(2.6)}/>
    <circle cx="26.5" cy="33" r="2.4" fill="${INK}"/>
    <circle cx="37.5" cy="33" r="2.4" fill="${INK}"/>
    <circle cx="27.3" cy="32.2" r="0.8" fill="#ffffff"/>
    <circle cx="38.3" cy="32.2" r="0.8" fill="#ffffff"/>
    <ellipse cx="32" cy="39" rx="5.5" ry="4" fill="#ff9aa8" ${o(2.4)}/>
    <path d="M30 43.5h4v3h-4z" fill="#ffffff" ${o(1.6)}/>
    <path d="M4 58c3-10 12-14 28-14s25 4 28 14z" fill="#6b4a2b" ${O}/>
    <circle cx="16" cy="53" r="2" fill="#a5774a"/>
    <circle cx="47" cy="52" r="2.4" fill="#a5774a"/>
    <circle cx="33" cy="55" r="1.6" fill="#a5774a"/>`,
  ORBITAL_SCAN: `
    <path d="M32 46v9M22 58h20" fill="none" ${O}/>
    <path d="M10 14a26 26 0 0 0 0 30M54 14a26 26 0 0 1 0 30" fill="none" stroke="#5cc8ff" stroke-width="3.4" stroke-linecap="round"/>
    <circle cx="32" cy="29" r="17" fill="#fff6e0" ${O}/>
    <circle cx="36" cy="27" r="8" fill="#5cc8ff" ${o(2.4)}/>
    <circle cx="37" cy="27" r="3.4" fill="${INK}"/>
    <circle cx="34.5" cy="24.5" r="1.6" fill="#ffffff"/>`,
  NOVA_STRIKE: `
    <path d="M32 5l6.5 15.5L55 22l-12.6 11L46.5 50 32 41l-14.5 9 4.1-17L9 22l16.5-1.5z" fill="#facc15" ${O}/>
    <circle cx="32" cy="29" r="5" fill="#ff8a3d" ${o(2.2)}/>
    <path d="M12 52l-4 4M52 52l4 4M32 50v8" fill="none" stroke="#ff8a3d" stroke-width="3" stroke-linecap="round"/>`,
};

const KS_FALLBACK = `
  <path d="M32 8l7 15 16 2-12 11 3 16-14-8-14 8 3-16L9 25l16-2z" fill="#facc15" ${O}/>`;

const KS_COLORS: Record<string, string> = {
  MOLE_STRIKE: "#c98a4a",
  ORBITAL_SCAN: "#5cc8ff",
  NOVA_STRIKE: "#ff8a3d",
};

export function killstreakIconSvg(id: string): string {
  return `<svg class="ks-icon-art" viewBox="0 0 64 64" aria-hidden="true">${KS_ICONS[id] ?? KS_FALLBACK}</svg>`;
}

/** Accent colour of a killstreak (ring, glow, unlock burst). */
export function killstreakColor(id: string): string {
  return KS_COLORS[id] ?? "#facc15";
}

// ---------------------------------------------------------------------------
// MEDALS (KILL / DOUBLE / HEADSHOT…) — 64×64 art drawn inside the round
// sticker badge of MedalHUD. Recurring hero: the knocked-out bean.
// ---------------------------------------------------------------------------

/** A knocked-out bean (X eyes, tongue out) centred on (x, y). The outline
 *  width is compensated so it stays the same whatever the scale. */
function koBean(x: number, y: number, s: number, rot: number): string {
  const k = 1 / s;
  const w = (n: number): string => o(n * k);
  return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">
    <path d="M0 -19c0-3 1-5 2.5-6.5" fill="none" stroke="${INK}" stroke-width="${4 * k}" stroke-linecap="round"/>
    <path d="M0 -19c0-3 1-5 2.5-6.5" fill="none" stroke="#6fb536" stroke-width="${1.8 * k}" stroke-linecap="round"/>
    <path d="M2.5 -25.5c2-4 7-4.5 10-2.5-1.5 4-6.5 5-10 2.5z" fill="#8fd14f" ${w(2)}/>
    <path d="M0 -20c6 0 9 5 9.5 10 .5 5 6.5 8 6.5 16 0 9-7 14-16 14s-16-5-16-14c0-8 6-11 6.5-16 .5-5 3.5-10 9.5-10z" fill="#e38a4a" ${w(3)}/>
    <ellipse cx="-6" cy="-11" rx="3.2" ry="1.8" fill="#ffffff" opacity="0.45" transform="rotate(-35 -6 -11)"/>
    <path d="M-9 -5l5 5m0-5l-5 5M4 -5l5 5m0-5l-5 5" fill="none" ${w(2.4)}/>
    <path d="M1 6.3v3.2a2 2 0 0 0 4 0v-3.6z" fill="#ff7a8a" ${w(1.6)}/>
    <path d="M-4.5 7q4.5 -3 9 -0.6" fill="none" ${w(2.2)}/>
  </g>`;
}

/** Little 4-point "dizzy" sparkle. */
function sparkle(x: number, y: number, r: number): string {
  return `<path d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}z" fill="#fff6e0" ${o(1.6)}/>`;
}

/** Thick cartoon stroke: ink under-stroke + coloured stroke on top. */
function inkLine(d: string, color: string, width: number): string {
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${width + 3.4}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Padlock drawn on locked medallions (two halves → they fly apart on unlock). */
export const PADLOCK_SVG = `
<svg class="ks-lock-art" viewBox="0 0 24 26" aria-hidden="true">
  <path class="ks-lock-shackle" d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
  <path class="ks-lock-shackle" d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="#e8d3a8" stroke-width="2" stroke-linecap="round"/>
  <rect class="ks-lock-body" x="3" y="11" width="18" height="13" rx="4" fill="#facc15" ${o(2.4)}/>
  <circle cx="12" cy="17" r="2" fill="${INK}"/>
</svg>`;

// ---------------------------------------------------------------------------
// MEDAL art (uses koBean / sparkle / inkLine above). Palette = the HUD's:
// wood, bean orange, sprout green, gold, cream, tomato — no space violet.
// ---------------------------------------------------------------------------
const MEDAL_ICONS: Record<MedalType, string> = {
  [MedalType.KILL]: `
    ${koBean(32, 36, 1.05, -10)}
    ${sparkle(12, 15, 6)}${sparkle(52, 12, 5)}${sparkle(56, 31, 3.5)}`,
  [MedalType.DOUBLE_KILL]: `
    ${koBean(21, 38, 0.78, -16)}
    ${koBean(44, 36, 0.78, 14)}
    ${sparkle(32, 11, 5)}`,
  [MedalType.TRIPLE_KILL]: `
    ${koBean(15, 42, 0.6, -20)}
    ${koBean(49, 42, 0.6, 20)}
    ${koBean(32, 34, 0.72, 0)}
    ${sparkle(9, 16, 4)}${sparkle(55, 16, 4)}`,
  [MedalType.SMASHED]: `
    <path d="M3 42l7 3M7 32l6 5M61 42l-7 3M57 32l-6 5" fill="none" ${o(3)}/>
    <ellipse cx="32" cy="51" rx="23" ry="7" fill="#e38a4a" ${O}/>
    <path d="M22 49l3 3m0-3l-3 3M39 49l3 3m0-3l-3 3" fill="none" ${o(2)}/>
    <g transform="rotate(-24 34 30)">
      ${inkLine("M34 29V5", "#c98a4a", 5)}
      <rect x="17" y="27" width="34" height="16" rx="5" fill="#c98a4a" ${O}/>
      <rect x="21" y="27" width="4.5" height="16" fill="#8a5c34" ${o(2)}/>
      <rect x="42.5" y="27" width="4.5" height="16" fill="#8a5c34" ${o(2)}/>
      <path d="M27 31h12" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" opacity="0.5"/>
    </g>
    ${sparkle(54, 20, 5)}${sparkle(10, 20, 4)}`,
  [MedalType.HOMERUN]: `
    ${inkLine("M8 14h13M4 23h15M10 32h11", "#fff6e0", 3)}
    ${inkLine("M7 59L17 52", "#8a5c34", 3.6)}
    ${inkLine("M17 52L36 39", "#c98a4a", 8)}
    <circle cx="42" cy="22" r="13" fill="#fff6e0" ${O}/>
    <path d="M34 12q5 10 0 20M50 12q-5 10 0 20" fill="none" stroke="#e2413a" stroke-width="2.2" stroke-linecap="round"/>
    <ellipse cx="38" cy="15" rx="3.2" ry="1.8" fill="#ffffff" transform="rotate(-30 38 15)"/>
    ${sparkle(58, 44, 4)}`,
  [MedalType.OBLITERATED]: `
    <circle cx="32" cy="32" r="23" fill="#1c1208" ${O}/>
    ${inkLine("M32 28a4 4 0 0 1 4 4a8 8 0 0 1-8 8a12 12 0 0 1-12-12a16 16 0 0 1 16-16a20 20 0 0 1 20 20", "#ffb347", 3.4)}
    <circle cx="32" cy="32" r="3" fill="#fff6e0"/>
    <rect x="5" y="7" width="7" height="7" rx="2" fill="#ff8a3d" transform="rotate(20 8.5 10.5)" ${o(2)}/>
    <ellipse cx="55" cy="54" rx="5" ry="3.4" fill="#e38a4a" transform="rotate(-35 55 54)" ${o(2)}/>
    <rect x="50" y="6" width="5" height="5" rx="1.5" fill="#facc15" transform="rotate(-25 52.5 8.5)" ${o(1.8)}/>`,
  [MedalType.MOLED]: `
    ${KS_ICONS.MOLE_STRIKE}
    ${sparkle(10, 12, 4.5)}${sparkle(54, 13, 4)}`,
  [MedalType.IMPALED]: `
    ${koBean(28, 37, 0.95, 18)}
    ${inkLine("M8 56L46 18", "#b07a3f", 4)}
    <path d="M44 9l14-5-5 14-7 3-5-5z" fill="#facc15" ${O}/>
    ${sparkle(12, 14, 4.5)}`,
  [MedalType.HEADSHOT]: `
    ${koBean(32, 41, 1, 0)}
    <circle cx="32" cy="38" r="13" fill="none" stroke="${INK}" stroke-width="6.4"/>
    <circle cx="32" cy="38" r="13" fill="none" stroke="#e2413a" stroke-width="3"/>
    ${inkLine("M32 20v6M32 50v6M14 38h6M44 38h6", "#e2413a", 3)}
    <path d="M51 4l2.6 5.6 6 .7-4.5 4.1 1.3 6-5.4-3-5.4 3 1.3-6-4.5-4.1 6-.7z" fill="#facc15" ${o(2)}/>`,
};

/** Medal art (one <svg> per medal, pre-rendered once by MedalHUD). */
export function medalIconSvg(medal: MedalType): string {
  return `<svg class="md-icon" data-medal="${medal}" viewBox="0 0 64 64" aria-hidden="true">${MEDAL_ICONS[medal]}</svg>`;
}

/** Notched ribbon tail tucked behind the medal ribbon (fill from CSS). */
export function ribbonTailSvg(side: "l" | "r"): string {
  const d = side === "l" ? "M25 2H2l7 13-7 13h23z" : "M1 2h23l-7 13 7 13H1z";
  return `<svg class="md-tail md-tail-${side}" viewBox="0 0 26 30" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" stroke="${INK}" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Tier star above the medal disc (KILL = 1, DOUBLE = 2, TRIPLE = 3…). */
export const MEDAL_STAR_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21.1l1.5-7L2 9.3l7-.8z" fill="#facc15" ${o(2.2)}/>
</svg>`;

