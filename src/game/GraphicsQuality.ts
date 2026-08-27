/**
 * Graphics quality presets — the single knob for every GPU-bound cost.
 *
 * Modest machines (Intel iGPU laptops…) are FILL-RATE and LIGHT-COUNT
 * bound in this game: rendered pixels (devicePixelRatio), MSAA, the
 * shadow pass and the number of forward-lit point lights dominate the
 * frame time. Strong GPUs keep the full visuals; weak ones get a LOW
 * preset that trades imperceptible details for a stable 60 FPS.
 *
 * Resolution order (first match wins):
 *   1. Player override, persisted in localStorage ("LOW" / "HIGH").
 *   2. AUTO detection from the WebGL renderer string: integrated /
 *      mobile / software GPUs → LOW, everything else → HIGH.
 *
 * The renderer's `antialias` flag can only be set at context creation,
 * so changing the preset from the Escape menu reloads the page.
 */
export type QualityLevel = "LOW" | "HIGH";
export type QualityMode = "AUTO" | QualityLevel;

export interface QualitySettings {
  /** Resolved preset actually in effect this session. */
  level: QualityLevel;
  /** Renderer pixel-ratio ceiling (real DPR is clamped to this). */
  pixelRatioCap: number;
  /** MSAA at context creation (expensive on integrated GPUs). */
  antialias: boolean;
  /** Directional moonlight shadow map resolution (square). */
  shadowMapSize: number;
  /** Render the shadow pass every OTHER frame (30 Hz shadows at 60 FPS). */
  halfRateShadows: boolean;
  /** Max simultaneous violet force-field point lights (biggest walls win). */
  maxFieldLights: number;
  /** Multiplier on the force-field rising-particle density. */
  fieldParticleScale: number;
}

const STORAGE_KEY = "beanzo.graphicsQuality";

const PRESETS: Record<QualityLevel, Omit<QualitySettings, "level">> = {
  HIGH: {
    pixelRatioCap: 2,
    antialias: true,
    shadowMapSize: 2048,
    halfRateShadows: false,
    maxFieldLights: Infinity,
    fieldParticleScale: 1,
  },
  LOW: {
    pixelRatioCap: 1,
    antialias: false,
    shadowMapSize: 1024,
    halfRateShadows: true,
    maxFieldLights: 4,
    fieldParticleScale: 0.5,
  },
};

/** GPU families that should default to the LOW preset. */
const WEAK_GPU_PATTERN =
  /\bintel\b|\buhd\b|\biris\b|\bhd graphics\b|radeon\(tm\) graphics|\bvega (?:3|6|8|10|11)\b|\bmali\b|\badreno\b|\bpowervr\b|swiftshader|llvmpipe|software/i;

/** Persisted player override (AUTO when never touched / invalid). */
export function loadQualityMode(): QualityMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "LOW" || raw === "HIGH" || raw === "AUTO") return raw;
  } catch {
    /* storage unavailable — AUTO */
  }
  return "AUTO";
}

export function saveQualityMode(mode: QualityMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable — the session keeps its current settings */
  }
}

/**
 * AUTO detection: read the unmasked GPU renderer string from a throwaway
 * WebGL context. Integrated / mobile / software GPUs → LOW. Any failure
 * (blocked extension, no context) errs on the safe side → LOW.
 */
export function detectQualityLevel(): QualityLevel {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return "LOW";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (!renderer) return "HIGH"; // masked string: assume a real GPU
    return WEAK_GPU_PATTERN.test(renderer) ? "LOW" : "HIGH";
  } catch {
    return "LOW";
  }
}

let cached: QualitySettings | null = null;

/** Settings in effect for this session (resolved once, then cached). */
export function getQualitySettings(): QualitySettings {
  if (cached) return cached;
  const mode = loadQualityMode();
  const level: QualityLevel = mode === "AUTO" ? detectQualityLevel() : mode;
  cached = { level, ...PRESETS[level] };
  return cached;
}