import {
  AUTO_TUNE_VERSION,
  FPS_CAPS,
  FPS_TARGETS,
  PRESET_CHOICES,
  SHADOW_MODES,
  SNOW_LEVELS,
  presetValues,
  sanitizeGraphicsValues,
  type AutoResult,
  type FpsCapSetting,
  type FpsTargetSetting,
  type GraphicsChoice,
  type GraphicsValues,
  type PresetId,
  type SnowLevel,
} from "./GraphicsSettings";
import { POWER_STATES, type PowerState } from "./Power";
import { DEFAULT_OUTLINE_VALUES, sanitizeOutlineValues, type OutlineValues } from "../game/OutlineSettings";
import { defaultCrosshairSettings, sanitizeCrosshairSettings, type CrosshairSettings } from "../ui/CrosshairSettings";

/**
 * ONE versioned localStorage record for every player setting of the game
 * page: graphics (preset + custom values + the automatic detection of each
 * map), frame cap, detection target, cel-shading outline, crosshair,
 * performance panel. Replaces the scattered keys of earlier versions, which
 * are migrated once (and left in place, harmlessly, for an older build).
 *
 * The HUD document (sandboxed iframe: no storage) never reads this: what it
 * must know arrives by command (crosshair.settings).
 */
export const SETTINGS_KEY = "slideio.settings";
export const SETTINGS_VERSION = 1;

/** Keys of earlier versions (before the settings page). */
export const LEGACY_KEYS = {
  quality: "beanzo.graphicsQuality",
  fpsCap: "beanzo.fpsCap",
  outline: "slideio.givreOutline",
  snow: "slideio.givreSnow",
  crosshair: "slideio.crosshair",
} as const;

/**
 * The old quality / frame-cap keys as this store last saw or wrote them. The
 * store keeps them in step with the record (an older build after a rollback
 * reads the player's choice; Low ⇄ LOW, High ⇄ HIGH, the rest ⇄ AUTO) and a
 * value someone else wrote since — an older build, a test or bench script —
 * is taken over at the next load, like a choice made in that build.
 */
export interface LegacyMirror {
  quality: string | null;
  fpsCap: string | null;
}

export type PerfPanelMode = "full" | "fps" | "off";
export const PERF_PANEL_MODES: readonly PerfPanelMode[] = ["full", "fps", "off"];

export interface SettingsRecord {
  v: typeof SETTINGS_VERSION;
  graphics: GraphicsChoice;
  fpsCap: FpsCapSetting;
  /** Frame rate the automatic detection aims at. */
  fpsTarget: FpsTargetSetting;
  outline: OutlineValues;
  crosshair: CrosshairSettings;
  /** Debug / performance panel (top-left in play). */
  perfPanel: PerfPanelMode;
  /** The old keys' values as last seen / written (see LegacyMirror). */
  legacy: LegacyMirror;
}

/** Minimal Storage (window.localStorage, or a Map in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultRecord(): SettingsRecord {
  return {
    v: SETTINGS_VERSION,
    graphics: { preset: "auto", custom: null, auto: {} },
    fpsCap: "auto",
    fpsTarget: "display",
    outline: { ...DEFAULT_OUTLINE_VALUES },
    crosshair: defaultCrosshairSettings(),
    perfPanel: "full",
    legacy: { quality: null, fpsCap: null },
  };
}

const pick = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Fallback for stored values that miss fields: High at DPR 1 (only fills holes). */
const HOLE_FILLER: GraphicsValues = presetValues("eleve", { dpr: 1 });

/** At most this many maps keep a stored detection (more is not plausible: dropped). */
const MAX_AUTO_MAPS = 16;

function sanitizeAuto(raw: unknown, map: string): AutoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.values || typeof r.values !== "object") return null;
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const guardSteps = Math.max(0, Math.min(64, Math.floor(num(r.guardSteps, 0))));
  // One entry per kept step at most, the most recent last (see AutoResult.guardPower).
  const powers = Array.isArray(r.guardPower) ? r.guardPower.filter((p): p is PowerState => POWER_STATES.includes(p as PowerState)) : [];
  const guardPower = guardSteps > 0 ? powers.slice(-guardSteps) : [];
  return {
    values: sanitizeGraphicsValues(r.values, HOLE_FILLER),
    at: num(r.at, 0),
    gpu: typeof r.gpu === "string" ? r.gpu.slice(0, 200) : "",
    map,
    targetFps: num(r.targetFps, 60),
    measuredFps: typeof r.measuredFps === "number" && Number.isFinite(r.measuredFps) ? r.measuredFps : null,
    mode: pick(["target", "hard", "cpu", "gpu"] as const, r.mode, "target"),
    complete: r.complete !== false,
    measuredShadows: pick(SHADOW_MODES, r.measuredShadows, sanitizeGraphicsValues(r.values, HOLE_FILLER).shadows),
    summary: typeof r.summary === "string" ? r.summary.slice(0, 600) : "",
    version: num(r.version, 0),
    guardSteps,
    guardAt: typeof r.guardAt === "number" && Number.isFinite(r.guardAt) ? r.guardAt : null,
    detected: r.detected && typeof r.detected === "object" ? sanitizeGraphicsValues(r.detected, HOLE_FILLER) : null,
    guardRetryAt: typeof r.guardRetryAt === "number" && Number.isFinite(r.guardRetryAt) ? r.guardRetryAt : null,
    guardUpFails: Math.max(0, Math.min(16, Math.floor(num(r.guardUpFails, 0)))),
    guardPower,
  };
}

