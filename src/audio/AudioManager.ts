/**
 * Centralized WebAudio engine for SlideIO.
 *
 * - Single AudioContext, unlocked on the first user gesture (CLICK TO PLAY).
 * - Every MP3 is fetched + decoded ONCE and cached as an AudioBuffer.
 * - Category buses (Master / Movement / Weapons / Impacts / UI / Ambience)
 *   so volume sliders can be added later without touching call sites.
 * - One-shots: random pitch/volume variation, per-key throttling and
 *   per-key instance caps (a 60 Hz damage tick can never spam 60 sounds).
 * - Loops: click-free start/stop via short gain fades, live volume/rate.
 * - Spatial: PannerNode with distance attenuation for world-positioned
 *   sounds (bot rifles, bot deaths…). Listener follows the camera.
 */

export type AudioBus =
  | "master"
  | "movement"
  | "weapons"
  | "impacts"
  | "ui"
  | "ambience";

export interface PlayOptions {
  bus?: AudioBus;
  /** Base gain (default 1). */
  volume?: number;
  /** ± random gain variation added to volume. */
  volumeVar?: number;
  /** Base playback rate (default 1). */
  rate?: number;
  /** ± random playback-rate variation. */
  rateVar?: number;
  /** Start offset inside the buffer (seconds) — for sample sheets. */
  offset?: number;
  /** Slice duration (seconds) — for sample sheets. */
  duration?: number;
  /** Minimum ms between two plays of the same key (0 = none). */
  throttleMs?: number;
  /** Max simultaneous instances of this key (default 5). */
  maxInstances?: number;
  /** Schedule the sound slightly in the future (seconds). */
  delay?: number;
}

export interface SpatialOptions extends PlayOptions {
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
}

export interface LoopOptions {
  bus?: AudioBus;
  volume?: number;
  rate?: number;
  /** Fade-in seconds (default 0.05 — avoids clicks). */
  fadeIn?: number;
  /** Spatialize at a world position. */
  spatial?: boolean;
  refDistance?: number;
  maxDistance?: number;
}

/** Handle over a running loop: live volume / rate / position, clean stop. */
export class LoopHandle {
  stopped = false;

  constructor(
    private readonly ctx: AudioContext,
    readonly source: AudioBufferSourceNode,
    readonly gain: GainNode,
    readonly panner: PannerNode | null,
    private readonly baseVolume: number,
  ) {}

  setVolume(v: number, ramp = 0.08): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(v, t + ramp);
  }

  setRate(r: number, ramp = 0.08): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    this.source.playbackRate.cancelScheduledValues(t);
    this.source.playbackRate.setValueAtTime(this.source.playbackRate.value, t);
    this.source.playbackRate.linearRampToValueAtTime(r, t + ramp);
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.stopped || !this.panner) return;
    const t = this.ctx.currentTime;
    if (this.panner.positionX) {
      this.panner.positionX.setTargetAtTime(x, t, 0.05);
      this.panner.positionY.setTargetAtTime(y, t, 0.05);
      this.panner.positionZ.setTargetAtTime(z, t, 0.05);
    } else {
      this.panner.setPosition(x, y, z);
    }
  }

  /** Fade out then stop — never an audible click. */
  stop(fadeOut = 0.12): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0.0001, t + fadeOut);
    try {
      this.source.stop(t + fadeOut + 0.02);
    } catch {
      /* already stopped */
    }
  }

  get initialVolume(): number {
    return this.baseVolume;
  }
}

interface ActiveVoice {
  key: string;
  endTime: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private buses = new Map<AudioBus, GainNode>();
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<void>>();
  private lastPlay = new Map<string, number>();
  private voices: ActiveVoice[] = [];
  private busVolumes = new Map<AudioBus, number>();

  private static readonly MAX_VOICES = 28;

