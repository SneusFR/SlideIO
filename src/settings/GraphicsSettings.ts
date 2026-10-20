/**
 * GRAPHICS SETTINGS MODEL — pure (no DOM, no three.js, no storage).
 *
 * Every graphics option the player can set, the named PRESETS (bundles of
 * values), the effective values of a stored choice, the "beauty floor" the
 * automatic detection never goes under, and which changes the running session
 * can apply LIVE versus at the next load.
 *
 * Render scale is a percentage of the NATIVE resolution (CSS size ×
 * devicePixelRatio, per axis). The old presets capped the pixel ratio instead
 * (LOW: 1, HIGH: 2): a preset therefore resolves its scale for the display it
 * runs on — Bas renders exactly one pixel per CSS pixel on every screen
 * (80 % of native at Windows 125 %, 50 % on a Retina screen), Élevé two at
 * most — the very images the old LOW / HIGH presets produced.
 */

export type PresetId = "bas" | "moyen" | "eleve" | "ultra";
/** What the player picked in the preset row ("custom" = Personnalisé). */
export type PresetChoice = "auto" | PresetId | "custom";
export type AntiAliasing = "none" | "fxaa" | "msaa2" | "msaa4";
export type ShadowMode = "off" | "static" | "dynamic";
export type ShadowQuality = "low" | "medium" | "high" | "ultra";
/** Same values as GivreSnow's GivreSnowLevel (kept structural: no world import here). */
export type SnowLevel = "off" | "legere" | "normale" | "dense";
export type ParticleDensity = "reduced" | "normal";
export type EffectLights = 0 | 1 | 2;
export type Anisotropy = 1 | 2 | 4 | 8 | 16;

export interface GraphicsValues {
  /** % of the native resolution per axis (50…150). */
  renderScale: number;
  antialiasing: AntiAliasing;
  shadows: ShadowMode;
  /** Shadow map size tier (per map: see shadowMapTierSize). */
  shadowQuality: ShadowQuality;
  /** Characters, held weapons and moving targets cast shadows (dynamic shadows only). */
  characterShadows: boolean;
  /** Pooled point lights the weapon / impact effects may use (each one is shaded on every lit pixel). */
  effectLights: EffectLights;
  snow: SnowLevel;
  halos: boolean;
  footprints: boolean;
  particles: ParticleDensity;
  anisotropy: Anisotropy;
}

export type GraphicsKey = keyof GraphicsValues;

/** What the preset resolution depends on. */
export interface DisplayEnv {
  /** window.devicePixelRatio (browser zoom included). */
  dpr: number;
}

export const ANTIALIASING: readonly AntiAliasing[] = ["none", "fxaa", "msaa2", "msaa4"];
export const SHADOW_MODES: readonly ShadowMode[] = ["off", "static", "dynamic"];
export const SHADOW_QUALITIES: readonly ShadowQuality[] = ["low", "medium", "high", "ultra"];
export const SNOW_LEVELS: readonly SnowLevel[] = ["off", "legere", "normale", "dense"];
export const PARTICLE_DENSITIES: readonly ParticleDensity[] = ["reduced", "normal"];
export const EFFECT_LIGHTS: readonly EffectLights[] = [0, 1, 2];
export const ANISOTROPY_LEVELS: readonly Anisotropy[] = [1, 2, 4, 8, 16];
export const PRESET_IDS: readonly PresetId[] = ["bas", "moyen", "eleve", "ultra"];
export const PRESET_CHOICES: readonly PresetChoice[] = ["auto", "bas", "moyen", "eleve", "ultra", "custom"];

/** Render scale slider bounds (%). Above 100 = supersampling (strong GPUs only). */
export const RENDER_SCALE_MIN = 50;
export const RENDER_SCALE_MAX = 150;
export const RENDER_SCALE_STEP = 5;

/**
 * Shadow map size of each tier, longest side, per map family. "medium" and
 * "high" are the old LOW and HIGH sizes (Jungle / Yard 1024 / 2048 square;
 * Givre 2048 / 4096, rectangular: GivreMap fits the other side to the map's
 * aspect seen from the sun).
 */
export const SHADOW_TIER_SIZE: Record<"givre" | "other", Record<ShadowQuality, number>> = {
  givre: { low: 1024, medium: 2048, high: 4096, ultra: 8192 },
  other: { low: 512, medium: 1024, high: 2048, ultra: 4096 },
};

