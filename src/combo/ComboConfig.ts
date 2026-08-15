/**
 * Central configuration for the kill-combo system.
 * All timings/intensities live here — no magic numbers in components.
 */
export const ComboConfig = {
  /** Seconds the player has to land the next kill before the combo ends. */
  comboDuration: 5.0,

  // ---- Combo audio layer (subtle energetic hum while a combo is active) ----
  /** Fade-out (seconds) when the combo ends — never a hard cutoff. */
  comboAudioFadeOut: 0.25,
  /** Hum volume at combo x1. */
  comboHumBaseVolume: 0.045,
  /** Extra hum volume per additional combo level. */
  comboHumVolumePerLevel: 0.012,
  /** Hum volume ceiling (keeps the layer discreet). */
  comboHumMaxVolume: 0.11,
  /** Hum playback rate at combo x1. */
  comboHumBaseRate: 0.9,
  /** Extra hum rate per additional combo level (tension rises slightly). */
  comboHumRatePerLevel: 0.06,
  /** Hum rate ceiling. */
  comboHumMaxRate: 1.45,
} as const;