import { GivreConfig } from "../world/GivreConfig";

/**
 * Cel-shading outline settings (GIVRE map — GivreOutlinePass).
 *
 * Only the player-facing knobs are persisted (on/off, thickness, intensity),
 * in the settings record (src/settings/SettingsStore — this module stays pure:
 * types, bounds, defaults, validation). The detection tuning (thresholds,
 * fade, colour) keeps the GivreConfig defaults and can be tweaked live in dev
 * builds through `window.givreDebug` (see Game). `debugEdges` is a
 * session-only debug view (never persisted).
 *
 * Everything applies LIVE (no reload): the pass reads its uniforms every
 * frame.
 */
export interface OutlineValues {
  enabled: boolean;
  /** CSS pixels (1 ≈ 2 px line). */
  thickness: number;
  /** Max rim opacity 0..1. */
  intensity: number;
}

export interface OutlineSettings extends OutlineValues {
  /** Debug: show the detected edges only (session only). */
  debugEdges: boolean;
}

/** Slider bounds (the settings page mirrors them). */
export const OUTLINE_THICKNESS_MIN = 0.5;
export const OUTLINE_THICKNESS_MAX = 3;

export const DEFAULT_OUTLINE_VALUES: OutlineValues = {
  enabled: true,
  thickness: GivreConfig.outline.thickness,
  intensity: GivreConfig.outline.intensity,
};

export const DEFAULT_OUTLINE: OutlineSettings = { ...DEFAULT_OUTLINE_VALUES, debugEdges: false };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Stored values, validated field by field (bad / missing fields → defaults). */
export function sanitizeOutlineValues(raw: unknown): OutlineValues {
  const parsed = raw && typeof raw === "object" ? (raw as Partial<OutlineValues>) : {};
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_OUTLINE_VALUES.enabled,
    thickness:
      typeof parsed.thickness === "number" && Number.isFinite(parsed.thickness)
        ? clamp(parsed.thickness, OUTLINE_THICKNESS_MIN, OUTLINE_THICKNESS_MAX)
        : DEFAULT_OUTLINE_VALUES.thickness,
    intensity:
      typeof parsed.intensity === "number" && Number.isFinite(parsed.intensity)
        ? clamp(parsed.intensity, 0, 1)
        : DEFAULT_OUTLINE_VALUES.intensity,
  };
}