export function shadowMapTierSize(quality: ShadowQuality, givre: boolean): number {
  return SHADOW_TIER_SIZE[givre ? "givre" : "other"][quality];
}

/** Render scale (% of native) of a pixel-ratio cap on this display: never above 100 %. */
export function scaleForPixelCap(cap: number, dpr: number): number {
  const d = sanitizeDpr(dpr);
  return Math.min(100, (cap / d) * 100);
}

/**
 * Renderer pixel ratio of a render scale. Snapped to 1e-6 so a preset that
 * means "one pixel per CSS pixel" gives exactly 1 (100 / 1.5 × 1.5 is not
 * exactly 100 in floating point; the canvas size is floored from it).
 */
export function pixelRatioFor(renderScale: number, dpr: number): number {
  const ratio = (sanitizeDpr(dpr) * renderScale) / 100;
  return Math.max(0.25, Math.round(ratio * 1e6) / 1e6);
}

function sanitizeDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

interface PresetDef {
  /** Pixel-ratio cap (null = native resolution on every display). */
  pixelCap: number | null;
  values: Omit<GraphicsValues, "renderScale">;
}

/**
 * The named presets. "bas" and "eleve" are EXACTLY the old LOW and HIGH
 * presets (pixel cap 1 / 2, FXAA vs MSAA 4×, static vs live shadows with the
 * characters, LOW / HIGH shadow sizes, anisotropy 1 / 8) plus the defaults of
 * the settings that used to live apart (snow "normale", halos, footprints,
 * the 2 pooled effect lights): players who never open the page see the same
 * game. "moyen" sits between them for entry-level discrete GPUs; "ultra"
 * spends what a strong GPU has left (native resolution on high-DPI screens,
 * twice the shadow resolution, 16× anisotropy, dense snow).
 */
const PRESET_DEFS: Record<PresetId, PresetDef> = {
  bas: {
    pixelCap: 1,
    values: {
      antialiasing: "fxaa",
      shadows: "static",
      shadowQuality: "medium",
      characterShadows: false,
      effectLights: 2,
      snow: "normale",
      halos: true,
      footprints: true,
      particles: "normal",
      anisotropy: 1,
    },
  },
  moyen: {
    pixelCap: 1.5,
    values: {
      antialiasing: "msaa2",
      shadows: "dynamic",
      shadowQuality: "medium",
      characterShadows: true,
      effectLights: 2,
      snow: "normale",
      halos: true,
      footprints: true,
      particles: "normal",
      anisotropy: 4,
    },
  },
  eleve: {
    pixelCap: 2,
    values: {
      antialiasing: "msaa4",
      shadows: "dynamic",
      shadowQuality: "high",
      characterShadows: true,
      effectLights: 2,
      snow: "normale",
      halos: true,
      footprints: true,
      particles: "normal",
      anisotropy: 8,
    },
  },
  ultra: {
    pixelCap: null,
    values: {
      antialiasing: "msaa4",
      shadows: "dynamic",
      shadowQuality: "ultra",
      characterShadows: true,
      effectLights: 2,
      snow: "dense",
      halos: true,
      footprints: true,
      particles: "normal",
      anisotropy: 16,
    },
  },
};

/** The values of a preset on this display. */
export function presetValues(id: PresetId, env: DisplayEnv): GraphicsValues {
  const def = PRESET_DEFS[id];
  return {
    renderScale: def.pixelCap === null ? 100 : scaleForPixelCap(def.pixelCap, env.dpr),
    ...def.values,
  };
}

