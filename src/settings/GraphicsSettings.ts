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
 * runs on — Low renders exactly one pixel per CSS pixel on every screen
 * (80 % of native at Windows 125 %, 50 % on a Retina screen), High two at
 * most — the very images the old LOW / HIGH presets produced.
 */

export type PresetId = "bas" | "moyen" | "eleve" | "ultra";
/** What the player picked in the preset row (ids: "bas" = Low, "moyen" = Medium, "eleve" = High). */
export type PresetChoice = "auto" | PresetId | "custom";
export type AntiAliasing = "none" | "fxaa" | "msaa2" | "msaa4";
export type ShadowMode = "off" | "static" | "dynamic";
export type ShadowQuality = "low" | "medium" | "high" | "ultra";
/** Same values as GivreSnow's GivreSnowLevel (kept structural: no world import here). */
export type SnowLevel = "off" | "legere" | "normale" | "dense";
export type ParticleDensity = "reduced" | "normal";
export type Anisotropy = 1 | 2 | 4 | 8 | 16;

export interface GraphicsValues {
  /** % of the native resolution per axis (RENDER_SCALE_MIN…RENDER_SCALE_MAX). */
  renderScale: number;
  antialiasing: AntiAliasing;
  shadows: ShadowMode;
  /** Shadow map size tier (per map family: see shadowMapTierSize). */
  shadowQuality: ShadowQuality;
  /** Characters, held weapons and moving targets cast shadows (dynamic shadows only). */
  characterShadows: boolean;
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
export const ANISOTROPY_LEVELS: readonly Anisotropy[] = [1, 2, 4, 8, 16];
export const PRESET_IDS: readonly PresetId[] = ["bas", "moyen", "eleve", "ultra"];
export const PRESET_CHOICES: readonly PresetChoice[] = ["auto", "bas", "moyen", "eleve", "ultra", "custom"];

/** Render scale slider bounds (%), 1 % steps. Above 100 = supersampling (strong GPUs only). */
export const RENDER_SCALE_MIN = 50;
export const RENDER_SCALE_MAX = 150;
export const RENDER_SCALE_STEP = 1;

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

function sanitizeDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** Render scale (% of native) of a pixel-ratio cap on this display: never above 100 %. */
export function scaleForPixelCap(cap: number, dpr: number): number {
  return Math.min(100, (cap / sanitizeDpr(dpr)) * 100);
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

interface PresetDef {
  /** Pixel-ratio cap (null = native resolution on every display). */
  pixelCap: number | null;
  values: Omit<GraphicsValues, "renderScale">;
}

/**
 * The named presets. "bas" and "eleve" are EXACTLY the old LOW and HIGH
 * presets (pixel cap 1 / 2, FXAA vs MSAA 4×, static vs live shadows with the
 * characters, LOW / HIGH shadow sizes, anisotropy 1 / 8) plus the defaults of
 * the settings that used to live apart (snow "normale", halos, footprints):
 * players who never open the page see the same game. "moyen" sits between
 * them (entry-level discrete GPUs); "ultra" spends what a strong GPU has left
 * (native resolution on high-DPI screens, twice the shadow resolution, 16×
 * filtering, dense snow).
 */
const PRESET_DEFS: Record<PresetId, PresetDef> = {
  bas: {
    pixelCap: 1,
    values: {
      antialiasing: "fxaa",
      shadows: "static",
      shadowQuality: "medium",
      characterShadows: false,
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

/** Pixel-ratio cap of a preset (null = native). */
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
    snow: pick(SNOW_LEVELS, r.snow, fallback.snow),
    halos: typeof r.halos === "boolean" ? r.halos : fallback.halos,
    footprints: typeof r.footprints === "boolean" ? r.footprints : fallback.footprints,
    particles: pick(PARTICLE_DENSITIES, r.particles, fallback.particles),
    anisotropy: pick(ANISOTROPY_LEVELS, r.anisotropy, fallback.anisotropy),
  };
}

// ---------------------------------------------------------------- choice

/** Result of an automatic detection (stored per map with the choice "auto"). */
export interface AutoResult {
  values: GraphicsValues;
  /** Date.now() of the detection. */
  at: number;
  /** GPU the detection measured (another GPU → detect again). */
  gpu: string;
  /** Map it was measured on (each map is measured on its first menu). */
  map: string;
  /** Frame rate the detection aimed at (another target → detect again). */
  targetFps: number;
  /**
   * Frame rate the chosen values hold with their margin (target / hard), or
   * the floor's (cpu / gpu); null when unknown.
   */
  measuredFps: number | null;
  /**
   * target: the target holds; hard: high-refresh screen, 60 FPS held — with
   * the default look, or below it only when even it missed 60 — the target
   * would need the image below that look; cpu: the processor limits (graphics
   * kept); gpu: even the floor misses 60 FPS.
   */
  mode: "target" | "hard" | "cpu" | "gpu";
  /** False when the detection was stopped before the end (detect again at the next launch). */
  complete: boolean;
  /** Shadow mode of the session that measured (a result that changes it is checked again after the reload). */
  measuredShadows: ShadowMode;
  /** Summary shown in the page (English; rewritten by the in-match guard when it lowers the values). */
  summary: string;
  /** Algorithm version (a newer detection logic detects again). */
  version: number;
  /**
   * In-match guard (settings/AutoGuard): rungs it has taken these values down
   * since the detection, each one kept because it helped (0 / absent = the
   * detection's answer as is). Only a new detection raises them again.
   */
  guardSteps?: number;
  /** Date.now() of the guard's last kept step (null / absent = none). */
  guardAt?: number | null;
  /** The detection's own answer: the guard climbs back towards it, never above (null / absent = `values`). */
  detected?: GraphicsValues | null;
  /** Date.now() from which ONE rung back up may be tried, at the start of a session (null = nothing to try). */
  guardRetryAt?: number | null;
  /** Tries one rung up that failed in a row (each doubles the wait before the next). */
  guardUpFails?: number;
}

export interface GraphicsChoice {
  preset: PresetChoice;
  /** Values of "Custom" (null until the player edits something). */
  custom: GraphicsValues | null;
  /** Last automatic detection of each map (kept when the player picks another preset). */
  auto: Record<string, AutoResult>;
}

/**
 * Version of the detection logic: bump it to detect again for every "auto" player once.
 * 2: integrated GPUs measured with +50 % pixels instead of +30 % (AUTO_TUNE.integratedMarginPixels).
 */
export const AUTO_TUNE_VERSION = 2;

/** What the "auto" choice resolves to before (or without) a usable detection. */
export interface GpuHint {
  /** Name of the GPU the session runs on ("" when masked / unknown). */
  name: string;
  /** Integrated / mobile / software GPU (the old AUTO heuristic: LOW for those). */
  weak: boolean;
}

/** The stored detection usable for this GPU and map (null = none). */
export function autoResultFor(choice: GraphicsChoice, gpu: GpuHint, map: string): AutoResult | null {
  const r = choice.auto[map];
  return r && r.version === AUTO_TUNE_VERSION && r.gpu === gpu.name ? r : null;
}

/** The old AUTO behaviour: Low on weak GPUs, High elsewhere. */
export function heuristicPreset(gpu: GpuHint): PresetId {
  return gpu.weak ? "bas" : "eleve";
}

/** Effective values of a choice on this display ("auto" without a detection = the old AUTO). */
export function effectiveValues(choice: GraphicsChoice, env: DisplayEnv, gpu: GpuHint, map: string): GraphicsValues {
  const heuristic = presetValues(heuristicPreset(gpu), env);
  switch (choice.preset) {
    case "custom":
      return choice.custom ? sanitizeGraphicsValues(choice.custom, heuristic) : heuristic;
    case "auto": {
      const r = autoResultFor(choice, gpu, map);
      return r ? sanitizeGraphicsValues(r.values, heuristic) : heuristic;
    }
    default:
      return presetValues(choice.preset, env);
  }
}

/**
 * The preset a choice really stands for: "auto" before any usable detection
 * IS the old heuristic preset (Low on weak GPUs) — for the frame cap too
 * ("auto" cap: Low → 60), exactly like the old AUTO + AUTO cap.
 */
export function effectivePreset(choice: GraphicsChoice, gpu: GpuHint, map: string): PresetChoice {
  if (choice.preset === "auto" && !autoResultFor(choice, gpu, map)) return heuristicPreset(gpu);
  if (choice.preset === "custom" && !choice.custom) return heuristicPreset(gpu);
  return choice.preset;
}

/**
 * The choice after the player edited one value: "Custom" with the
 * current effective values and the edit — or, when the result is exactly a
 * named preset (an edit undone), that preset. The detections stay stored.
 * `base`: the values on screen when they differ from the stored choice's (a
 * step of the in-match guard not stored yet — GraphicsController.effective).
 */
export function editChoice<K extends GraphicsKey>(
  choice: GraphicsChoice,
  key: K,
  value: GraphicsValues[K],
  env: DisplayEnv,
  gpu: GpuHint,
  map: string,
  base: GraphicsValues = effectiveValues(choice, env, gpu, map),
): GraphicsChoice {
  const values = { ...base, [key]: value } as GraphicsValues;
  const named = matchPreset(values, env);
  if (named) return { ...choice, preset: named };
  return { ...choice, preset: "custom", custom: values };
}

/**
 * True when "Auto" should measure this machine now: no detection of
 * this GPU / map / target yet, an interrupted one, an older logic, or a
 * result that changed the shadow mode (measured again once it is in effect).
 */
export function needsDetection(
  choice: GraphicsChoice,
  gpu: GpuHint,
  map: string,
  targetFps: number,
  bootShadows: ShadowMode,
): boolean {
  if (choice.preset !== "auto") return false;
  const r = autoResultFor(choice, gpu, map);
  if (!r || !r.complete || r.targetFps !== targetFps) return true;
  return r.values.shadows !== r.measuredShadows && r.values.shadows === bootShadows;
}

// ---------------------------------------------------------------- floor

/**
 * BEAUTY FLOOR — the automatic detection never goes under it, whatever the
 * machine (the player still can, by hand). It is the old LOW look:
 *   - render scale: one pixel per CSS pixel (the old LOW resolution: 100 %
 *     at 100 % zoom, 80 % at Windows 125 %, 50 % on a Retina screen), never
 *     under the slider's 50 %;
 *   - anti-aliasing: FXAA (where the map has a post chain);
 *   - shadows: kept (the shadow mode never changes live), the old LOW map
 *     size with live shadows;
 *   - snow: light at least; bulb halos and footprints kept; particles kept;
 *   - anisotropic filtering 1× (the old LOW).
 */
export function floorRenderScale(env: DisplayEnv): number {
  return Math.max(RENDER_SCALE_MIN, Math.min(100, 100 / sanitizeDpr(env.dpr)));
}

export const FLOOR = {
  antialiasing: "fxaa" as AntiAliasing,
  snow: "legere" as SnowLevel,
  shadowQuality: "medium" as ShadowQuality,
  anisotropy: 1 as Anisotropy,
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
 *   - shadow mode and character shadows: switching them live would compile
 *     dozens of programs mid-session (shadow code in every lit shader, the
 *     casters' depth programs — PERFORMANCE.md, rule 12) and re-bake or drop
 *     the static shadow cache;
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
  if (!caps.composer && isMsaa(boot.antialiasing) !== isMsaa(next.antialiasing)) add("antialiasing");
  return out;
}

/** The values the session can show now: live fields from `next`, reload-only fields kept from `boot`. */
export function liveValues(boot: GraphicsValues, next: GraphicsValues, caps: Pick<GraphicsCaps, "composer">): GraphicsValues {
  const v = { ...next };
  v.shadows = boot.shadows;
  v.characterShadows = boot.characterShadows;
  if (!caps.composer) v.antialiasing = boot.antialiasing;
  return v;
}

// ------------------------------------------------------------- FPS cap

/** Frame-rate cap: "auto" follows the preset (Low → 60, the rest → uncapped), 0 = unlimited. */
export type FpsCapSetting = "auto" | 0 | 30 | 60 | 120 | 144 | 165 | 240;
export const FPS_CAPS: readonly FpsCapSetting[] = ["auto", 30, 60, 120, 144, 165, 240, 0];

/**
 * Frames per second the loop is capped at (Infinity = uncapped). "auto" =
 * the old AUTO mode: the Low preset (old LOW) caps at 60 to spare laptops
 * running on battery, everything else runs at the display's own rate.
 */
export function resolveFpsCap(cap: FpsCapSetting, preset: PresetChoice): number {
  if (cap === "auto") return preset === "bas" ? 60 : Infinity;
  return cap === 0 ? Infinity : cap;
}

/** Detection target: the display's rate, or a fixed rate (never above the display's). */
export type FpsTargetSetting = "display" | 60 | 120 | 144 | 165 | 240;
export const FPS_TARGETS: readonly FpsTargetSetting[] = ["display", 60, 120, 144, 165, 240];

/** Common display rates: a measured interval is snapped to the nearest one within 4 %. */
const DISPLAY_RATES = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 175, 180, 200, 240, 280, 360];

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
 * Frame rate the detection aims at: the display's rate (or the chosen
 * target), never above the display's rate (the browser shows no more), never
 * above a lower frame-rate cap the player set, at most 240.
 */
export function targetFps(setting: FpsTargetSetting, refreshHz: number, capFps: number): number {
  const display = snapRefreshRate(refreshHz);
  const base = setting === "display" ? display : Math.min(setting, display);
  const capped = Math.min(base, Number.isFinite(capFps) && capFps > 0 ? capFps : Infinity);
  return Math.max(30, Math.min(240, capped));
}
