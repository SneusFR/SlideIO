/**
 * Crosshair customization — shape (classic dot or CROSS), size and color.
 *
 * Same persistence pattern as GraphicsQuality: a tiny localStorage record,
 * defensively parsed (bad/missing data falls back to the classic defaults).
 * The visual itself is 100% CSS: applyCrosshairSettings only toggles the
 * `cross` class and writes two CSS custom properties on the existing
 * #crosshair element (--ch-scale / --ch-color) — zero per-frame JS, and
 * the hitmarker/hit feedback pipelines keep working untouched.
 */

export type CrosshairShape = "DOT" | "CROSS";

export interface CrosshairSettings {
  shape: CrosshairShape;
  /** Uniform scale factor — 1 = the classic 4 px dot / 14 px cross. */
  scale: number;
  /** #rrggbb hex color (native <input type="color"> format). */
  color: string;
}

const STORAGE_KEY = "slideio.crosshair";

/** The game's historical look: small white dot. */
export const DEFAULT_CROSSHAIR: CrosshairSettings = {
  shape: "DOT",
  scale: 1,
  color: "#ffffff",
};

/** Slider bounds (percent of the base size) — mirrored in index.html. */
export const CROSSHAIR_SCALE_MIN = 0.5;
export const CROSSHAIR_SCALE_MAX = 2.5;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Persisted settings, defensively validated field by field. */
export function loadCrosshairSettings(): CrosshairSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CROSSHAIR };
    const parsed = JSON.parse(raw) as Partial<CrosshairSettings>;
    return {
      shape: parsed.shape === "CROSS" ? "CROSS" : "DOT",
      scale:
        typeof parsed.scale === "number" && Number.isFinite(parsed.scale)
          ? Math.min(CROSSHAIR_SCALE_MAX, Math.max(CROSSHAIR_SCALE_MIN, parsed.scale))
          : DEFAULT_CROSSHAIR.scale,
      color:
        typeof parsed.color === "string" && HEX_COLOR.test(parsed.color)
          ? parsed.color.toLowerCase()
          : DEFAULT_CROSSHAIR.color,
    };
  } catch {
    return { ...DEFAULT_CROSSHAIR };
  }
}

export function saveCrosshairSettings(settings: CrosshairSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — the session keeps its live crosshair */
  }
}

/** Push the settings onto the live #crosshair element (pure CSS driving). */
export function applyCrosshairSettings(settings: CrosshairSettings): void {
  const el = document.getElementById("crosshair");
  if (!el) return;
  el.classList.toggle("cross", settings.shape === "CROSS");
  el.style.setProperty("--ch-scale", String(settings.scale));
  el.style.setProperty("--ch-color", settings.color);
}