/** Pixel-ratio cap of a preset (null = native). The debug panel and the facade use it. */
export function presetPixelCap(id: PresetId): number | null {
  return PRESET_DEFS[id].pixelCap;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

export function sameValues(a: GraphicsValues, b: GraphicsValues): boolean {
  return (
    near(a.renderScale, b.renderScale) &&
    a.antialiasing === b.antialiasing &&
    a.shadows === b.shadows &&
    a.shadowQuality === b.shadowQuality &&
    a.characterShadows === b.characterShadows &&
    a.effectLights === b.effectLights &&
    a.snow === b.snow &&
    a.halos === b.halos &&
    a.footprints === b.footprints &&
    a.particles === b.particles &&
    a.anisotropy === b.anisotropy
  );
}

/** The named preset these values are exactly, on this display (null = none). */
export function matchPreset(values: GraphicsValues, env: DisplayEnv): PresetId | null {
  for (const id of PRESET_IDS) if (sameValues(values, presetValues(id, env))) return id;
  return null;
}

const pick = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Field-by-field validation of untrusted data (storage); missing / bad fields take `fallback`'s. */
export function sanitizeGraphicsValues(raw: unknown, fallback: GraphicsValues): GraphicsValues {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const scale = r.renderScale;
  return {
    renderScale:
      typeof scale === "number" && Number.isFinite(scale)
        ? Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, scale))
        : fallback.renderScale,
    antialiasing: pick(ANTIALIASING, r.antialiasing, fallback.antialiasing),
    shadows: pick(SHADOW_MODES, r.shadows, fallback.shadows),
    shadowQuality: pick(SHADOW_QUALITIES, r.shadowQuality, fallback.shadowQuality),
    characterShadows: typeof r.characterShadows === "boolean" ? r.characterShadows : fallback.characterShadows,
    effectLights: pick(EFFECT_LIGHTS, r.effectLights, fallback.effectLights),
    snow: pick(SNOW_LEVELS, r.snow, fallback.snow),
    halos: typeof r.halos === "boolean" ? r.halos : fallback.halos,
    footprints: typeof r.footprints === "boolean" ? r.footprints : fallback.footprints,
    particles: pick(PARTICLE_DENSITIES, r.particles, fallback.particles),
    anisotropy: pick(ANISOTROPY_LEVELS, r.anisotropy, fallback.anisotropy),
  };
}

// ---------------------------------------------------------------- choice

/** Result of an automatic detection, stored with the choice "auto". */
export interface AutoResult {
  values: GraphicsValues;
  /** Date.now() of the detection. */
  at: number;
  /** GPU the detection measured (a different GPU → detect again). */
  gpu: string;
  /** Frame rate the detection aimed at. */
  targetFps: number;
  /** Frame rate expected with the chosen values (measured), null when unknown. */
  expectedFps: number | null;
  /** What limits this machine at the chosen values. */
  limitedBy: "gpu" | "cpu" | "none";
  /** True when even the beauty floor misses the target. */
  belowTarget: boolean;
  /** French summary shown in the page. */
  summary: string;
  /** Algorithm version (a newer detection logic re-detects). */
  version: number;
}

export interface GraphicsChoice {
  preset: PresetChoice;
  /** Values of "Personnalisé" (null until the player edits something). */
  custom: GraphicsValues | null;
  /** Last automatic detection (kept when the player switches to another preset). */
  auto: AutoResult | null;
}

/** Version of the auto-detection logic: bump it to re-detect every "auto" player once. */
export const AUTO_TUNE_VERSION = 1;

/** What the "auto" choice resolves to before (or without) a usable detection. */
export interface GpuHint {
  /** Name of the GPU the session runs on ("" when masked / unknown). */
  name: string;
  /** Integrated / mobile / software GPU (the old AUTO heuristic: LOW for those). */
  weak: boolean;
}

/** True when the stored detection can be used on this GPU. */
export function autoResultUsable(auto: AutoResult | null, gpu: GpuHint): auto is AutoResult {
  return auto !== null && auto.version === AUTO_TUNE_VERSION && auto.gpu === gpu.name;
}

/**
 * Effective values of a choice on this display. "auto" without a usable
 * detection = the old AUTO behaviour: Bas on weak GPUs, Élevé elsewhere.
 */
export function effectiveValues(choice: GraphicsChoice, env: DisplayEnv, gpu: GpuHint): GraphicsValues {
  switch (choice.preset) {
    case "custom":
      return choice.custom ? sanitizeGraphicsValues(choice.custom, presetValues("eleve", env)) : heuristicValues(env, gpu);
    case "auto":
      return autoResultUsable(choice.auto, gpu)
        ? sanitizeGraphicsValues(choice.auto.values, heuristicValues(env, gpu))
        : heuristicValues(env, gpu);
    default:
      return presetValues(choice.preset, env);
  }
}

export function heuristicValues(env: DisplayEnv, gpu: GpuHint): GraphicsValues {
  return presetValues(gpu.weak ? "bas" : "eleve", env);
}

/**
 * The preset a choice really stands for: "auto" before any usable detection
 * IS the old heuristic preset (Bas on weak GPUs) — for the frame cap too
 * ("auto" cap: Bas → 60), exactly like the old AUTO + AUTO cap.
 */
export function effectivePreset(choice: GraphicsChoice, gpu: GpuHint): PresetChoice {
  if (choice.preset === "auto" && !autoResultUsable(choice.auto, gpu)) return gpu.weak ? "bas" : "eleve";
  if (choice.preset === "custom" && !choice.custom) return gpu.weak ? "bas" : "eleve";
  return choice.preset;
}

