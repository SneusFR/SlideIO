import {
  effectivePreset,
  effectiveValues,
  isMsaa,
  pixelRatioFor,
  resolveFpsCap,
  shadowMapTierSize,
  SHADOW_QUALITIES,
  type DisplayEnv,
  type GpuHint,
  type GraphicsValues,
  type PresetChoice,
} from "../settings/GraphicsSettings";
import { setLegacyAutoBase, settingsStore } from "../settings/SettingsStore";

/**
 * Graphics SESSION — the values this page load runs with, resolved ONCE at
 * boot from the settings record (src/settings: presets, custom values, the
 * last automatic detection). The map and character code read the legacy
 * facade below (getQualitySettings) while they build; the Game reads the full
 * session, then applies live changes itself (see Game.applyGraphicsSettings).
 *
 * Modest machines (Intel iGPU laptops…) are FILL-RATE bound in this game:
 * rendered pixels, MSAA, the shadow pass and the forward-lit lights dominate
 * the frame time — each is one setting of the page.
 */
export interface GraphicsSession {
  /** Effective values at boot (shadow mode, character shadows, effect lights, context MSAA: fixed for the session). */
  values: GraphicsValues;
  /** Preset choice at boot ("auto", "bas"…, "custom"). */
  preset: PresetChoice;
  /** Display the presets were resolved for. */
  env: DisplayEnv;
  /** GPU hint used by "auto" (probe only made when the choice needs it). */
  gpu: GpuHint;
}

/** Legacy shape read by the map / character code at construction. */
export interface QualitySettings {
  /** Shadow size family of Givre (GivreConfig.shadowMapSize): "HIGH" from the "high" tier up. */
  level: "LOW" | "HIGH";
  /** The renderer's pixel ratio this session (SpaceSky star sizes). */
  pixelRatioCap: number;
  /** MSAA requested (the WebGL context's MSAA on maps without a post chain). */
  antialias: boolean;
  /** Shadow map side for the square maps (Jungle / Yard). */
  shadowMapSize: number;
  /**
   * Moving objects (characters, held weapons, drones) never cast shadows:
   * static or no shadows, or dynamic shadows without character shadows. Their
   * silhouette would otherwise be frozen into the baked map.
   */
  staticShadows: boolean;
  /** Frame-rate cap at boot (Infinity = uncapped). */
  maxFps: number;
  /** Anisotropic filtering of the world textures (Givre lightmaps). */
  anisotropy: number;
}

/** GPU families that defaulted to the LOW preset (the "auto" choice before any detection). */
const WEAK_GPU_PATTERN =
  /\bintel\b|\buhd\b|\biris\b|\bhd graphics\b|radeon\(tm\) graphics|\bvega (?:3|6|8|10|11)\b|\bmali\b|\badreno\b|\bpowervr\b|swiftshader|llvmpipe|software/i;

/** Software rasterizers: no game-side setting can make them fast. */
const SOFTWARE_GPU_PATTERN = /swiftshader|llvmpipe|softpipe|basic render|software/i;

export function isWeakGpuName(name: string): boolean {
  return WEAK_GPU_PATTERN.test(name);
}

export function isSoftwareGpuName(name: string): boolean {
  return SOFTWARE_GPU_PATTERN.test(name);
}

let probe: GpuHint | null = null;

/**
 * The GPU the browser renders with, read from a throwaway WebGL context (once
 * per page) — same power preference as the game's renderer, so a dual-GPU
 * laptop reports the GPU the game will really get. Any failure errs on the
 * safe side: weak.
 */
export function probeGpu(): GpuHint {
  if (probe) return probe;
  try {
    const canvas = document.createElement("canvas");
    const attrs: WebGLContextAttributes = { powerPreference: "high-performance" };
    const gl =
      (canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null);
    if (!gl) return (probe = { name: "", weak: true });
    const name = webglRendererName(gl);
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    // Masked string: assume a real GPU (as before).
    probe = { name, weak: raw ? isWeakGpuName(raw) : false };
  } catch {
    probe = { name: "", weak: true };
  }
  return probe;
}

// The settings migration asks what the old AUTO picked on this GPU (an explicit
// snow level kept as "Personnalisé" from that preset).
setLegacyAutoBase(() => (probeGpu().weak ? "bas" : "eleve"));

export function currentDisplayEnv(): DisplayEnv {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return { dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : 1 };
}

/**
 * GPU hint of a choice: "auto" needs the real GPU (stored detection for THIS
 * GPU, or the weak/strong heuristic); other choices never pay for the probe.
 */
export function gpuHintFor(preset: PresetChoice): GpuHint {
  return preset === "auto" ? probeGpu() : { name: "", weak: false };
}

let session: GraphicsSession | null = null;

/** The values this page load runs with (resolved once, then cached). */
export function getGraphicsSession(): GraphicsSession {
  if (session) return session;
  const record = settingsStore().get();
  const env = currentDisplayEnv();
  const gpu = gpuHintFor(record.graphics.preset);
  session = { values: effectiveValues(record.graphics, env, gpu), preset: record.graphics.preset, env, gpu };
  return session;
}

/** The legacy shape of a set of values on a display (pure: tested against the old LOW / HIGH presets). */
export function legacyQuality(v: GraphicsValues, env: DisplayEnv, maxFps: number): QualitySettings {
  return {
    level: SHADOW_QUALITIES.indexOf(v.shadowQuality) >= SHADOW_QUALITIES.indexOf("high") ? "HIGH" : "LOW",
    pixelRatioCap: pixelRatioFor(v.renderScale, env.dpr),
    antialias: isMsaa(v.antialiasing),
    shadowMapSize: shadowMapTierSize(v.shadowQuality, false),
    staticShadows: !(v.shadows === "dynamic" && v.characterShadows),
    maxFps,
    anisotropy: v.anisotropy,
  };
}

let cached: QualitySettings | null = null;

/** Legacy facade (map / character code), derived from the session. */
export function getQualitySettings(): QualitySettings {
  if (cached) return cached;
  const s = getGraphicsSession();
  const record = settingsStore().get();
  cached = legacyQuality(s.values, s.env, resolveFpsCap(record.fpsCap, effectivePreset(record.graphics, s.gpu)));
  return cached;
}

/**
 * Short name of the GPU / backend the browser REALLY renders with (debug
 * HUD): "Intel(R) Iris(R) Xe Graphics · D3D11". Reveals a software
 * fallback ("SwiftShader", "Microsoft Basic Render Driver", "llvmpipe"),
 * which no game-side optimisation can make fast. Empty when masked.
 */
export function webglRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    // "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    const angle = /^ANGLE \((.*)\)$/.exec(raw);
    if (!angle) return raw;
    const parts = angle[1].split(", ");
    const device = (parts[1] ?? parts[0])
      .replace(/\s*\(0x[0-9a-f]+\)/i, "")
      .replace(/\s*Direct3D\S*\s+vs_\S+\s+ps_\S+/i, "")
      .trim();
    const backend = parts[2] ?? "";
    return backend ? `${device} · ${backend}` : device;
  } catch {
    return "";
  }
}