  constructor() {
    // Default mix — tweak here (or expose sliders later).
    this.busVolumes.set("master", 1.0);
    this.busVolumes.set("movement", 0.9);
    this.busVolumes.set("weapons", 0.95);
    this.busVolumes.set("impacts", 1.0);
    this.busVolumes.set("ui", 0.8);
    this.busVolumes.set("ambience", 0.5);
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /**
   * Create / resume the AudioContext. MUST be called from a user gesture
   * (the CLICK TO PLAY overlay) to satisfy browser autoplay policies.
   */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const master = this.ctx.createGain();
      master.gain.value = this.busVolumes.get("master") ?? 1;
      master.connect(this.ctx.destination);
      this.buses.set("master", master);

      for (const bus of ["movement", "weapons", "impacts", "ui", "ambience"] as AudioBus[]) {
        const g = this.ctx.createGain();
        g.gain.value = this.busVolumes.get(bus) ?? 1;
        g.connect(master);
        this.buses.set(bus, g);
      }
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {
        /* autoplay policy — will succeed after a user gesture */
      });
    }
  }

  /**
   * Ensure the context exists and try to resume it, awaiting the result.
   * Resolves true when the context is actually running (audio can play).
   */
  async resume(): Promise<boolean> {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* blocked by autoplay policy — caller retries on next gesture */
      }
    }
    return ctx.state === "running";
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    this.busVolumes.set(bus, volume);
    const node = this.buses.get(bus);
    if (node && this.ctx) {
      node.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
    }
  }

  has(key: string): boolean {
    return this.buffers.has(key);
  }

  /** Fetch + decode one file (cached — loading the same key twice is free). */
  async load(key: string, url: string): Promise<void> {
    if (this.buffers.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.arrayBuffer();
        if (raw.byteLength === 0) throw new Error("empty audio response");
        // Decoding needs a context; create it lazily (it may start
        // suspended — that's fine, decode still works).
        if (!this.ctx) this.unlock();
        const buf = await this.ctx!.decodeAudioData(raw);
        this.buffers.set(key, buf);
      } catch (e) {
        console.warn(`[audio] failed to load "${key}" from ${url}`, e);
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  /** Load a whole manifest in parallel. */
  async preload(manifest: Record<string, string>): Promise<void> {
    await Promise.all(Object.entries(manifest).map(([k, u]) => this.load(k, u)));
  }

  /** Duration of a loaded buffer (0 if unknown). */
  duration(key: string): number {
    return this.buffers.get(key)?.duration ?? 0;
  }

  // ------------------------------------------------------------------
  // One-shots
  // ------------------------------------------------------------------

  play(key: string, opts: PlayOptions = {}): void {
    this.playInternal(key, opts, null);
  }

  /** Spatialized one-shot at a world position. */
  playAt(
    key: string,
    pos: { x: number; y: number; z: number },
    opts: SpatialOptions = {},
  ): void {
    this.playInternal(key, opts, pos);
  }

  private playInternal(
    key: string,
    opts: SpatialOptions,
    pos: { x: number; y: number; z: number } | null,
  ): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(key);
    if (!ctx || ctx.state !== "running" || !buf) return;

    const now = performance.now();
    const throttle = opts.throttleMs ?? 0;
    if (throttle > 0) {
      const last = this.lastPlay.get(key) ?? -Infinity;
      if (now - last < throttle) return;
    }

    // Instance caps: per key and global.
    const t = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.endTime > t);
    if (this.voices.length >= AudioManager.MAX_VOICES) return;
    const maxInst = opts.maxInstances ?? 5;
    let count = 0;
    for (const v of this.voices) if (v.key === key) count++;
    if (count >= maxInst) return;

    this.lastPlay.set(key, now);

    const rate = (opts.rate ?? 1) + (opts.rateVar ?? 0) * (Math.random() * 2 - 1);
    const vol = Math.max(
      0,
      (opts.volume ?? 1) + (opts.volumeVar ?? 0) * (Math.random() * 2 - 1),
    );

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.25, rate);

    const gain = ctx.createGain();
    gain.gain.value = vol;

    let head: AudioNode = gain;
    src.connect(gain);

    if (pos) {
      const panner = this.createPanner(opts);
      panner.setPosition(pos.x, pos.y, pos.z);
      gain.connect(panner);
      head = panner;
    }
    head.connect(this.buses.get(opts.bus ?? "master")!);

    const start = t + (opts.delay ?? 0);
    const offset = opts.offset ?? 0;
    const dur = opts.duration;

    // Short envelope on sliced plays (sample sheets) to avoid clicks.
    if (offset > 0 || dur !== undefined) {
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.012);
      if (dur !== undefined) {
        const end = start + dur / Math.max(0.25, rate);
        gain.gain.setValueAtTime(vol, Math.max(start + 0.012, end - 0.05));
        gain.gain.linearRampToValueAtTime(0.0001, end);
      }
    }

    if (dur !== undefined) src.start(start, offset, dur);
    else src.start(start, offset);

    const lengthSec = (dur ?? buf.duration - offset) / Math.max(0.25, rate);
    this.voices.push({ key, endTime: start + lengthSec });
  }

  /**
   * Spatialized one-shot whose position can be UPDATED while it plays
   * (sounds carried by moving projectiles — e.g. the Bass Blaster's
   * music fragments riding on flying notes). Supports the same slice
   * options (offset/duration) as play(). Returns a handle exposing
   * setPosition()/stop(); null when the buffer isn't ready.
   */
  playTracked(
    key: string,
    pos: { x: number; y: number; z: number },
    opts: SpatialOptions = {},
  ): LoopHandle | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(key);
    if (!ctx || ctx.state !== "running" || !buf) return null;

    // Same instance caps as one-shots (per key + global voice budget).
    const t = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.endTime > t);
    if (this.voices.length >= AudioManager.MAX_VOICES) return null;
    const maxInst = opts.maxInstances ?? 6;
    let count = 0;
    for (const v of this.voices) if (v.key === key) count++;
    if (count >= maxInst) return null;

    const rate = Math.max(0.25, (opts.rate ?? 1) + (opts.rateVar ?? 0) * (Math.random() * 2 - 1));
    const vol = Math.max(
      0,
      (opts.volume ?? 1) + (opts.volumeVar ?? 0) * (Math.random() * 2 - 1),
    );

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(gain);

    const panner = this.createPanner(opts);
    panner.setPosition(pos.x, pos.y, pos.z);
    gain.connect(panner);
    panner.connect(this.buses.get(opts.bus ?? "master")!);

    const start = t + (opts.delay ?? 0);
    const offset = opts.offset ?? 0;
    const dur = opts.duration;

    // Short envelope on sliced plays to avoid clicks (granular fragments).
    if (offset > 0 || dur !== undefined) {
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.012);
      if (dur !== undefined) {
        const end = start + dur / rate;
        gain.gain.setValueAtTime(vol, Math.max(start + 0.012, end - 0.05));
        gain.gain.linearRampToValueAtTime(0.0001, end);
      }
    }

    if (dur !== undefined) src.start(start, offset, dur);
    else src.start(start, offset);

    const lengthSec = (dur ?? buf.duration - offset) / rate;
    this.voices.push({ key, endTime: start + lengthSec });
    return new LoopHandle(ctx, src, gain, panner, vol);
  }

  // ------------------------------------------------------------------
  // Loops
  // ------------------------------------------------------------------

  /**
   * Start a looping sound with a fade-in. Returns null when the buffer
   * isn't ready or the context is locked (caller simply retries later).
   */
  loop(key: string, opts: LoopOptions = {}): LoopHandle | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(key);
    if (!ctx || ctx.state !== "running" || !buf) return null;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = opts.rate ?? 1;

    const gain = ctx.createGain();
    const vol = opts.volume ?? 1;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + (opts.fadeIn ?? 0.05));

    src.connect(gain);
    let panner: PannerNode | null = null;
    if (opts.spatial) {
      panner = this.createPanner(opts);
      gain.connect(panner);
      panner.connect(this.buses.get(opts.bus ?? "master")!);
    } else {
      gain.connect(this.buses.get(opts.bus ?? "master")!);
    }

    src.start(t);
    return new LoopHandle(ctx, src, gain, panner, vol);
  }

  // ------------------------------------------------------------------
  // Listener (camera)
  // ------------------------------------------------------------------

  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, 0.03);
      l.positionY.setTargetAtTime(py, t, 0.03);
      l.positionZ.setTargetAtTime(pz, t, 0.03);
      l.forwardX.setTargetAtTime(fx, t, 0.03);
      l.forwardY.setTargetAtTime(fy, t, 0.03);
      l.forwardZ.setTargetAtTime(fz, t, 0.03);
      l.upX.setTargetAtTime(ux, t, 0.03);
      l.upY.setTargetAtTime(uy, t, 0.03);
      l.upZ.setTargetAtTime(uz, t, 0.03);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  private createPanner(opts: SpatialOptions | LoopOptions): PannerNode {
    const panner = this.ctx!.createPanner();
    panner.panningModel = "equalpower"; // cheap — many simultaneous sources
    panner.distanceModel = "inverse";
    panner.refDistance = opts.refDistance ?? 6;
    panner.maxDistance = opts.maxDistance ?? 120;
    panner.rolloffFactor = (opts as SpatialOptions).rolloff ?? 1.2;
    return panner;
  }
}

/** Shared singleton — the whole game plays through this. */
export const audio = new AudioManager();