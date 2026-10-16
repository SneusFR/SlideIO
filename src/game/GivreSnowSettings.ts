import type { GivreSnowLevel } from "../world/GivreSnow";

/**
 * GIVRE falling-snow density (menu SETTINGS → SNOW, Givre only).
 *
 * Same persistence pattern as OutlineSettings / GraphicsQuality: a tiny
 * localStorage record, defensively parsed. Default "normale". Applies LIVE
 * (GivreSnow.setLevel only changes the draw range — no reallocation).
 */
const STORAGE_KEY = "slideio.givreSnow";

/** Cycle order of the menu button. */
export const SNOW_LEVELS: readonly GivreSnowLevel[] = ["off", "legere", "normale", "dense"];

export const DEFAULT_SNOW_LEVEL: GivreSnowLevel = "normale";

/** Menu label of a level. */
export function snowLevelLabel(level: GivreSnowLevel): string {
  switch (level) {
    case "off":
      return "OFF";
    case "legere":
      return "LIGHT";
    case "normale":
      return "NORMAL";
    case "dense":
      return "DENSE";
  }
}

export function loadSnowLevel(): GivreSnowLevel {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return SNOW_LEVELS.includes(raw as GivreSnowLevel) ? (raw as GivreSnowLevel) : DEFAULT_SNOW_LEVEL;
  } catch {
    return DEFAULT_SNOW_LEVEL;
  }
}

export function saveSnowLevel(level: GivreSnowLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    /* storage unavailable — the session keeps its live level */
  }
}
