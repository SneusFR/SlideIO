/**
 * Hand-drawn SVG art for the in-game HUD (bean prairie style): chunky
 * shapes, dark-wood ink outline (#3a2814), toy colours. Injected once at
 * construction time (innerHTML) — never rebuilt per frame.
 */

const INK = "#3a2814";
/** Common outline attributes for every hand-drawn icon. */
const o = (w: number): string =>
  `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const O = o(3);

// ---------------------------------------------------------------------------
// BEAN BUDDY — the player's portrait (bottom-left): the in-game character,
// an orange pear-shaped bean with a green sprout, big round eyes and two
// buck teeth. Every mood face is in the SVG; CSS shows one of them from the
// #bean-buddy mood class. The body runs past the bottom of the viewBox:
// the round portrait frame crops it like a bust.
// ---------------------------------------------------------------------------
export const BEAN_BUDDY_SVG = `
<svg class="buddy-art" viewBox="0 0 80 80" aria-hidden="true">
  <defs>
    <radialGradient id="bb-body-grad" cx="38%" cy="30%" r="80%">
      <stop offset="0" stop-color="#f2a066"/>
      <stop offset="0.5" stop-color="#d06a2e"/>
      <stop offset="1" stop-color="#9a4518"/>
    </radialGradient>
    <radialGradient id="bb-leaf-grad" cx="30%" cy="30%" r="90%">
      <stop offset="0" stop-color="#b6ea6a"/>
      <stop offset="1" stop-color="#5ea42a"/>
    </radialGradient>
  </defs>
  <!-- Sprout: stem + leaf on top of the head -->
  <path d="M40 17c0-4 1-7 3-9" fill="none" stroke="${INK}" stroke-width="4.4" stroke-linecap="round"/>
  <path d="M40 17c0-4 1-7 3-9" fill="none" stroke="#6fb536" stroke-width="2" stroke-linecap="round"/>
  <path class="bb-leaf" d="M43 9c3-5 10-6 15-3-2 5-9 7-15 3z" fill="url(#bb-leaf-grad)" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
  <!-- Pear-shaped body (runs past the frame, cropped by the round portrait) -->
  <path class="bb-body" d="M40 15c11 0 16 9 17 18 1 9 14 16 14 32 0 17-14 27-31 27S9 82 9 65c0-16 13-23 14-32 1-9 6-18 17-18z"
    fill="url(#bb-body-grad)" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
  <ellipse cx="31" cy="23" rx="5" ry="2.6" fill="#ffffff" opacity="0.35" transform="rotate(-35 31 23)"/>
  <path d="M38 72q2 2.2 4 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" opacity="0.7"/>

  <g class="bb-face bb-happy">
    <g class="bb-eyes">
      <circle cx="31" cy="31" r="6.4" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
      <circle cx="49" cy="31" r="6.4" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
      <circle cx="32" cy="31.5" r="2.5" fill="${INK}"/>
      <circle cx="48" cy="31.5" r="2.5" fill="${INK}"/>
      <circle cx="33" cy="30.3" r="0.9" fill="#ffffff"/>
      <circle cx="49" cy="30.3" r="0.9" fill="#ffffff"/>
    </g>
    <path d="M27 42q13 2 26 0-1 15-13 15t-13-15z" fill="#6e1a14" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>
    <ellipse cx="40" cy="53" rx="7" ry="3.2" fill="#e25548"/>
    <path d="M35.5 43.2h4.2v5.6a0.8 0.8 0 0 1-0.8 0.8h-2.6a0.8 0.8 0 0 1-0.8-0.8z" fill="#ffffff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M40.3 43.2h4.2v5.6a0.8 0.8 0 0 1-0.8 0.8h-2.6a0.8 0.8 0 0 1-0.8-0.8z" fill="#ffffff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
  </g>

  <g class="bb-face bb-worried">
    <path d="M24 23l9 3M56 23l-9 3" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="31" cy="32" r="6" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
    <circle cx="49" cy="32" r="6" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
    <circle cx="29.5" cy="33.5" r="2.2" fill="${INK}"/>
    <circle cx="47.5" cy="33.5" r="2.2" fill="${INK}"/>
    <path d="M32 49q8-5 16 0-1 6-8 6t-8-6z" fill="#6e1a14" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M36.2 46.8h3.6v3.6h-3.6zM40.2 46.8h3.6v3.6h-3.6z" fill="#ffffff" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>
  </g>

  <g class="bb-face bb-panic">
    <path d="M23 22l9-4M57 22l-9-4" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="31" cy="31" r="7.4" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
    <circle cx="49" cy="31" r="7.4" fill="#ffffff" stroke="${INK}" stroke-width="2.4"/>
    <circle cx="31" cy="31" r="1.5" fill="${INK}"/>
    <circle cx="49" cy="31" r="1.5" fill="${INK}"/>
    <ellipse cx="40" cy="51" rx="7.5" ry="8.5" fill="#6e1a14" stroke="${INK}" stroke-width="2.6"/>
    <path d="M36.3 43.2h3.4v4h-3.4zM40.3 43.2h3.4v4h-3.4z" fill="#ffffff" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>
    <ellipse cx="40" cy="56" rx="4.6" ry="2.4" fill="#e25548"/>
    <path class="bb-sweat" d="M62 17c3.4 5 3.4 8.4 0 9.4-3.4-1-3.4-4.4 0-9.4z" fill="#8fe3ff" stroke="${INK}" stroke-width="2"/>
  </g>

  <g class="bb-face bb-ouch">
    <path d="M25 27l8 4-8 4M55 27l-8 4 8 4" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="28" y="43" width="24" height="10" rx="5" fill="#ffffff" stroke="${INK}" stroke-width="2.6"/>
    <path d="M28.5 48h23M34 43.5v9M40 43.5v9M46 43.5v9" fill="none" stroke="${INK}" stroke-width="1.6"/>
  </g>

  <g class="bb-face bb-dead">
    <path d="M26 27l9 9M35 27l-9 9M45 27l9 9M54 27l-9 9" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M30 47q10 4 20 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
    <path d="M42 48.6v4.4a3.2 3.2 0 0 0 6.4 0v-5.6" fill="#e25548" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>
  </g>