function sanitizeAutoMap(raw: unknown): Record<string, AutoResult> {
  const out: Record<string, AutoResult> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [map, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_AUTO_MAPS || !/^[A-Z0-9_]{1,32}$/.test(map)) continue;
    const r = sanitizeAuto(value, map);
    if (r) {
      out[map] = r;
      n++;
    }
  }
  return out;
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
      auto: sanitizeAutoMap(g.auto),
    },
    fpsCap: pick(FPS_CAPS, r.fpsCap, d.fpsCap),
    fpsTarget: pick(FPS_TARGETS, r.fpsTarget, d.fpsTarget),
    outline: r.outline === undefined ? d.outline : sanitizeOutlineValues(r.outline),
    crosshair: r.crosshair === undefined ? d.crosshair : sanitizeCrosshairSettings(r.crosshair),
    perfPanel: pick(PERF_PANEL_MODES, r.perfPanel, d.perfPanel),
    legacy: sanitizeLegacy(r.legacy),
  };
}

function sanitizeLegacy(raw: unknown): LegacyMirror {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 16) : null);
  return { quality: str(r.quality), fpsCap: str(r.fpsCap) };
}

/**
 * The old keys' values that stand for this record (what an older build would
 * read). Null = the old build has no such value (Medium, Ultra, Custom;
 * a 144 cap…): the key keeps what it holds.
 */
export function legacyMirrorOf(rec: SettingsRecord): LegacyMirror {
  const p = rec.graphics.preset;
  const c = rec.fpsCap;
  return {
    quality: p === "bas" ? "LOW" : p === "eleve" ? "HIGH" : p === "auto" ? "AUTO" : null,
    fpsCap: c === 60 ? "60" : c === 0 ? "OFF" : c === "auto" ? "AUTO" : null,
  };
}

/**
 * Takes over the old keys' values written by someone else since this store
 * last wrote them (an older build, a test script): LOW / HIGH / AUTO → Low /
 * High / Auto, FPS LIMIT AUTO / 60 / OFF → auto / 60 / unlimited.
 * Returns true when the record changed.
 */
