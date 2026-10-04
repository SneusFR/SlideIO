/**
 * Crosshair customization — shape (STICKER default, classic DOT or CROSS), size, color,
 * high contrast and reduced motion.
 *
 * Same persistence pattern as GraphicsQuality: a tiny localStorage record,
 * defensively parsed (bad/missing data falls back to the defaults).
 * The visual itself is 100% CSS: applyCrosshairSettings only toggles classes
 * and writes two CSS custom properties (--ch-scale / --ch-color) on the existing
 * #crosshair element (and --ch-scale on :root so the hitmarker follows the same size) —
 * zero per-frame JS, and the hitmarker/hit feedback pipelines keep working untouched.
 */

export type CrosshairShape = "STICKER" | "DOT" | "CROSS";

export interface CrosshairSettings {
  shape: CrosshairShape;
  /** Uniform scale factor — 1 = the base size (4 px dot / 14 px cross / 5 px sticker dot). */
  scale: number;
  /** #rrggbb hex color (native <input type="color"> format). */
  color: string;
  /** Thicker ink outline for bright or busy backgrounds. */
  highContrast: boolean;
  /** No travelling motion: aim / fire / hit feedback become simple fades. */
  reducedMotion: boolean;
}

const STORAGE_KEY = "slideio.crosshair";

/** The HUD's own look: cream dot + 4 radial ticks with ink outline and a turquoise tip. */
export const DEFAULT_CROSSHAIR: CrosshairSettings = {
  shape: "STICKER",
  scale: 1,
  color: "#fbf1da",
  highContrast: false,
  reducedMotion: false,
};

/** Slider bounds (percent of the base size) — mirrored in index.html. */
export const CROSSHAIR_SCALE_MIN = 0.5;
export const CROSSHAIR_SCALE_MAX = 2.5;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Respect the OS-level preference when nothing is saved yet. */
function systemPrefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function defaults(): CrosshairSettings {
  return { ...DEFAULT_CROSSHAIR, reducedMotion: systemPrefersReducedMotion() };
}

/** Persisted settings, defensively validated field by field. */
export function loadCrosshairSettings(): CrosshairSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<CrosshairSettings>;
    // Legacy record still holding the OLD untouched defaults (white dot, 100 %): the player
    // never customized anything → they get the new default look.
    const legacyUntouched =
      parsed.shape === "DOT" &&
      parsed.scale === 1 &&
      typeof parsed.color === "string" &&
      parsed.color.toLowerCase() === "#ffffff" &&
      parsed.highContrast === undefined;
    if (legacyUntouched) return defaults();
    return {
      shape: parsed.shape === "CROSS" ? "CROSS" : parsed.shape === "DOT" ? "DOT" : "STICKER",
      scale:
        typeof parsed.scale === "number" && Number.isFinite(parsed.scale)
          ? Math.min(CROSSHAIR_SCALE_MAX, Math.max(CROSSHAIR_SCALE_MIN, parsed.scale))
          : DEFAULT_CROSSHAIR.scale,
      color:
        typeof parsed.color === "string" && HEX_COLOR.test(parsed.color)
          ? parsed.color.toLowerCase()
          : DEFAULT_CROSSHAIR.color,
      highContrast: parsed.highContrast === true,
      reducedMotion:
        typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : systemPrefersReducedMotion(),
    };
  } catch {
    return defaults();
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
  el.classList.toggle("sticker", settings.shape === "STICKER");
  el.classList.toggle("cross", settings.shape === "CROSS");
  el.style.setProperty("--ch-scale", String(settings.scale));
  el.style.setProperty("--ch-color", settings.color);
  // The hitmarker lives outside #crosshair: it follows the same size through :root.
  document.documentElement.style.setProperty("--ch-scale", String(settings.scale));
  document.body.classList.toggle("ch-contrast", settings.highContrast);
  document.body.classList.toggle("ch-reduced", settings.reducedMotion);
}
