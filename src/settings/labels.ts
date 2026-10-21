import type {
  AntiAliasing,
  Anisotropy,
  FpsCapSetting,
  FpsTargetSetting,
  GraphicsCaps,
  GraphicsKey,
  GraphicsValues,
  ParticleDensity,
  PresetChoice,
  ShadowMode,
  ShadowQuality,
  SnowLevel,
} from "./GraphicsSettings";
import { effectiveAntialiasing, resolveFpsCap } from "./GraphicsSettings";

/**
 * Player-facing labels of every option value (the settings page, the reload
 * bar, the detection summary). Written in natural case: the page shows its
 * short labels in uppercase through CSS, like the rest of the menu, while
 * aria-labels and sentences keep the readable form.
 */
export const PRESET_LABELS: Record<PresetChoice, string> = {
  auto: "Auto",
  bas: "Low",
  moyen: "Medium",
  eleve: "High",
  ultra: "Ultra",
  custom: "Custom",
};

export const AA_LABELS: Record<AntiAliasing, string> = {
  none: "Off",
  fxaa: "FXAA",
  msaa2: "MSAA 2×",
  msaa4: "MSAA 4×",
};

export const SHADOW_LABELS: Record<ShadowMode, string> = {
  off: "Off",
  static: "Static",
  dynamic: "Dynamic",
};

export const SHADOW_QUALITY_LABELS: Record<ShadowQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

export const SNOW_LABELS: Record<SnowLevel, string> = {
  off: "Off",
  legere: "Light",
  normale: "Normal",
  dense: "Dense",
};

export const PARTICLE_LABELS: Record<ParticleDensity, string> = {
  reduced: "Reduced",
  normal: "Normal",
};

export const ANISOTROPY_LABELS: Record<Anisotropy, string> = {
  1: "1×",
  2: "2×",
  4: "4×",
  8: "8×",
  16: "16×",
};

/** Name of each setting (row names, reload notices, summaries). */
export const SETTING_NAMES: Record<GraphicsKey, string> = {
  renderScale: "Render resolution",
  antialiasing: "Anti-aliasing",
  shadows: "Shadows",
  shadowQuality: "Shadow quality",
  characterShadows: "Character shadows",
  snow: "Snow",
  halos: "Light halos",
  footprints: "Snow footprints",
  particles: "Particles",
  anisotropy: "Anisotropic filtering",
};

/** Fixed decimals: 16.7 */
export function formatNumber(n: number, digits = 0): string {
  return n.toFixed(digits);
}

/** "85%" */
export function formatPercent(scale: number): string {
  return `${Math.round(scale)}%`;
}

export function fpsCapLabel(cap: FpsCapSetting, preset: PresetChoice): string {
  if (cap === "auto") {
    const r = resolveFpsCap(cap, preset);
    return `Auto (${Number.isFinite(r) ? r : "off"})`;
  }
  return cap === 0 ? "Off" : String(cap);
}

/** Detection target choices: "Screen (144)", "60 FPS"… (no "Hz": the page shows them in uppercase). */
export function fpsTargetLabel(target: FpsTargetSetting, refreshHz: number): string {
  return target === "display" ? `Screen (${Math.round(refreshHz)})` : `${target} FPS`;
}

/** Value of one setting, as shown in a sentence. */
export function valueLabel<K extends GraphicsKey>(key: K, value: GraphicsValues[K]): string {
  switch (key) {
    case "renderScale":
      return formatPercent(value as number);
    case "antialiasing":
      return AA_LABELS[value as AntiAliasing];
    case "shadows":
      return SHADOW_LABELS[value as ShadowMode];
    case "shadowQuality":
      return SHADOW_QUALITY_LABELS[value as ShadowQuality];
    case "snow":
      return SNOW_LABELS[value as SnowLevel];
    case "particles":
      return PARTICLE_LABELS[value as ParticleDensity];
    case "anisotropy":
      return ANISOTROPY_LABELS[value as Anisotropy];
    default:
      return value ? "On" : "Off";
  }
}

/**
 * Short description of a set of values: "100% resolution, FXAA, static
 * shadows (high), normal snow, 4× filtering" — only the settings this map
 * uses.
 */
export function describeValues(v: GraphicsValues, caps: Pick<GraphicsCaps, "composer" | "snow" | "halos" | "anisotropicTextures">): string {
  const parts: string[] = [`${formatPercent(v.renderScale)} resolution`];
  const aa = effectiveAntialiasing(v.antialiasing, caps);
  parts.push(aa === "none" ? "no anti-aliasing" : AA_LABELS[aa]);
  if (v.shadows === "off") parts.push("no shadows");
  else {
    const q = SHADOW_QUALITY_LABELS[v.shadowQuality].toLowerCase();
    parts.push(`${v.shadows === "static" ? "static" : "dynamic"} shadows (${q})`);
  }
  if (caps.snow) parts.push(v.snow === "off" ? "no snow" : `${SNOW_LABELS[v.snow].toLowerCase()} snow`);
  if (caps.halos && !v.halos) parts.push("no halos");
  if (caps.anisotropicTextures) parts.push(`${ANISOTROPY_LABELS[v.anisotropy]} filtering`);
  if (v.particles === "reduced") parts.push("reduced particles");
  return parts.join(", ");
}
