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

/** French labels of every option value (the settings page and the detection summary). */
export const PRESET_LABELS: Record<PresetChoice, string> = {
  auto: "Automatique",
  bas: "Bas",
  moyen: "Moyen",
  eleve: "Élevé",
  ultra: "Ultra",
  custom: "Personnalisé",
};

export const AA_LABELS: Record<AntiAliasing, string> = {
  none: "Aucun",
  fxaa: "FXAA",
  msaa2: "MSAA 2×",
  msaa4: "MSAA 4×",
};

export const SHADOW_LABELS: Record<ShadowMode, string> = {
  off: "Désactivées",
  static: "Statiques",
  dynamic: "Dynamiques",
};

export const SHADOW_QUALITY_LABELS: Record<ShadowQuality, string> = {
  low: "Basse",
  medium: "Moyenne",
  high: "Haute",
  ultra: "Très haute",
};

export const SNOW_LABELS: Record<SnowLevel, string> = {
  off: "Désactivée",
  legere: "Légère",
  normale: "Normale",
  dense: "Dense",
};

export const PARTICLE_LABELS: Record<ParticleDensity, string> = {
  reduced: "Réduites",
  normal: "Normales",
};

export const ANISOTROPY_LABELS: Record<Anisotropy, string> = {
  1: "1×",
  2: "2×",
  4: "4×",
  8: "8×",
  16: "16×",
};

/** Name of each setting (reload notices, summaries). */
export const SETTING_NAMES: Record<GraphicsKey, string> = {
  renderScale: "Résolution de rendu",
  antialiasing: "Anticrénelage",
  shadows: "Ombres",
  shadowQuality: "Qualité des ombres",
  characterShadows: "Ombres des personnages",
  snow: "Neige",
  halos: "Halos des lumières",
  footprints: "Empreintes dans la neige",
  particles: "Particules",
  anisotropy: "Filtrage anisotrope",
};

/** French decimal: 16,7 */
export function frNumber(n: number, digits = 0): string {
  return n.toFixed(digits).replace(".", ",");
}

/** "85 %" (narrow no-break space, French typography). */
export function frPercent(scale: number): string {
  return `${Math.round(scale)}\u202f%`;
}

export function fpsCapLabel(cap: FpsCapSetting, preset: PresetChoice): string {
  if (cap === "auto") {
    const r = resolveFpsCap(cap, preset);
    return `Auto (${Number.isFinite(r) ? r : "aucune"})`;
  }
  return cap === 0 ? "Aucune" : String(cap);
}

export function fpsTargetLabel(target: FpsTargetSetting, refreshHz: number): string {
  return target === "display" ? `Écran (${Math.round(refreshHz)} Hz)` : `${target} FPS`;
}

/** Value of one setting, as shown in a sentence. */
export function valueLabel<K extends GraphicsKey>(key: K, value: GraphicsValues[K]): string {
  switch (key) {
    case "renderScale":
      return frPercent(value as number);
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
      return value ? "Oui" : "Non";
  }
}

/**
 * Short description of a set of values: "résolution 100 %, FXAA, ombres
 * statiques (haute), neige normale, filtrage 4×" — only the settings this map
 * uses.
 */
export function describeValues(v: GraphicsValues, caps: Pick<GraphicsCaps, "composer" | "snow" | "halos" | "anisotropicTextures">): string {
  const parts: string[] = [`résolution ${frPercent(v.renderScale)}`];
  const aa = effectiveAntialiasing(v.antialiasing, caps);
  parts.push(aa === "none" ? "sans anticrénelage" : AA_LABELS[aa]);
  if (v.shadows === "off") parts.push("sans ombres");
  else {
    const q = SHADOW_QUALITY_LABELS[v.shadowQuality].toLowerCase();
    parts.push(`ombres ${v.shadows === "static" ? "statiques" : "dynamiques"} (${q})`);
  }
  if (caps.snow) parts.push(v.snow === "off" ? "sans neige" : `neige ${SNOW_LABELS[v.snow].toLowerCase()}`);
  if (caps.halos && !v.halos) parts.push("sans halos");
  if (caps.anisotropicTextures) parts.push(`filtrage ${ANISOTROPY_LABELS[v.anisotropy]}`);
  if (v.particles === "reduced") parts.push("particules réduites");
  return parts.join(", ");
}