</svg>`;

/** Tiny lightning bolt for the dash tube. */
export const BOLT_SVG = `
<svg class="dash-bolt" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M14 2L5 13h6l-2 9 9-12h-6z" fill="#5cc8ff" ${o(2.4)}/>
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
    <path d="M5 25h25l6-4h6v9h-6l-2 2H21l-3 10h-8l3-10H5z" fill="#ff5fa2" ${O}/>
    <circle cx="21" cy="14" r="8" fill="#ffd23f" ${O}/>
    <circle cx="18.5" cy="11.5" r="2.4" fill="#ffffff" opacity="0.75"/>
    <circle cx="11" cy="28" r="1.8" fill="#3ee0c5"/>`,
  popcorn: `
    <circle cx="15" cy="17" r="6.5" fill="#fff3c4" ${O}/>
    <circle cx="33" cy="17" r="6.5" fill="#fff3c4" ${O}/>
    <circle cx="24" cy="12" r="7.5" fill="#fff3c4" ${O}/>
    <path d="M10 20h28l-4 23H14z" fill="#fff6e0"/>
    <path d="M19 21.5l1.4 20M29 21.5l-1.4 20" stroke="#ff4d6d" stroke-width="4.5"/>
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
    <path d="M4 16h32v8H22l-2 4h-5l-3 13H5l3-13-4-4z" fill="#e8d3a8" ${O}/>
    <circle cx="23" cy="21" r="5.5" fill="#c9b184" ${o(2.4)}/>
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

/** Padlock drawn on locked medallions (two halves → they fly apart on unlock). */
export const PADLOCK_SVG = `
<svg class="ks-lock-art" viewBox="0 0 24 26" aria-hidden="true">
  <path class="ks-lock-shackle" d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
  <path class="ks-lock-shackle" d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="#e8d3a8" stroke-width="2" stroke-linecap="round"/>
  <rect class="ks-lock-body" x="3" y="11" width="18" height="13" rx="4" fill="#facc15" ${o(2.4)}/>
  <circle cx="12" cy="17" r="2" fill="${INK}"/>
</svg>`;