/**
 * The choice after the player edited one value: "Personnalisé" with the
 * current effective values and the edit — or, when the result is exactly a
 * named preset (an edit undone), that preset.
 */
export function editChoice<K extends GraphicsKey>(
  choice: GraphicsChoice,
  key: K,
  value: GraphicsValues[K],
  env: DisplayEnv,
  gpu: GpuHint,
): GraphicsChoice {
  const values = { ...effectiveValues(choice, env, gpu), [key]: value } as GraphicsValues;
  const named = matchPreset(values, env);
  if (named) return { ...choice, preset: named, custom: choice.custom };
  return { ...choice, preset: "custom", custom: values };
}

// ---------------------------------------------------------------- floor

/**
 * BEAUTY FLOOR — the automatic detection (and the dynamic resolution) never
 * go under it, whatever the machine. The player can still go lower by hand.
 *   - render scale: 80 % of native, but never more than one pixel per CSS
 *     pixel (a Retina screen at 50 % is still the sharpness of a normal
 *     screen; Windows 125 % at 80 % = exactly the old LOW resolution);
 *   - anti-aliasing: FXAA at least (where the map has a post chain);
 *   - shadows: kept (never switched off automatically);
 *   - snow: light at least; bulb halos and footprints kept;
 *   - anisotropy 1×, shadow quality "medium" (the old LOW size), reduced
 *     particles: cheap to see.
 */
export function floorRenderScale(env: DisplayEnv): number {
  return Math.max(RENDER_SCALE_MIN, Math.min(80, 100 / sanitizeDpr(env.dpr)));
}

export const FLOOR = {
  antialiasing: "fxaa" as AntiAliasing,
  snow: "legere" as SnowLevel,
  shadowQuality: "medium" as ShadowQuality,
  anisotropy: 1 as Anisotropy,
  particles: "reduced" as ParticleDensity,
};

// ---------------------------------------------------------- capabilities

/** What the running map / renderer can do (filled by the Game). */
export interface GraphicsCaps {
  /** Givre: the post chain (composer) — anti-aliasing changes are live there. */
  composer: boolean;
  /** Map has falling snow / bulb halos / snow footprints (Givre). */
  snow: boolean;
  halos: boolean;
  footprints: boolean;
  /** Shadow-casting sun (every map today). */
  shadows: boolean;
  /** Highest MSAA sample count of the GPU (0 = none). */
  maxSamples: number;
  /** Largest texture side (caps the shadow tiers). */
  maxTextureSize: number;
  /** Highest shadow tier whose map fits the GPU's texture size limit. */
  maxShadowQuality: ShadowQuality;
  /** Max anisotropy of the GPU (1 = no extension). */
  maxAnisotropy: number;
  /** Map uses mipmapped world textures (anisotropy has a visible effect: Givre). */
  anisotropicTextures: boolean;
  /** Pooled effect lights of the scene (the max of the option). */
  effectLightPool: number;
}

/** Defaults for headless code (tests): a Givre-like map on a capable GPU. */
export const DEFAULT_CAPS: GraphicsCaps = {
  composer: true,
  snow: true,
  halos: true,
  footprints: true,
  shadows: true,
  maxSamples: 4,
  maxTextureSize: 16384,
  maxShadowQuality: "ultra",
  maxAnisotropy: 16,
  anisotropicTextures: true,
  effectLightPool: 2,
};

/** MSAA sample count of an anti-aliasing choice, clamped to the GPU (Givre composer). */
export function msaaSamples(aa: AntiAliasing, maxSamples = 4): number {
  const n = aa === "msaa4" ? 4 : aa === "msaa2" ? 2 : 0;
  return Math.min(n, Math.max(0, maxSamples));
}

/** True when the anti-aliasing is MSAA (maps without a post chain: the context's MSAA). */
export function isMsaa(aa: AntiAliasing): boolean {
  return aa === "msaa2" || aa === "msaa4";
}

/**
 * Anti-aliasing really drawn on this map: maps without a post chain have no
 * FXAA (→ none) and only the context's MSAA (the browser picks the samples).
 */
export function effectiveAntialiasing(aa: AntiAliasing, caps: Pick<GraphicsCaps, "composer">): AntiAliasing {
  if (caps.composer) return aa;
  return isMsaa(aa) ? "msaa4" : "none";
}