export function adoptLegacyChanges(rec: SettingsRecord, current: LegacyMirror): boolean {
  let changed = false;
  if (current.quality !== rec.legacy.quality) {
    const preset = current.quality === "LOW" ? "bas" : current.quality === "HIGH" ? "eleve" : current.quality === "AUTO" ? "auto" : null;
    if (preset !== null && preset !== rec.graphics.preset) {
      rec.graphics = { ...rec.graphics, preset };
      changed = true;
    }
  }
  if (current.fpsCap !== rec.legacy.fpsCap) {
    const cap: FpsCapSetting | null = current.fpsCap === "60" ? 60 : current.fpsCap === "OFF" ? 0 : current.fpsCap === "AUTO" ? "auto" : null;
    if (cap !== null && cap !== rec.fpsCap) {
      rec.fpsCap = cap;
      changed = true;
    }
  }
  return changed;
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
 *   - quality LOW / HIGH → Low / High (the same presets);
 *   - a snow level other than the default → "Custom" = that preset (or
 *     what AUTO resolved to on this GPU: `autoBase`) with this snow — the
 *     player picked something, the game looks the same, no first-launch
 *     detection overrides it;
 *   - quality AUTO (or never set) and nothing else → "Auto": the
 *     detection runs on the first launch;
 *   - FPS LIMIT AUTO / 60 / OFF → auto / 60 / unlimited; outline and
 *     crosshair records → validated as before.
 * `autoBase` = what the old AUTO picked on this GPU ("bas" for weak GPUs).
 */
export function migrateLegacy(storage: StorageLike, autoBase: () => PresetId, dpr = 1): SettingsRecord {
  const rec = defaultRecord();
  const quality = read(storage, LEGACY_KEYS.quality);
  const explicit: PresetId | null = quality === "LOW" ? "bas" : quality === "HIGH" ? "eleve" : null;
  const capRaw = read(storage, LEGACY_KEYS.fpsCap);
  rec.fpsCap = capRaw === "60" ? 60 : capRaw === "OFF" ? 0 : "auto";
  const snowRaw = read(storage, LEGACY_KEYS.snow);
  const snow: SnowLevel | null = SNOW_LEVELS.includes(snowRaw as SnowLevel) ? (snowRaw as SnowLevel) : null;
  if (snow !== null && snow !== "normale") {
    const base: PresetId = explicit ?? autoBase();
    rec.graphics = { preset: "custom", custom: { ...presetValues(base, { dpr }), snow }, auto: {} };
    // The old AUTO frame cap followed the preset (LOW → 60). "Custom"
    // resolves "auto" to uncapped: pin the 60 the player was running at.
    if (rec.fpsCap === "auto" && base === "bas") rec.fpsCap = 60;
  } else {
    rec.graphics = { preset: explicit ?? "auto", custom: null, auto: {} };
  }
  const outline = parseJson(read(storage, LEGACY_KEYS.outline));
  if (outline !== undefined) rec.outline = sanitizeOutlineValues(outline);
  const crosshair = parseJson(read(storage, LEGACY_KEYS.crosshair));
  if (crosshair !== undefined) rec.crosshair = sanitizeCrosshairSettings(crosshair);
  // Already taken over: not a later change of the old keys.
  rec.legacy = { quality, fpsCap: capRaw };
  return rec;
}

type Listener = (record: SettingsRecord) => void;

/**
 * The settings of this page: loaded once (stored record, or the migration
 * of the old keys), changed through update(), persisted at every change and
 * broadcast to the subscribers (the controller applies what is live, the
 * page re-renders). Storage failures (private mode, quota, blocked) leave
 * the session working with its in-memory settings.
 */
export class SettingsStore {
  private record: SettingsRecord | null = null;
  private readonly listeners: Listener[] = [];

  constructor(
    private readonly storage: StorageLike | null,
    /** What the old AUTO quality resolved to on this GPU (migration only — lazy: costs a WebGL context). */
    private readonly autoBase: () => PresetId = () => "eleve",
    private readonly dpr: () => number = () => 1,
  ) {}

  /** The current settings (treat as read-only: change them through update()). */
  get(): SettingsRecord {
    if (!this.record) this.record = this.load();
    return this.record;
  }

  /** Applies a change, persists it, notifies the subscribers. */
  update(change: (draft: SettingsRecord) => void): SettingsRecord {
    const draft = cloneRecord(this.get());
    change(draft);
    this.record = sanitizeRecord(draft);
    this.persist();
    for (const l of [...this.listeners]) l(this.record);
    return this.record;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private load(): SettingsRecord {
    const storage = this.storage;
    if (!storage) return defaultRecord();
    const raw = parseJson(read(storage, SETTINGS_KEY));
    // A record of this version — or of another one (an older build after a
    // rollback, a newer one): read as far as its fields validate. Then the
    // old keys someone else wrote since (see LegacyMirror).
    const rec =
      raw && typeof raw === "object" && typeof (raw as { v?: unknown }).v === "number"
        ? sanitizeRecord(raw)
        : migrateLegacy(storage, this.autoBase, this.dpr());
    adoptLegacyChanges(rec, { quality: read(storage, LEGACY_KEYS.quality), fpsCap: read(storage, LEGACY_KEYS.fpsCap) });
    this.record = rec;
    this.persist();
    return rec;
  }

  private persist(): void {
    const storage = this.storage;
    const rec = this.record;
    if (!storage || !rec) return;
    const mirror = legacyMirrorOf(rec);
    try {
      for (const [field, key] of [
        ["quality", LEGACY_KEYS.quality],
        ["fpsCap", LEGACY_KEYS.fpsCap],
      ] as const) {
        const value = mirror[field];
        const stored = read(storage, key);
        if (value !== null && stored !== value) storage.setItem(key, value);
        rec.legacy[field] = value ?? stored;
      }
      storage.setItem(SETTINGS_KEY, JSON.stringify(rec));
    } catch {
      /* storage unavailable — the session keeps its in-memory settings */
    }
  }
}

function cloneRecord(r: SettingsRecord): SettingsRecord {
  return JSON.parse(JSON.stringify(r)) as SettingsRecord;
}

/** Version check helper for the tests and the page (a stored detection of an older logic is not used). */
export function isCurrentAutoResult(r: AutoResult | undefined): boolean {
  return !!r && r.version === AUTO_TUNE_VERSION;
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
let autoBaseHook: () => PresetId = () => "eleve";
export function setLegacyAutoBase(hook: () => PresetId): void {
  autoBaseHook = hook;
}
