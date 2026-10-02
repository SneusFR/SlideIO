import { GivreConfig } from "../world/GivreConfig";

/**
 * Cel-shading outline settings (GIVRE map — GivreOutlinePass).
 *
 * Same persistence pattern as CrosshairSettings / GraphicsQuality: a tiny
 * localStorage record, defensively parsed. Only the player-facing knobs
 * are persisted (on/off, thickness, intensity); the detection tuning
 * (thresholds, fade, colour) keeps the GivreConfig defaults and can be
 * tweaked live in dev builds through `window.givreOutline` (see Game).
 * `debugEdges` is a session-only debug view (never persisted).
 *
 * Everything applies LIVE (no reload): the pass reads its uniforms every
 * frame.
 */
export interface OutlineSettings {
  enabled: boolean;
  /** CSS pixels (1 ≈ 2 px line). */
  thickness: number;
  /** Max rim opacity 0..1. */
  intensity: number;
  /** Debug: show the detected edges only (session only). */
  debugEdges: boolean;
}

const STORAGE_KEY = "slideio.givreOutline";

/** Slider bounds — mirrored in index.html. */
export const OUTLINE_THICKNESS_MIN = 0.5;
export const OUTLINE_THICKNESS_MAX = 3;

export const DEFAULT_OUTLINE: OutlineSettings = {
  enabled: true,
  thickness: GivreConfig.outline.thickness,
  intensity: GivreConfig.outline.intensity,
  debugEdges: false,
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Persisted settings, validated field by field (debugEdges always off). */
export function loadOutlineSettings(): OutlineSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OUTLINE };
    const parsed = JSON.parse(raw) as Partial<OutlineSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_OUTLINE.enabled,
      thickness:
        typeof parsed.thickness === "number" && Number.isFinite(parsed.thickness)
          ? clamp(parsed.thickness, OUTLINE_THICKNESS_MIN, OUTLINE_THICKNESS_MAX)
          : DEFAULT_OUTLINE.thickness,
      intensity:
        typeof parsed.intensity === "number" && Number.isFinite(parsed.intensity)
          ? clamp(parsed.intensity, 0, 1)
          : DEFAULT_OUTLINE.intensity,
      debugEdges: false,
    };
  } catch {
    return { ...DEFAULT_OUTLINE };
  }
}

export function saveOutlineSettings(settings: OutlineSettings): void {
  try {
    const { enabled, thickness, intensity } = settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, thickness, intensity }));
  } catch {
    /* storage unavailable — the session keeps its live settings */
  }
}
