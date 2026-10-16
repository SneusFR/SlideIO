import * as THREE from "three";
import type {
  IntroCharacterFactory,
  MatchIntroCue,
  MatchIntroOptions,
  MatchIntroPlayer,
} from "./MatchIntroTypes";
import { INTRO_CHALLENGER_COLORS, INTRO_GOLD, MAX_INTRO_PLAYERS, orderForIntro } from "./MatchIntroTypes";
import {
  computeFrame,
  computeLayout,
  computeSchedule,
  pointInPoly,
  type IntroFrame,
  type IntroLayout,
  type IntroSchedule,
  type Poly,
} from "./MatchIntroTimeline";
import { CHALLENGER_POSES, IntroStage, MVP_POSE } from "./MatchIntroStage";
import { MatchIntroCompositor, createStageCache, polyToPx, type StageCache } from "./MatchIntroCompositor";
import { MatchIntroOverlay } from "./MatchIntroOverlay";

/**
 * MATCH INTRO — "VERSUS ARCADE" presentation of every player of the match.
 *
 *   const { skipped } = await playMatchIntro(players, createGameIntroCharacterFactory(), {
 *     mapName: "GIVRE",
 *     onCue: (cue) => audio.playIntroCue(cue),
 *   });
 *
 * Owns its OWN renderer + canvas on a full-screen layer above the game
 * (never touches the game renderer, camera, FOV or tone mapping), loads one
 * dressed character clone per player through the host factory, plays the
 * ~12 s sequence (weakest first, the best player last and biggest) and
 * releases every resource when it resolves. Deterministic: `renderAt(t)`
 * draws any instant (preview / tests).
 */
/**
 * Drawing-buffer budget (≈ 1920 × 1200). The stage target is HDR + 4× MSAA:
 * on a 1440p / 4K screen the 3D renders slightly below native resolution
 * (the DOM text stays crisp) instead of allocating hundreds of MB.
 */
const MAX_BUFFER_PIXELS = 2_400_000;
/**
 * Auto quality: the heaviest frame (final tableau, every character on
 * screen) must render within this budget (CPU + GPU, ms) — otherwise the
 * 3D stages drop to a lower internal resolution / MSAA (integrated GPUs).
 */
const FRAME_BUDGET_MS = 22;
/**
 * Settled blades refresh their cached 3D render every few frames
 * (round-robin, oldest first): small tiles every 6 frames, the MVP panel
 * every 8 (every 30 while it is only a silhouette). At most two small
 * refreshes per frame — one while a big blade is animating on top.
 */
const SETTLED_REFRESH_FRAMES = 6;
const SETTLED_REFRESH_FRAMES_BIG = 8;
const SETTLED_REFRESH_FRAMES_SILHOUETTE = 30;
const SETTLED_REFRESH_BUDGET = 2;
const QUALITY_STEPS: Record<"high" | "medium" | "low", [scale: number, samples: number]> = {
  high: [1, 4],
  medium: [0.8, 4],
  low: [0.66, 2],
};

