import {
  FPS_CAPS,
  FPS_TARGETS,
  PRESET_CHOICES,
  SNOW_LEVELS,
  sanitizeGraphicsValues,
  presetValues,
  AUTO_TUNE_VERSION,
  type AutoResult,
  type FpsCapSetting,
  type FpsTargetSetting,
  type GraphicsChoice,
  type GraphicsValues,
  type PresetId,
  type SnowLevel,
} from "./GraphicsSettings";
import {
  DEFAULT_OUTLINE_VALUES,
  sanitizeOutlineValues,
  type OutlineValues,
} from "../game/OutlineSettings";
import { defaultCrosshairSettings, sanitizeCrosshairSettings, type CrosshairSettings } from "../ui/CrosshairSettings";

/**
 * ONE versioned localStorage record for every player setting of the game
 * page: graphics (preset + custom values + last automatic detection), frame
 * cap, detection target, dynamic resolution, cel-shading outline, crosshair,
 * performance panel. Replaces the scattered keys of earlier versions, which
 * are migrated once (and left in place, harmlessly, for an older build).
 *
 * The HUD document (sandboxed iframe: no storage) never reads this: what it
 * must know arrives by command (crosshair.settings).
 */
export const SETTINGS_KEY = "slideio.settings";
export const SETTINGS_VERSION = 1;

/** Old keys (before the settings page). */
export const LEGACY_KEYS = {
  quality: "beanzo.graphicsQuality",
  fpsCap: "beanzo.fpsCap",
  outline: "slideio.givreOutline",
  snow: "slideio.givreSnow",
  crosshair: "slideio.crosshair",
} as const;

export type PerfPanelMode = "full" | "fps" | "off";
export const PERF_PANEL_MODES: readonly PerfPanelMode[] = ["full", "fps", "off"];

export interface SettingsRecord {
  v: typeof SETTINGS_VERSION;
  graphics: GraphicsChoice;
  fpsCap: FpsCapSetting;
  /** Frame rate the automatic detection and the dynamic resolution aim at. */
  fpsTarget: FpsTargetSetting;
  /** Holds the target by moving the render scale between the floor and the set scale. */
  dynamicResolution: boolean;
  outline: OutlineValues;
  crosshair: CrosshairSettings;
  /** Debug / performance panel (top-left in play). */
  perfPanel: PerfPanelMode;
}

/** Minimal Storage (window.localStorage, or a Map in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultRecord(): SettingsRecord {
  return {
    v: SETTINGS_VERSION,
    graphics: { preset: "auto", custom: null, auto: null },
    fpsCap: "auto",
    fpsTarget: "display",
    dynamicResolution: false,
    outline: { ...DEFAULT_OUTLINE_VALUES },
    crosshair: defaultCrosshairSettings(),
    perfPanel: "full",
  };
}

const pick = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Fallback for stored values that miss fields: Élevé at DPR 1 (only fills holes). */
const HOLE_FILLER: GraphicsValues = presetValues("eleve", { dpr: 1 });

function sanitizeAuto(raw: unknown): AutoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.values || typeof r.values !== "object") return null;
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    values: sanitizeGraphicsValues(r.values, HOLE_FILLER),
    at: num(r.at, 0),
    gpu: typeof r.gpu === "string" ? r.gpu : "",
    targetFps: num(r.targetFps, 60),
    expectedFps: typeof r.expectedFps === "number" && Number.isFinite(r.expectedFps) ? r.expectedFps : null,
    limitedBy: pick(["gpu", "cpu", "none"] as const, r.limitedBy, "none"),
    belowTarget: r.belowTarget === true,
    summary: typeof r.summary === "string" ? r.summary.slice(0, 600) : "",
    version: num(r.version, 0),
  };
}

/** Field-by-field validation of a stored record (bad fields → defaults). */
export function sanitizeRecord(raw: unknown): SettingsRecord {
  const d = defaultRecord();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const g = r.graphics && typeof r.graphics === "object" ? (r.graphics as Record<string, unknown>) : {};
  const preset = pick(PRESET_CHOICES, g.preset, d.graphics.preset);
  const custom = g.custom && typeof g.custom === "object" ? sanitizeGraphicsValues(g.custom, HOLE_FILLER) : null;
  return {
    v: SETTINGS_VERSION,
    graphics: {
      // "custom" without values is meaningless: back to auto.
      preset: preset === "custom" && !custom ? "auto" : preset,
      custom,
      auto: sanitizeAuto(g.auto),
    },
    fpsCap: pick(FPS_CAPS, r.fpsCap, d.fpsCap),
    fpsTarget: pick(FPS_TARGETS, r.fpsTarget, d.fpsTarget),
    dynamicResolution: r.dynamicResolution === true,
    outline: sanitizeOutlineValues(r.outline),
    crosshair: r.crosshair === undefined ? d.crosshair : sanitizeCrosshairSettings(r.crosshair),
    perfPanel: pick(PERF_PANEL_MODES, r.perfPanel, d.perfPanel),
  };
}