// -------------------------------------------------------- live / reload

/** A setting the running session cannot change: it applies at the next load. */
export interface ReloadChange {
  key: GraphicsKey;
  /** The value the session runs with. */
  from: GraphicsValues[GraphicsKey];
  /** The stored value, applied after a reload. */
  to: GraphicsValues[GraphicsKey];
}

/**
 * Which settings changed between the values the session booted with and the
 * stored ones, and need a reload to take effect:
 *   - shadow mode and character shadows: every lit shader (and the shadow
 *     casters' depth shaders) depend on them — switching live would compile
 *     dozens of programs mid-session (PERFORMANCE.md, rule 12);
 *   - effect lights: the scene's light count is part of every lit program;
 *   - MSAA on maps without a post chain: a WebGL context attribute.
 * Everything else (resolution, Givre anti-aliasing, shadow resolution, snow,
 * halos, footprints, particles, anisotropy) is applied live, without any
 * shader compile.
 */
export function reloadChanges(boot: GraphicsValues, next: GraphicsValues, caps: Pick<GraphicsCaps, "composer">): ReloadChange[] {
  const out: ReloadChange[] = [];
  const add = (key: GraphicsKey): void => {
    out.push({ key, from: boot[key], to: next[key] });
  };
  if (boot.shadows !== next.shadows) add("shadows");
  // Character shadows only matter with dynamic shadows (both sides).
  const castBoot = boot.shadows === "dynamic" && boot.characterShadows;
  const castNext = next.shadows === "dynamic" && next.characterShadows;
  if (castBoot !== castNext && boot.shadows === next.shadows) add("characterShadows");
  if (boot.effectLights !== next.effectLights) add("effectLights");
  if (!caps.composer && isMsaa(boot.antialiasing) !== isMsaa(next.antialiasing)) add("antialiasing");
  return out;
}

/** The values the session can show now: live fields from `next`, reload-only fields kept from `boot`. */
export function liveValues(boot: GraphicsValues, next: GraphicsValues, caps: Pick<GraphicsCaps, "composer">): GraphicsValues {
  const v = { ...next };
  v.shadows = boot.shadows;
  v.characterShadows = boot.characterShadows;
  v.effectLights = boot.effectLights;
  if (!caps.composer) v.antialiasing = boot.antialiasing;
  return v;
}

// ------------------------------------------------------------- FPS cap

/** Frame-rate cap: "auto" follows the preset (Bas → 60, the rest → uncapped), 0 = unlimited. */
export type FpsCapSetting = "auto" | 0 | 30 | 60 | 120 | 144 | 165 | 240;
export const FPS_CAPS: readonly FpsCapSetting[] = ["auto", 30, 60, 120, 144, 165, 240, 0];

/**
 * Frames per second the loop is capped at (Infinity = uncapped). "auto" =
 * the old AUTO mode: the Bas preset (old LOW) caps at 60 to spare laptops
 * running on battery, everything else runs at the display's own rate.
 */
export function resolveFpsCap(cap: FpsCapSetting, preset: PresetChoice): number {
  if (cap === "auto") return preset === "bas" ? 60 : Infinity;
  return cap === 0 ? Infinity : cap;
}

/** Detection / dynamic resolution target: the display's rate or a fixed one. */
export type FpsTargetSetting = "display" | 60 | 120 | 144 | 240;
export const FPS_TARGETS: readonly FpsTargetSetting[] = ["display", 60, 120, 144, 240];

/** Common display rates: a measured interval is snapped to the nearest one within 4 %. */
const DISPLAY_RATES = [50, 60, 75, 90, 100, 120, 144, 165, 175, 180, 200, 240, 280, 360];

export function snapRefreshRate(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return 60;
  let best = hz;
  let bestErr = Infinity;
  for (const r of DISPLAY_RATES) {
    const err = Math.abs(hz - r) / r;
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return bestErr <= 0.04 ? best : Math.round(hz);
}

/**
 * Frame rate the detection aims at: the display's rate (or the chosen target),
 * never below 60, never above 240 — and never above a lower frame-rate cap
 * the player set (aiming past the cap is pointless).
 */
export function targetFps(setting: FpsTargetSetting, refreshHz: number, capFps: number): number {
  const base = setting === "display" ? snapRefreshRate(refreshHz) : setting;
  const capped = Math.min(base, Number.isFinite(capFps) && capFps > 0 ? capFps : Infinity);
  return Math.max(60, Math.min(240, capped));
}