export class MatchIntroCinematic {
  readonly players: MatchIntroPlayer[];
  readonly schedule: IntroSchedule;
  private layout: IntroLayout;
  private readonly factory: IntroCharacterFactory;
  private readonly options: MatchIntroOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly compositor: MatchIntroCompositor;
  private readonly overlay: MatchIntroOverlay;
  private readonly accents: THREE.Color[];
  private readonly cues: Array<{ t: number; cue: MatchIntroCue }> = [];
  private stages: IntroStage[] = [];
  private caches: StageCache[] = [];
  private frameNo = 0;
  private cssW = 1;
  private cssH = 1;
  private bufW = 1;
  private bufH = 1;
  private t = 0;
  /** Cues at or before this time are already emitted (or skipped over). */
  private cueCursor = -1;
  private raf: number | null = null;
  private lastNow = 0;
  private skipped = false;
  private disposed = false;
  private shown = false;
  private resolvePlay: ((r: { skipped: boolean }) => void) | null = null;
  private readonly onResize = (): void => this.resize();
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code === "Space" || e.code === "Escape" || e.code === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.skip();
    }
  };
  private readonly onPointer = (e: PointerEvent): void => {
    e.preventDefault();
    this.skip();
  };

  constructor(players: readonly MatchIntroPlayer[], factory: IntroCharacterFactory, options: MatchIntroOptions = {}) {
    if (players.length === 0) throw new Error("MatchIntro: no players");
    this.players = orderForIntro(players).slice(-MAX_INTRO_PLAYERS);
    this.factory = factory;
    this.options = options;
    const n = this.players.length;
    this.schedule = computeSchedule(n, options.duration ?? 12);
    this.accents = this.players.map((_, i) =>
      new THREE.Color(i === n - 1 ? INTRO_GOLD : INTRO_CHALLENGER_COLORS[i % INTRO_CHALLENGER_COLORS.length]),
    );

    this.overlay = new MatchIntroOverlay(this.players, {
      mapName: options.mapName,
      skippable: options.skippable ?? true,
      zIndex: options.zIndex ?? 9000,
      accents: this.accents.map((c) => `#${c.getHexString()}`),
    });
    this.canvas = document.createElement("canvas");
    this.overlay.root.insertBefore(this.canvas, this.overlay.text);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // the HDR stage target is multisampled; 2D passes are analytic
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.autoClear = false;
    this.compositor = new MatchIntroCompositor(this.renderer);
    // Hidden until the first real frame (load() warms up behind the scenes).
    this.overlay.root.style.visibility = "hidden";
    (options.parent ?? document.body).appendChild(this.overlay.root);
    this.layout = computeLayout(n, 16 / 9);
    this.resize();
    this.buildCues();
  }

  private buildCues(): void {
    const s = this.schedule;
    const add = (t: number, cue: MatchIntroCue) => this.cues.push({ t, cue });
    add(0, { type: "open" });
    s.challengerStart.forEach((t0, index) => {
      const playerId = this.players[index].id;
      add(t0, { type: "slash", playerId, index });
      add(t0 + 0.1 * s.window, { type: "reveal", playerId, index });
      add(t0 + 0.96 * s.window, { type: "slot", playerId, index });
    });
    const mvp = this.players[this.players.length - 1].id;
    add(s.mvpStart, { type: "mvpCrack", playerId: mvp });
    add(s.mvpStart + 0.1 * s.mvpDuration, { type: "mvpReveal", playerId: mvp });
    if (this.players.length > 1) add(s.finalStart, { type: "vs" });
    add(s.exitStart, { type: "exit" });
    this.cues.sort((a, b) => a.t - b.t);
  }

  /** Load every character (in parallel) + the fonts. Failures fall back to an empty blade. */
  async load(): Promise<void> {
    const n = this.players.length;
    const chars = await Promise.all(
      this.players.map((p) =>
        this.factory(p).catch((err: unknown) => {
          console.error("MatchIntro: character failed for", p.name, err);
          return null;
        }),
      ),
    );
    if (this.disposed) {
      for (const c of chars) c?.dispose();
      return;
    }
    this.stages = chars.map((c, i) =>
      new IntroStage(c, this.accents[i], i === n - 1 ? MVP_POSE : CHALLENGER_POSES[i % CHALLENGER_POSES.length]),
    );
    this.caches = this.stages.map(() => createStageCache());
    // Fonts: the tags are measured once — wait for them (bounded).
    try {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts) {
        await Promise.race([
          Promise.all([fonts.load('64px "Luckiest Guy"'), fonts.load('700 32px "Baloo 2"')]),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      }
    } catch {
      /* non-fatal */
    }
    this.overlay.invalidateMeasures();
    // Warm-up (layer still hidden): compile every program and upload every
    // texture once — the MVP close-up, a reveal and the final tableau.
    for (const t of [this.schedule.mvpStart + 0.3 * this.schedule.mvpDuration, this.schedule.open + 0.3 * this.schedule.window, this.schedule.finalStart + 0.2]) {
      this.draw(t);
    }
    // ... and the playback path (settled caches, copy pass) at its fullest.
    this.draw(this.schedule.finalStart + 0.2, true);
    this.calibrate();
    this.draw(0);
    this.invalidateCaches();
  }

  private invalidateCaches(): void {
    for (const c of this.caches) c.valid = false;
  }

  /** Median cost (ms, CPU + GPU) of one playback frame around time t. */
  private probeFrameMs(t: number, runs = 5): number {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const times: number[] = [];
    for (let k = 0; k < runs; k++) {
      const a = performance.now();
      this.draw(t + k / 60, true);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
      times.push(performance.now() - a);
    }
    times.sort((x, y) => x - y);
    return times[Math.floor(runs / 2)];
  }

  /** Stage quality for this device (explicit option, or measured on the heaviest frame). */
  private calibrate(): void {
    const wanted = this.options.quality ?? "auto";
    if (wanted !== "auto") {
      const [scale, samples] = QUALITY_STEPS[wanted];
      this.compositor.setStageQuality(scale, samples);
      return;
    }
    const t = this.schedule.finalStart + 0.25;
    const steps = [QUALITY_STEPS.high, QUALITY_STEPS.medium, QUALITY_STEPS.low];
    for (let i = 0; i < steps.length; i++) {
      this.compositor.setStageQuality(steps[i][0], steps[i][1]);
      if (i === steps.length - 1) break;
      this.probeFrameMs(t, 1); // (re)allocation + first use of the target
      if (this.probeFrameMs(t) <= FRAME_BUDGET_MS) break;
    }
  }

  private resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.cssW = w;
    this.cssH = h;
    const dpr = window.devicePixelRatio || 1;
    const budget = Math.sqrt(MAX_BUFFER_PIXELS / (w * h));
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(dpr, this.options.pixelRatioCap ?? 1.5, budget)));
    this.renderer.setSize(w, h, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bufW = buf.x;
    this.bufH = buf.y;
    this.compositor.setSize(this.bufW, this.bufH);
    this.layout = computeLayout(this.players.length, w / h);
    this.overlay.invalidateMeasures();
  }

  /**
   * Draw the intro at time t (seconds) and show the layer. Pure function of
   * t: every 3D stage is rendered fresh (scrubbing / capture).
   */
  renderAt(t: number): IntroFrame {
    return this.present(this.draw(t, false));
  }

  private present(f: IntroFrame): IntroFrame {
    if (!this.shown && !this.disposed) {
      this.shown = true;
      this.overlay.root.style.visibility = "";
    }
    return f;
  }

  /**
   * `cached` (playback): settled blades reuse their last 3D render and only
   * a couple of them refresh per frame — the tableau then costs about two
   * stage renders instead of eight.
   */
  private draw(t: number, cached = false): IntroFrame {
    this.t = t;
    this.frameNo++;
    const f = computeFrame(t, this.schedule, this.layout);
    const W = this.bufW;
    const H = this.bufH;
    const aspect = W / H;
    const comp = this.compositor;
    const outline = Math.max(3, 0.0068 * H);
    const shadow: [number, number] = [0.0075 * H, -0.011 * H];
    const zoom = f.zoom;
    const shake = f.shake;
    const mapN = (x: number, y: number): [number, number] => [0.5 + (x - 0.5) * zoom + shake[0], 0.5 + (y - 0.5) * zoom + shake[1]];
    // A blade covering the whole screen (MVP close-up) hides everything
    // below it: those stages are not rendered at all.
    let coverZ = -Infinity;
    for (const b of f.blades) {
      if (b.visible && b.mode !== "empty" && b.z > coverZ && coversScreen(b.poly, zoom, shake)) coverZ = b.z;
    }
    comp.setTime(t);
    comp.begin();
    if (coverZ === -Infinity) comp.background(1);

    // empty slots of the tableau
    f.placeholders.forEach((ph, k) => {
      if (!ph.visible || ph.question <= 0 || coverZ > -Infinity) return;
      const fp = mapN(ph.tag[0], ph.tag[1]);
      comp.blade(
        {
          polyPx: polyToPx(ph.poly, W, H, zoom, shake),
          accent: this.accents[k],
          mode: 0,
          colorIn: 0,
          flash: 0,
          burst: 0,
          focusPx: [fp[0] * W, (1 - fp[1]) * H],
          seed: k * 1.7,
          hasTex: false,
          opacity: Math.min(1, ph.question),
        },
        shadow,
        outline,
      );
    });

    // live blades, back to front
    const order = f.blades
      .map((b, i) => {
        const polyPx = polyToPx(b.poly, W, H, zoom, shake);
        const pop = b.popOut > 0.001 && b.mode === "live";
        // Pop-out: the stage also renders ABOVE the blade's top edge.
        const renderPx = pop ? polyToPx(raiseTop(b.poly, 0.2 * b.popOut), W, H, zoom, shake) : polyPx;
        const clip = clippedRect(polyPx, W, H);
        const rect = pop ? clippedRect(renderPx, W, H) : clip;
        return { b, i, polyPx, pop, renderPx, clip, rect };
      })
      .filter((e) => e.b.visible && e.b.z >= coverZ)
      .sort((a, c) => a.b.z - c.b.z);
    // Settled refreshes of this frame: oldest caches first, a big panel takes
    // the whole budget (never two expensive refreshes in the same frame).
    const refresh = new Set<number>();
    if (cached) {
      const isBig = (e: { rect: { w: number; h: number } }): boolean => e.rect.w * e.rect.h > 0.3 * W * H;
      // a big blade animating this frame (reveal band, MVP close-up) already
      // costs a lot: the settled ones then refresh at half rate, one at a time
      const heavy = order.some((e) => !e.b.settled && e.b.mode !== "empty" && isBig(e));
      const due = order
        .filter((e) => {
          const cache = this.caches[e.i];
          if (!e.b.settled || e.pop || !cache?.valid || !cache.rt) return false;
          const every = !isBig(e)
            ? SETTLED_REFRESH_FRAMES
            : e.b.mode === "silhouette"
              ? SETTLED_REFRESH_FRAMES_SILHOUETTE
              : SETTLED_REFRESH_FRAMES_BIG;
          return this.frameNo - cache.frame >= (heavy ? 2 * every : every);
        })
        .sort((a, c) => this.caches[a.i].frame - this.caches[c.i].frame);
      let budget = heavy ? 1 : SETTLED_REFRESH_BUDGET;
      const full = budget;
      for (const e of due) {
        const cost = isBig(e) ? full : 1;
        if (cost > budget) continue;
        refresh.add(e.i);
        budget -= cost;
        if (budget <= 0) break;
      }
    }
    for (const { b, i, polyPx, pop, renderPx, clip, rect } of order) {
      const focusN = mapN(b.focus[0], b.focus[1]);
      const stage = this.stages[i];
      const live = b.mode !== "empty" && !!stage?.hasCharacter && rect.w > 0 && rect.h > 0 && clip.h > 0;
      let tex: THREE.Texture | null = null;
      let texMap: [number, number, number, number] | undefined;
      if (live && stage) {
        // normalized (y down) bbox of the rendered rectangle for the camera;
        // the framing height scales with it so the pop-out never resizes the character
        const bbox = { x0: rect.x / W, x1: (rect.x + rect.w) / W, y0: 1 - (rect.y + rect.h) / H, y1: 1 - rect.y / H };
        const framed = pop ? { ...b, frameH: b.frameH * (rect.h / Math.max(1, clip.h)) } : b;
        const cache = this.caches[i];
        if (cached && cache && b.settled && !pop) {
          const resized = Math.abs(cache.srcW - rect.w) > 0.03 * rect.w || Math.abs(cache.srcH - rect.h) > 0.03 * rect.h;
          if (!cache.valid || !cache.rt || resized || refresh.has(i)) {
            stage.update(framed, bbox, aspect);
            comp.renderStageCached(stage.scene, stage.camera, rect, cache);
            cache.frame = this.frameNo;
            cache.srcW = rect.w;
            cache.srcH = rect.h;
            cache.valid = true;
          }
          const crt = cache.rt;
          if (crt) {
            tex = crt.texture;
            // the cached render follows the blade's current rectangle (shake / zoom)
            texMap = [rect.x, rect.y, cache.usedW / crt.width / rect.w, cache.usedH / crt.height / rect.h];
          }
        } else {
          if (cache) cache.valid = false;
          stage.update(framed, bbox, aspect);
          comp.renderStage(stage.scene, stage.camera, rect);
        }
      }
      const draw = {
        polyPx,
        accent: this.accents[i],
        mode: (b.mode === "empty" ? 0 : b.mode === "silhouette" ? 1 : 2) as 0 | 1 | 2 | 3,
        colorIn: b.mode === "silhouette" ? 0 : b.colorIn,
        flash: Math.min(1, b.flash),
        burst: b.burst,
        focusPx: [focusN[0] * W, (1 - focusN[1]) * H] as [number, number],
        seed: i * 2.3,
        hasTex: live,
        tex,
        texMap,
        opacity: 1,
      };
      comp.blade(draw, shadow, outline);
      if (pop && live) comp.blade({ ...draw, polyPx: renderPx, mode: 3, opacity: Math.min(1, b.popOut * 1.5) }, shadow, outline);
    }

    // slash streak of the challenger being revealed
    if (f.slash.active && f.slash.index >= 0) {
      const a = mapN(-0.1, 0.535);
      const c = mapN(1.1, 0.465);
      comp.slashStreak(f.slash.p, this.accents[f.slash.index], [a[0] * W, (1 - a[1]) * H], [c[0] * W, (1 - c[1]) * H]);
    }
    comp.flashOverlay(f.flash, f.flashGold);
    comp.exitWipe(f.exit);
    this.overlay.update(f, this.layout, this.cssW, this.cssH);
    return f;
  }

  /** Play from the start; resolves when the intro is over (or skipped). */
  play(): Promise<{ skipped: boolean }> {
    if (this.disposed) return Promise.resolve({ skipped: true });
    if (this.resolvePlay) return Promise.resolve({ skipped: true }); // already playing
    window.addEventListener("resize", this.onResize);
    const skippable = this.options.skippable ?? true;
    this.overlay.root.style.pointerEvents = skippable ? "auto" : "none";
    if (skippable) {
      window.addEventListener("keydown", this.onKey, true);
      this.overlay.root.addEventListener("pointerdown", this.onPointer);
    }
    return new Promise((resolve) => {
      this.resolvePlay = resolve;
      this.t = 0;
      this.cueCursor = -1;
      this.invalidateCaches();
      this.skipped = false;
      this.lastNow = performance.now();
      const frame = () => {
        if (this.disposed) return;
        const now = performance.now();
        // Clamp the step: a hitch slows the intro instead of skipping beats.
        const dt = Math.min(1 / 20, Math.max(0, (now - this.lastNow) / 1000));
        this.lastNow = now;
        const t = this.t + dt;
        for (const c of this.cues) if (c.t > this.cueCursor && c.t <= t) this.emit(c.cue);
        this.cueCursor = t;
        const f = this.present(this.draw(t, true));
        if (f.done) {
          this.raf = null;
          this.emit({ type: "end", skipped: this.skipped });
          this.finish();
          return;
        }
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  /** Jump to the exit wipe (the final tableau is complete at that point). */
  skip(): void {
    if (!this.resolvePlay || this.t >= this.schedule.exitStart) return;
    this.skipped = true;
    this.t = this.schedule.exitStart;
    // The beats jumped over stay silent: only "exit" (and "end") still fire.
    this.cueCursor = this.schedule.exitStart - 1e-6;
  }

  private emit(cue: MatchIntroCue): void {
    try {
      this.options.onCue?.(cue);
    } catch (err) {
      console.error("MatchIntro: cue handler failed", err);
    }
  }

  private finish(): void {
    // Hand the input back right away (the layer is fully wiped out by now).
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey, true);
    this.overlay.root.removeEventListener("pointerdown", this.onPointer);
    this.overlay.root.style.pointerEvents = "none";
    const resolve = this.resolvePlay;
    this.resolvePlay = null;
    resolve?.({ skipped: this.skipped });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey, true);
    this.overlay.root.removeEventListener("pointerdown", this.onPointer);
    for (const s of this.stages) s.dispose();
    this.stages = [];
    for (const c of this.caches) c.rt?.dispose();
    this.caches = [];
    this.compositor.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.overlay.dispose();
    this.finish();
  }
}

/** Pixel rectangle (y up) of a pixel polygon, clipped to the screen. */
function clippedRect(px: number[], W: number, H: number): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let v = 0; v < 6; v++) {
    x0 = Math.min(x0, px[v * 2]);
    x1 = Math.max(x1, px[v * 2]);
    y0 = Math.min(y0, px[v * 2 + 1]);
    y1 = Math.max(y1, px[v * 2 + 1]);
  }
  const rx0 = Math.max(0, x0);
  const rx1 = Math.min(W, x1);
  const ry0 = Math.max(0, y0);
  const ry1 = Math.min(H, y1);
  return { x: rx0, y: ry0, w: Math.max(0, rx1 - rx0), h: Math.max(0, ry1 - ry0) };
}

/** True when the polygon (after the global zoom + shake) contains the 4 screen corners. */
function coversScreen(p: Poly, zoom: number, shake: [number, number]): boolean {
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const x = 0.5 + (cx - 0.5 - shake[0]) / zoom;
    const y = 0.5 + (cy - 0.5 - shake[1]) / zoom;
    if (!pointInPoly(p, x, y)) return false;
  }
  return true;
}

/** Same polygon with its two top vertices raised by `dy` (normalized, y down). */
function raiseTop(p: number[], dy: number): number[] {
  const out = p.slice();
  out[1] -= dy;
  out[3] -= dy;
  return out;
}

/** One-call helper: load, play, always clean up. */
export async function playMatchIntro(
  players: readonly MatchIntroPlayer[],
  factory: IntroCharacterFactory,
  options: MatchIntroOptions = {},
): Promise<{ skipped: boolean }> {
  const intro = new MatchIntroCinematic(players, factory, options);
  try {
    await intro.load();
    return await intro.play();
  } finally {
    intro.dispose();
  }
}