const read = (storage: StorageLike, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * The record built from the keys of earlier versions (first run of this
 * version). An explicit old choice is kept EXACTLY:
 *   - quality LOW / HIGH → Bas / Élevé (the same presets);
 *   - a snow level other than the default → "Personnalisé" = that preset (or
 *     what AUTO resolved to on this GPU: `autoBase`) with this snow — the
 *     player picked something, the game looks the same, no first-launch
 *     detection overrides it;
 *   - quality AUTO (or never set) and nothing else → "Automatique": the new
 *     detection runs on the first launch;
 *   - FPS LIMIT AUTO / 60 / OFF → auto / 60 / unlimited; outline and
 *     crosshair records → validated as before.
 * `autoBase` = what the old AUTO picked on this GPU ("bas" for weak GPUs).
 */
export function migrateLegacy(storage: StorageLike, autoBase: () => "bas" | "eleve", dpr = 1): SettingsRecord {
  const rec = defaultRecord();
  const quality = read(storage, LEGACY_KEYS.quality);
  const explicit: PresetId | null = quality === "LOW" ? "bas" : quality === "HIGH" ? "eleve" : null;
  const capRaw = read(storage, LEGACY_KEYS.fpsCap);
  rec.fpsCap = capRaw === "60" ? 60 : capRaw === "OFF" ? 0 : "auto";
  const snowRaw = read(storage, LEGACY_KEYS.snow);
  const snow: SnowLevel | null = SNOW_LEVELS.includes(snowRaw as SnowLevel) ? (snowRaw as SnowLevel) : null;
  if (snow !== null && snow !== "normale") {
    const base: PresetId = explicit ?? autoBase();
    rec.graphics = { preset: "custom", custom: { ...presetValues(base, { dpr }), snow }, auto: null };
    // The old AUTO frame cap followed the preset (LOW → 60). "Personnalisé"
    // resolves "auto" to uncapped: pin the 60 the player was running at.
    if (rec.fpsCap === "auto" && base === "bas") rec.fpsCap = 60;
  } else {
    rec.graphics = { preset: explicit ?? "auto", custom: null, auto: null };
  }
  const outline = parseJson(read(storage, LEGACY_KEYS.outline));
  if (outline !== undefined) rec.outline = sanitizeOutlineValues(outline);
  const crosshair = parseJson(read(storage, LEGACY_KEYS.crosshair));
  if (crosshair !== undefined) rec.crosshair = sanitizeCrosshairSettings(crosshair);
  return rec;
}

type Listener = (record: SettingsRecord) => void;

/**
 * The settings of this page: loaded once (stored record, or the migration
 * of the old keys), changed through update(), persisted at every change and
 * broadcast to the subscribers (the Game applies what is live, the pages
 * re-render). Storage failures (private mode, quota, blocked) leave the
 * session working with its in-memory settings.
 */
export class SettingsStore {
  private record: SettingsRecord | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: StorageLike | null,
    /** What the old AUTO quality resolved to on this GPU (migration only — lazy: costs a WebGL context). */
    private readonly autoBase: () => "bas" | "eleve" = () => "eleve",
    private readonly dpr: () => number = () => 1,
  ) {}

  /** The current settings (sanitized copy-free object: treat as read-only). */
  get(): SettingsRecord {
    if (!this.record) this.record = this.load();
    return this.record;
  }

  /** Applies a change, persists it, notifies the subscribers. */
  update(change: (draft: SettingsRecord) => void): SettingsRecord {
    const draft = structuredCloneRecord(this.get());
    change(draft);
    this.record = sanitizeRecord(draft);
    this.persist();
    for (const l of [...this.listeners]) l(this.record);
    return this.record;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): SettingsRecord {
    const storage = this.storage;
    if (!storage) return defaultRecord();
    const raw = parseJson(read(storage, SETTINGS_KEY));
    // A record of this version — or of another one (an older build after a
    // rollback, a newer one): read as far as its fields validate.
    if (raw && typeof raw === "object" && typeof (raw as { v?: unknown }).v === "number") return sanitizeRecord(raw);
    const migrated = migrateLegacy(storage, this.autoBase, this.dpr());
    this.record = migrated;
    this.persist();
    return migrated;
  }

  private persist(): void {
    if (!this.storage || !this.record) return;
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(this.record));
    } catch {
      /* storage unavailable — the session keeps its in-memory settings */
    }
  }
}

function structuredCloneRecord(r: SettingsRecord): SettingsRecord {
  return JSON.parse(JSON.stringify(r)) as SettingsRecord;
}

/** First launch of a player who never chose: "Automatique" with no usable detection yet. */
export function needsFirstDetection(record: SettingsRecord, gpuName: string): boolean {
  const g = record.graphics;
  if (g.preset !== "auto") return false;
  return !g.auto || g.auto.version !== AUTO_TUNE_VERSION || g.auto.gpu !== gpuName;
}

// ------------------------------------------------------- page singleton

let shared: SettingsStore | null = null;

/** The store of this page (window.localStorage). Created lazily: no storage access at import. */
export function settingsStore(): SettingsStore {
  if (!shared) {
    let storage: StorageLike | null = null;
    try {
      storage = typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      storage = null; // sandboxed / blocked storage
    }
    shared = new SettingsStore(
      storage,
      () => autoBaseHook(),
      () => (typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1),
    );
  }
  return shared;
}

/** Migration hook: what the old AUTO picked (set by GraphicsQuality, which owns the GPU probe). */
let autoBaseHook: () => "bas" | "eleve" = () => "eleve";
export function setLegacyAutoBase(hook: () => "bas" | "eleve"): void {
  autoBaseHook = hook;
}
