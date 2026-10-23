/**
 * HUD host (game page) — where the in-match HUD runs, and the only way the
 * game talks to it (see ../protocol.ts and PERFORMANCE.md, « Le HUD dans
 * son propre processus »).
 *
 * FRAME mode (production): the HUD lives in its own document, a sandboxed
 * iframe laid over the canvas that Chrome runs in ANOTHER renderer process —
 * its style / layout / paint no longer add to the game's frame. The game's
 * HUD calls become plain-data commands, posted once per game frame
 * (`flush()`, at the end of Game's frame).
 * INLINE mode (fallback, `npm run dev`, `?hud=inline`): the same HUD runtime
 * in this page, every command applied synchronously at the call — the old
 * behaviour exactly.
 *
 * Choosing (once, during the loading screen): `?hud=inline|frame` forces a
 * mode; otherwise production → frame, DEV → inline (Vite's dev server
 * refuses the sandboxed document's `Origin: null`). A frame attempt falls
 * back to inline — never to a broken HUD — when the iframe does not say
 * hello within 8 s, does not run in its own process (isolation check, unless
 * forced), reports an error before it is ready (viewport mismatch…), or
 * stops answering before its warm-up is over. Commands emitted before the
 * mode is final are kept and replayed in order.
 * During the match, the HUD is rebuilt in the page from its last state
 * (`STATE_KEY`) when the iframe stops answering while this page keeps
 * drawing (its process crashed — Chrome then shows its grey "sad frame" over
 * the game — or hangs), or when it no longer sees this page's viewport.
 */
import type {
  CreateHudRuntime,
  HudApi,
  HudCommand,
  HudCommandName,
  HudDownMessage,
  HudInit,
  HudRuntime,
  HudUpMessage,
} from "../protocol";
import { HUD_CONNECT, HUD_HELLO } from "../protocol";
import { optSwitch } from "../../ui/perfDiag";
import { createHudProxies } from "./HudProxies";
import { KillCascade } from "./killCascade";

/** No hello from the iframe within this: HUD in the page. */
export const HELLO_TIMEOUT_MS = 8000;
/** No `ready` within this after `init` (markup, widgets, fonts): HUD in the page. */
export const READY_TIMEOUT_MS = 8000;
/** Isolation check: the game page blocks its thread this long… */
export const ISOLATION_BLOCK_MS = 80;
/** …and an iframe in its own process keeps drawing meanwhile (≥ this many rAF). */
export const ISOLATION_MIN_FRAMES = 3;
/**
 * A measure that says "not isolated" is confirmed by a second one, this long
 * after: a transient stall (the compositor busy with the game's loading) must
 * not cost the isolated HUD for the whole session.
 */
export const ISOLATION_RETRY_MS = 250;
/** A ping unanswered this long: the iframe is not usable. */
export const PING_TIMEOUT_MS = 8000;
/**
 * No `warmup-done` this long after the game's shader compile is over: the
 * iframe is presumed dead, HUD in the page. (The HUD warm-up's own budget is
 * 8 s after that point; its tail then takes a frame per state.)
 */
export const WARMUP_TIMEOUT_MS = 20000;
/**
 * Commands emitted outside a game frame (menus, network callbacks between
 * frames…) are posted at the next display frame when no flush happened for
 * this long (the menu preview / play transition / game frames flush on their
 * own).
 */
export const IDLE_FLUSH_MS = 100;
/**
 * Frame mode, once its warm-up is over: no message from the iframe (its
 * `stats` come every 500 ms, from a timer) for this long, while this page
 * keeps drawing → its process crashed or its main thread hangs: HUD rebuilt
 * in the page from its last state.
 */
export const SILENCE_MS = 3000;
/**
 * After the HUD is shown or hidden as a whole (`doc.class`: the menu, the
 * pause), the silence is not judged for this long: showing it is its largest
 * frame of the session (everything styled, laid out and painted again,
 * seconds on a starved machine — 5 s measured on the 2-core software bench).
 */
export const SHOW_GRACE_MS = 10000;
/**
 * Two of this page's frames further apart than this: it was blocked (long
 * task) or not drawing (hidden) — the iframe's messages may still wait in its
 * queue, so the silence is measured again from there.
 */
export const SILENCE_GAP_MS = 500;
/**
 * The iframe's viewport (in its `stats`) differs from this page's in this
 * many stats in a row, this page's own staying the same meanwhile: HUD in the
 * page (it would be drawn at another scale).
 */
export const VIEWPORT_MISSES = 2;
/** Commands kept for a late fallback (until the warm-up is over) or until the mode is final, at most. */
export const JOURNAL_MAX = 20000;

/**
 * What a command leaves on screen, for a fallback DURING the match (the
 * iframe gone with everything it was showing): the last command of each key
 * is replayed to the HUD rebuilt in the page. A number = the command is state,
 * keyed by its name and that many leading arguments (`plate.visible` per
 * plate…); null = an event (a hit, a kill, a medal, a damage number…), gone
 * with the iframe. Every command must be classified (a new one too).
 */
const STATE_KEY: Record<HudCommandName, 0 | 1 | 2 | null> = {
  "combat.update": 0,
  "combat.knockdown": 0,
  "combat.damage": null,
  "combat.heal": null,
  "combat.kill": null,
  "combat.name": 0,
  "dash.update": 0,
  "spear.visible": 0,
  "spear.update": 0,
  "plate.visible": 1,
  "plate.popcorn": 0,
  "plate.paintball": 0,
  "plate.famas": 0,
  "plate.frisbee": 0,
  "combo.kill": null,
  "combo.update": 0,
  "medal.show": null,
  "medal.exit": null,
  "medal.hide": null,
  "killstreak.render": 0,
  "killstreak.ready": null,
  "leaderboard.refresh": 0,
  "clock.set": 0,
  "interact.prompt": 0,
  "phase.opacity": 0,
  "mole.opacity": 0,
  "crosshair.fire": null,
  "crosshair.aim": 0,
  "crosshair.flush": null,
  "crosshair.settings": 0,
  "hitmarker.show": null,
  "hitmarker.flush": null,
  "damage.hit": null,
  "damage.orphan": null,
  "damage.follow": null,
  "damage.update": null,
  "doc.class": 2,
};

/** The state key of `cmd`, or null for an event (see STATE_KEY). */
export function stateKey(cmd: HudCommand): string | null {
  const n = STATE_KEY[cmd[0]];
  if (n === null) return null;
  if (n === 0) return cmd[0];
  return n === 1 ? `${cmd[0]}|${String(cmd[1])}` : `${cmd[0]}|${String(cmd[1])}|${String(cmd[2])}`;
}

/** Same viewport within the init check's tolerance (1 CSS px, 0.01 DPR — protocol.ts). */
function sameViewport(a: HudInit["viewport"], b: HudInit["viewport"]): boolean {
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1 && Math.abs(a.dpr - b.dpr) <= 0.01;
}

function viewportText(v: HudInit["viewport"]): string {
  return `${v.width}×${v.height} @${Math.round(v.dpr * 100) / 100}`;
}
/**
 * A deadline fires this long after its delay, once more: the loading screen
 * runs long tasks (map, shaders…), and an answer that arrived meanwhile is
 * handled first — a blocked page never reads as a silent iframe.
 */
const DEADLINE_GRACE_MS = 50;

export type HudMode = "frame" | "inline";

/** How the HUD document is reached (see chooseHudMode). */
export type HudChoice =
  | { mode: "inline"; reason: string }
  | { mode: "frame"; url: string; sandboxed: boolean; forced: boolean };

/**
 * `?hud=inline|frame` overrides; production → frame, DEV → inline.
 * Frame URL: production → `/hud.html` in a sandbox (opaque origin = another
 * site = its own process; its scripts / CSS need CORS, see vercel.json).
 * DEV (`?hud=frame`) → the loopback ALIAS instead (page on localhost →
 * iframe on 127.0.0.1 and vice versa): another site, but same-origin for its
 * own Vite modules (no CORS on the dev server). `?hudUrl=sandbox|alias`
 * overrides the URL kind (tests).
 */
export function chooseHudMode(env: {
  prod: boolean;
  search: string;
  location: { protocol: string; hostname: string; port: string };
}): HudChoice {
  const query = new URLSearchParams(env.search);
  const hud = query.get("hud");
  if (hud === "inline") return { mode: "inline", reason: "?hud=inline" };
  const forced = hud === "frame";
  if (!forced && !env.prod) return { mode: "inline", reason: "dev" };
  const hudUrl = query.get("hudUrl");
  const kind = hudUrl === "sandbox" || hudUrl === "alias" ? hudUrl : env.prod ? "sandbox" : "alias";
  if (kind === "sandbox") return { mode: "frame", url: "/hud.html", sandboxed: true, forced };
  const { protocol, hostname, port } = env.location;
  const other = hostname === "localhost" ? "127.0.0.1" : hostname === "127.0.0.1" ? "localhost" : null;
  if (!other) return { mode: "inline", reason: "pas d'alias local" };
  return { mode: "frame", url: `${protocol}//${other}${port ? `:${port}` : ""}/hud.html`, sandboxed: false, forced };
}

/**
 * The HUD document's address: the frame URL plus the game page's own
 * diagnostics, which the HUD document reads from its own address
 * (ui/perfDiag.ts) — `?gpu` (its plate paint context times itself for the
 * debug HUD's GPU line) and `?diag=` (the HUD's own A/B switches, e.g.
 * `nohudidle`). Nothing else of the page's query.
 */
export function hudDocumentUrl(url: string, search: string): string {
  const page = new URLSearchParams(search);
  const query = new URLSearchParams();
  for (const key of ["gpu", "diag"]) {
    const value = page.get(key);
    if (value !== null) query.set(key, value);
  }
  const q = query.toString();
  return q ? `${url}?${q}` : url;
}

/** The iframe as the host uses it. */
export interface HudFrameHandle {
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void } | null;
  remove(): void;
}

/** A MessagePort as the host uses it. */
export interface HudPortLike {
  postMessage(message: unknown): void;
  /** Starts the port: `fn` receives each message's data. */
  listen(fn: (data: unknown) => void): void;
  close(): void;
}

/** Everything the host needs from the browser (injected by the tests). */
export interface HudHostEnv {
  prod: boolean;
  search: string;
  location: { protocol: string; hostname: string; port: string };
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  requestAnimationFrame(fn: () => void): void;
  /** Blocks this thread for `ms` (isolation check). */
  busyWait(ms: number): void;
  hidden(): boolean;
  /** Calls `fn` on every visibility change; returns the unsubscribe. */
  onVisibilityChange(fn: () => void): () => void;
  /** `<iframe id="hud-frame">` appended to the body (CSS: style.css `#hud-frame`). */
  createFrame(url: string, sandboxed: boolean): HudFrameHandle;
  /** `window` "message" events; returns the unsubscribe. */
  onWindowMessage(fn: (event: { source: unknown; data: unknown }) => void): () => void;
  createChannel(): { port1: HudPortLike; port2: unknown };
  /** This page's viewport (the HUD document must see the same). */
  viewport(): HudInit["viewport"];
  /** A class on this page's `<html>` (hud-warm, hud-menu-active). */
  setRootClass(name: string, on: boolean): void;
  importRuntime(): Promise<{ createHudRuntime: CreateHudRuntime }>;
  warn(message: string): void;
  error(message: string, err: unknown): void;
}

function browserEnv(): HudHostEnv {
  return {
    prod: import.meta.env.PROD,
    search: location.search,
    location: { protocol: location.protocol, hostname: location.hostname, port: location.port },
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    requestAnimationFrame: (fn) => {
      requestAnimationFrame(() => fn());
    },
    busyWait: (ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // spin: the point is to keep this thread busy
      }
    },
    hidden: () => document.hidden,
    onVisibilityChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
    createFrame: (url, sandboxed) => {
      const frame = document.createElement("iframe");
      frame.id = "hud-frame";
      // Opaque origin (no allow-same-origin): another site for Chrome's site
      // isolation → its own process. The alias (DEV) is cross-site already.
      if (sandboxed) frame.setAttribute("sandbox", "allow-scripts");
      // Never focusable: focus moving into it would blur the game window
      // (every held key released — InputManager).
      frame.tabIndex = -1;
      frame.setAttribute("aria-hidden", "true");
      frame.title = "";
      frame.src = url;
      document.body.appendChild(frame);
      return frame;
    },
    onWindowMessage: (fn) => {
      const listener = (e: MessageEvent): void => fn(e);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    createChannel: () => {
      const { port1, port2 } = new MessageChannel();
      return {
        port1: {
          postMessage: (message) => port1.postMessage(message),
          listen: (fn) => {
            port1.onmessage = (e) => fn(e.data);
          },
          close: () => {
            port1.onmessage = null;
            port1.close();
          },
        },
        port2,
      };
    },
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    setRootClass: (name, on) => {
      document.documentElement.classList.toggle(name, on);
    },
    importRuntime: () => import("../runtime/HudRuntime"),
    warn: (message) => console.warn(message),
    error: (message, err) => console.error(message, err),
  };
}

/**
 * idle       start() not called yet — commands kept
 * connecting frame mode tried: hello, isolation check, init → ready — commands kept
 * frame      the iframe's runtime is ready: one batch per game frame
 * loading    inline mode: runtime module loading / waiting for init — commands kept
 * inline     the runtime in this page: commands applied at the call
 * dead       no HUD at all (the runtime module failed to load): commands dropped
 */
type Phase = "idle" | "connecting" | "frame" | "loading" | "inline" | "dead";

type HudStats = Extract<HudUpMessage, { t: "stats" }>;

export class HudHost {
  /** What the game calls (Game, main.ts, HitFeedbackManager, MenuOverlay). */
  readonly api: HudApi;

  private env: HudHostEnv | null = null;
  private phase: Phase = "idle";
  private choice: HudChoice | null = null;
  /** Why the HUD runs in the page (debug line). */
  private inlineReason = "";

  // ---- Commands ----
  /** Emitted before the mode is final, replayed in order. */
  private buffer: HudCommand[] = [];
  /** Frame mode: this game frame's commands. */
  private batch: HudCommand[] = [];
  /**
   * Frame mode, until the warm-up is over: every command already posted, so
   * that a late fallback can rebuild the HUD in the page (null = committed).
   */
  private journal: HudCommand[] | null = [];
  /** The HUD's state: the last command of each state key, in the order those came (see STATE_KEY). */
  private readonly state = new Map<string, HudCommand>();
  private lastFlushAt = 0;
  private idleFlushArmed = false;

  // ---- Frame mode, during the match: is the iframe still there? ----
  /** Since when no message came from the iframe (restarted after a gap of this page's frames). */
  private quietSince = 0;
  /** The previous silence check (one per frame of this page). */
  private lastWatchAt = Number.NEGATIVE_INFINITY;
  /** No silence judged before this (SHOW_GRACE_MS after a `doc.class`). */
  private graceUntil = Number.NEGATIVE_INFINITY;
  /** Stats in a row whose viewport differs from this page's. */
  private viewportMisses = 0;
  /** This page's viewport at the previous stats. */
  private lastPageViewport: HudInit["viewport"] | null = null;

  // ---- Init / runtime ----
  private initArgs: Omit<HudInit, "viewport"> | null = null;
  private initSent = false;
  private runtime: HudRuntime | null = null;

  // ---- Frame mode plumbing ----
  private frame: HudFrameHandle | null = null;
  private port: HudPortLike | null = null;
  private unlistenWindow: (() => void) | null = null;
  private unlistenVisibility: (() => void) | null = null;
  private helloTimer: unknown = null;
  private readyTimer: unknown = null;
  private warmupTimer: unknown = null;
  /** Isolation verified (false while unknown / when forced). */
  private isolated = false;
  /** The frame is accepted (isolated or forced): init may be sent. */
  private accepted = false;
  private checking = false;
  /** Isolation measures that said "not isolated" (the 2nd one decides). */
  private isolationMisses = 0;
  private pongWaiter: ((frames: number | null) => void) | null = null;
  private warmupWaiter: ((done: boolean) => void) | null = null;
  private warnedError = false;
  private warmUpStarted = false;
  /** Bumped at every visibility change (an isolation check spanning one is void). */
  private visibilityEpoch = 0;

  // ---- Mode decided (frame ready, or inline runtime built) ----
  private readonly decidedWaiters: ((mode: HudMode | null) => void)[] = [];

  // ---- Stats (frame mode) ----
  private stats: HudStats | null = null;
  private paintGpuMs: number | null = null;

  /**
   * Frame mode: a kill's HUD effects start over a few frames instead of one
   * (killCascade.ts; the page's host turns it on, `?diag=nokillcascade` off).
   */
  private readonly cascade: KillCascade | null;

  constructor(options: { killCascade?: boolean } = {}) {
    this.api = createHudProxies((cmd) => this.emit(cmd), {
      mirrorMenuActive: (on) => this.setRootClass("hud-menu-active", on),
    });
    this.cascade = options.killCascade ? new KillCascade(() => (this.env ? this.env.now() : 0)) : null;
  }

  /** The mode once final (null while deciding / without HUD). */
  get mode(): HudMode | null {
    return this.phase === "frame" ? "frame" : this.phase === "inline" ? "inline" : null;
  }

  /**
   * Boot (main.ts, before Game.create): the HUD document starts loading
   * alongside the game's assets. Once.
   */
  start(env: HudHostEnv = browserEnv()): void {
    if (this.phase !== "idle") return;
    this.env = env;
    const choice = chooseHudMode(env);
    this.choice = choice;
    if (choice.mode === "inline") {
      this.goInline(choice.reason);
      return;
    }
    this.phase = "connecting";
    this.frame = env.createFrame(hudDocumentUrl(choice.url, env.search), choice.sandboxed);
    this.unlistenWindow = env.onWindowMessage((e) => this.onWindowMessage(e));
    this.helloTimer = this.deadline(HELLO_TIMEOUT_MS, () => {
      this.helloTimer = null;
      this.fallBack(`pas de réponse de l'iframe en ${HELLO_TIMEOUT_MS / 1000} s`);
    });
  }

  /**
   * The widgets' constructor arguments (Game's constructor, where the
   * widgets used to be built). The viewport is added when it is sent.
   */
  init(init: Omit<HudInit, "viewport">): void {
    if (this.initArgs) return;
    this.initArgs = init;
    if (this.phase === "connecting" && this.accepted) this.sendInit();
    else if (this.phase === "loading" && this.runtime) this.initInline();
  }

  /**
   * The HUD warm-up (main.ts, alongside Game.warmUpRendering): in the HUD's
   * own document (frame) or in this page (inline). Waits for the mode first.
   * `gpuBusy` resolves when the game's shader compile is over.
   */
  async warmUp(gpuBusy: Promise<unknown> | null): Promise<void> {
    if (this.warmUpStarted) return;
    this.warmUpStarted = true;
    const mode = await this.decidedOrHidden();
    if (mode === "inline") {
      await this.runtime!.warmUp(gpuBusy);
      return;
    }
    if (mode !== "frame") {
      // Hidden tab (no frame would come: nothing to warm, like warmUpHud),
      // or no HUD at all.
      this.commit();
      return;
    }
    const env = this.env!;
    // Game page side of the warm-up: its loading screen lets 0.4 % through
    // and the HUD iframe goes just under it (style.css, html.hud-warm).
    env.setRootClass("hud-warm", true);
    let done: boolean;
    try {
      done = await new Promise<boolean>((resolve) => {
        this.warmupWaiter = resolve;
        this.post({ t: "warmup" });
        const idle = (): void => {
          if (this.warmupWaiter !== resolve) return;
          this.post({ t: "gpu-idle" });
          this.warmupTimer = this.deadline(WARMUP_TIMEOUT_MS, () => {
            this.warmupTimer = null;
            this.settleWarmup(false);
          });
        };
        if (gpuBusy) gpuBusy.then(idle, idle);
        else idle();
      });
    } finally {
      env.setRootClass("hud-warm", false);
    }
    if (done) {
      this.commit();
      return;
    }
    // The iframe stopped answering: the HUD in this page, warmed up here.
    this.fallBack(`l'iframe n'a pas fini son warm-up en ${WARMUP_TIMEOUT_MS / 1000} s`);
    if ((await this.decided()) === "inline") await this.runtime!.warmUp(null);
  }

  /**
   * End of a game frame (also the menu preview / play transition frames):
   * frame mode posts this frame's commands as ONE message. No-op inline
   * (already applied) and while deciding (kept for the replay).
   */
  flush(): void {
    if (this.phase !== "frame") return;
    if (this.journal === null) {
      // Warm-up over: the iframe must keep answering (its process can crash).
      this.watch();
      if (this.phase !== "frame") return; // fell back: this frame's commands went to the page's HUD
    }
    // The kill effects due in this frame join its batch (killCascade.ts).
    this.cascade?.release((cmd) => this.emitNow(cmd));
    if (this.batch.length === 0) return;
    const cmds = this.batch;
    this.batch = [];
    this.lastFlushAt = this.env!.now();
    this.post({ t: "batch", cmds });
    if (this.journal) {
      for (const cmd of cmds) this.journal.push(cmd);
      if (this.journal.length > JOURNAL_MAX) this.commit();
    }
  }

  /** DEV debug line "GPU": the plate paint's GPU ms since the last call. */
  takePaintGpuMs(): number | null {
    if (this.phase === "inline") return this.runtime!.takePaintGpuMs();
    const ms = this.paintGpuMs;
    this.paintGpuMs = null;
    return ms;
  }

  /**
   * Debug HUD line "HUD:" — where the HUD runs, and its own frame stats:
   * the frames its document asked for per second (it draws only when
   * something changes: ~1 at rest, the clock; its animations run on the
   * compositor — a CSS animation only the main thread can run, as
   * `?diag=hudanim` brings back, draws frames this count does not see), the
   * commands' JS per game frame, the browser's work per frame drawn.
   */
  describe(): string {
    switch (this.phase) {
      case "frame": {
        const head = this.isolated ? "iframe isolée" : "iframe (forcée)";
        const s = this.stats;
        if (!s) return head;
        return `${head} · ${Math.round(s.fps)} images/s · JS ${s.applyMs.toFixed(1)} · rendu ${s.renderMs.toFixed(1)} ms`;
      }
      case "inline":
        return `dans la page (${this.inlineReason})`;
      case "dead":
        return "absent (runtime introuvable)";
      default:
        return "en attente";
    }
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  private emit(cmd: HudCommand): void {
    // Frame mode: a kill's effects after the kill's own feedback, a few frames later.
    if (this.phase === "frame" && this.cascade?.hold(cmd)) return;
    this.emitNow(cmd);
  }

  private emitNow(cmd: HudCommand): void {
    if (this.phase === "inline") {
      // Synchronous, at the call: exactly the old direct widget call.
      this.runtime!.run(cmd);
      return;
    }
    if (this.phase === "dead") return;
    // The HUD's state, for a fallback during the match: the last command of
    // each key, in the order they came (each value replayed after the ones
    // set before it).
    const key = stateKey(cmd);
    if (key !== null) {
      this.state.delete(key);
      this.state.set(key, cmd);
    }
    if (this.phase === "frame") {
      // The HUD shown / hidden as a whole: its next frame is its heaviest.
      if (cmd[0] === "doc.class") this.graceUntil = this.env!.now() + SHOW_GRACE_MS;
      if (this.batch.length === 0 && !this.idleFlushArmed && this.env!.now() - this.lastFlushAt > IDLE_FLUSH_MS) {
        // Nothing flushes right now (loading, menus without a frame
        // loop…): the next display frame posts it.
        this.idleFlushArmed = true;
        this.env!.requestAnimationFrame(() => {
          this.idleFlushArmed = false;
          this.flush();
        });
      }
      this.batch.push(cmd);
      return;
    }
    this.buffer.push(cmd);
    // A mode slow to settle (the runtime chunk on a slow network…): the
    // state replaces the history — events that old are moot.
    if (this.buffer.length > JOURNAL_MAX) this.buffer = [...this.state.values()];
  }

  /**
   * Frame mode after the warm-up, once per frame of this page: falls back to
   * the HUD in the page when the iframe has been silent for SILENCE_MS while
   * this page kept drawing (see SILENCE_GAP_MS).
   */
  private watch(): void {
    const now = this.env!.now();
    if (now - this.lastWatchAt > SILENCE_GAP_MS || now < this.graceUntil) this.quietSince = now;
    this.lastWatchAt = now;
    const quiet = now - this.quietSince;
    if (quiet > SILENCE_MS) this.fallBack(`l'iframe ne répond plus depuis ${(quiet / 1000).toFixed(1)} s`);
  }

  private post(message: HudDownMessage): void {
    try {
      this.port?.postMessage(message);
    } catch (err) {
      // A command that cannot be cloned (a bug: only plain data may cross):
      // reported once, the game keeps running.
      if (!this.warnedError) {
        this.warnedError = true;
        this.env!.error("[HUD] message not sent to the HUD iframe", err);
      }
    }
  }

  /**
   * Warm-up over (or skipped): the commands are no longer kept — a fallback
   * from now on rebuilds the HUD from its state only — and the iframe's
   * silence is watched (flush).
   */
  private commit(): void {
    this.journal = null;
  }

  // ------------------------------------------------------------------
  // Frame mode: hello → port → isolation check → init → ready
  // ------------------------------------------------------------------

  private onWindowMessage(e: { source: unknown; data: unknown }): void {
    const frame = this.frame;
    if (this.phase !== "connecting" || !frame || this.port || e.source !== frame.contentWindow) return;
    const data = e.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || !data[HUD_HELLO]) return;
    const env = this.env!;
    this.cancel(this.helloTimer);
    this.helloTimer = null;
    this.unlistenWindow?.();
    this.unlistenWindow = null;
    const channel = env.createChannel();
    this.port = channel.port1;
    this.port.listen((data) => this.onUp(data as HudUpMessage));
    frame.contentWindow!.postMessage({ [HUD_CONNECT]: 1 }, "*", [channel.port2]);
    if (this.choice?.mode === "frame" && this.choice.forced) {
      this.accept();
      return;
    }
    // A hidden tab draws no frame (rAF paused in both documents): the check
    // waits until the page is shown.
    this.unlistenVisibility = env.onVisibilityChange(() => {
      this.visibilityEpoch++;
      if (!env.hidden()) void this.checkIsolation();
    });
    if (!env.hidden()) void this.checkIsolation();
  }

  /**
   * Is the iframe in its own process? Its rAF count, before and after this
   * thread is blocked for 80 ms: it keeps drawing only if it has its own
   * main thread (another process). Runs once, during the loading screen.
   */
  private async checkIsolation(): Promise<void> {
    // (Hidden: the visibility listener runs it once the page is shown.)
    if (this.checking || this.accepted || this.phase !== "connecting" || this.env!.hidden()) return;
    this.checking = true;
    let again = false;
    try {
      again = await this.measureIsolation();
    } finally {
      this.checking = false;
    }
    if (again) void this.checkIsolation();
  }

  /** One isolation measure; true when it must be redone (the page was hidden meanwhile). */
  private async measureIsolation(): Promise<boolean> {
    const epoch = this.visibilityEpoch;
    const n0 = await this.ping();
    if (this.phase !== "connecting") return false;
    if (n0 === null) {
      this.fallBack("l'iframe ne répond pas");
      return false;
    }
    this.env!.busyWait(ISOLATION_BLOCK_MS);
    const n1 = await this.ping();
    if (this.phase !== "connecting") return false;
    if (n1 === null) {
      this.fallBack("l'iframe ne répond pas");
      return false;
    }
    // Hidden meanwhile: no frame could be drawn — measured again once shown
    // (by the visibility listener, or right away if shown again already).
    if (this.env!.hidden()) return false;
    if (this.visibilityEpoch !== epoch) return true;
    const frames = n1 - n0;
    if (frames >= ISOLATION_MIN_FRAMES) {
      this.isolated = true;
      this.accept();
    } else if (++this.isolationMisses < 2) {
      this.env!.setTimeout(() => void this.checkIsolation(), ISOLATION_RETRY_MS);
    } else {
      this.fallBack(`iframe non isolée (${frames} frame${frames > 1 ? "s" : ""} pendant ${ISOLATION_BLOCK_MS} ms bloquées)`);
    }
    return false;
  }

  private ping(): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = this.deadline(PING_TIMEOUT_MS, () => {
        if (this.pongWaiter === settle) this.pongWaiter = null;
        resolve(null);
      });
      const settle = (frames: number | null): void => {
        this.cancel(timer);
        resolve(frames);
      };
      this.pongWaiter = settle;
      this.post({ t: "ping" });
    });
  }

  /** The frame is usable: init (now, or when Game gives it). */
  private accept(): void {
    this.accepted = true;
    this.unlistenVisibility?.();
    this.unlistenVisibility = null;
    if (this.initArgs) this.sendInit();
  }

  private sendInit(): void {
    if (this.initSent) return;
    this.initSent = true;
    const env = this.env!;
    this.post({ t: "init", init: { ...this.initArgs!, viewport: env.viewport() } });
    this.readyTimer = this.deadline(READY_TIMEOUT_MS, () => {
      this.readyTimer = null;
      this.fallBack(`l'iframe n'est pas prête ${READY_TIMEOUT_MS / 1000} s après init`);
    });
  }

  private onUp(msg: HudUpMessage): void {
    this.quietSince = this.env!.now();
    switch (msg.t) {
      case "pong": {
        const waiter = this.pongWaiter;
        this.pongWaiter = null;
        waiter?.(msg.frames);
        return;
      }
      case "ready": {
        if (this.phase !== "connecting" || !this.initSent) return;
        this.cancel(this.readyTimer);
        this.readyTimer = null;
        this.phase = "frame";
        // Everything emitted until now, in order, as the first batch.
        const cmds = this.buffer;
        this.buffer = [];
        this.lastFlushAt = this.env!.now();
        if (cmds.length > 0) {
          this.post({ t: "batch", cmds });
          if (this.journal) this.journal = cmds;
        }
        this.settleDecided("frame");
        return;
      }
      case "warmup-done":
        this.settleWarmup(true);
        return;
      case "stats":
        this.stats = msg;
        if (msg.paintGpuMs !== null) this.paintGpuMs = (this.paintGpuMs ?? 0) + msg.paintGpuMs;
        if (msg.viewport && this.phase === "frame") this.checkViewport(msg.viewport);
        return;
      case "error":
        if (this.phase === "connecting") {
          // Before `ready` (e.g. the iframe does not see this page's viewport:
          // browser zoom not applied to it): the HUD in the page instead.
          this.fallBack(`erreur de l'iframe : ${msg.message}`);
          return;
        }
        if (!this.warnedError) {
          this.warnedError = true;
          this.env!.warn(`[HUD] erreur dans l'iframe du HUD : ${msg.message}`);
        }
        return;
    }
  }

  /**
   * The iframe's viewport (its last stats) against this page's: a HUD drawn
   * at another scale falls back to the page. Judged only while this page's
   * viewport stays the same from one stats to the next (a window being
   * resized reaches the two documents a frame apart).
   */
  private checkViewport(frame: HudInit["viewport"]): void {
    const page = this.env!.viewport();
    const settled = this.lastPageViewport !== null && sameViewport(page, this.lastPageViewport);
    this.lastPageViewport = page;
    if (!settled || sameViewport(page, frame)) {
      this.viewportMisses = 0;
      return;
    }
    if (++this.viewportMisses >= VIEWPORT_MISSES) {
      this.fallBack(`viewport différent de la page : page ${viewportText(page)}, iframe ${viewportText(frame)}`);
    }
  }

  private settleWarmup(done: boolean): void {
    const waiter = this.warmupWaiter;
    if (!waiter) return;
    this.warmupWaiter = null;
    this.cancel(this.warmupTimer);
    this.warmupTimer = null;
    waiter(done);
  }

  /**
   * The frame attempt is over: the iframe goes away and the HUD runs in this
   * page — rebuilt from every command emitted so far until the warm-up is
   * over (they are kept until then), from the HUD's state after it (the
   * iframe's ongoing animations, medal, damage numbers… are gone with it).
   */
  private fallBack(reason: string): void {
    const lateFallback = this.phase === "frame";
    if (this.phase !== "connecting" && !lateFallback) return;
    const env = this.env!;
    env.warn(`[HUD] iframe abandonnée (${reason}) : HUD dans la page.`);
    for (const timer of [this.helloTimer, this.readyTimer, this.warmupTimer]) this.cancel(timer);
    this.helloTimer = this.readyTimer = this.warmupTimer = null;
    this.unlistenWindow?.();
    this.unlistenWindow = null;
    this.unlistenVisibility?.();
    this.unlistenVisibility = null;
    this.port?.close();
    this.port = null;
    this.frame?.remove();
    this.frame = null;
    this.stats = null;
    this.paintGpuMs = null;
    this.isolated = false;
    const waiter = this.pongWaiter;
    this.pongWaiter = null;
    waiter?.(null);
    // The kill effects still held go with this frame's batch (killCascade.ts).
    if (lateFallback) this.cascade?.drain((cmd) => this.emitNow(cmd));
    // Already posted (late fallback), then not posted yet, in order.
    if (lateFallback) this.buffer = [...(this.journal ?? this.state.values()), ...this.batch, ...this.buffer];
    this.batch = [];
    this.journal = [];
    this.viewportMisses = 0;
    this.lastPageViewport = null;
    this.goInline(reason);
    this.settleWarmup(false);
  }

  // ------------------------------------------------------------------
  // Inline mode
  // ------------------------------------------------------------------

  private goInline(reason: string): void {
    this.phase = "loading";
    this.inlineReason = reason;
    // Dynamic import: in frame mode the game page never loads the runtime.
    this.env!.importRuntime().then(
      (module) => {
        if (this.phase !== "loading") return;
        try {
          this.runtime = module.createHudRuntime();
        } catch (err) {
          this.die("HUD runtime could not be created", err);
          return;
        }
        if (this.initArgs) this.initInline();
      },
      (err) => this.die("HUD runtime could not be loaded", err),
    );
  }

  private initInline(): void {
    const runtime = this.runtime!;
    try {
      runtime.init({ ...this.initArgs!, viewport: this.env!.viewport() });
    } catch (err) {
      this.die("HUD runtime init failed", err);
      return;
    }
    this.phase = "inline";
    const cmds = this.buffer;
    this.buffer = [];
    // Replayed one by one: one failing command never drops the rest.
    for (const cmd of cmds) {
      try {
        runtime.run(cmd);
      } catch (err) {
        this.env!.error(`[HUD] command ${cmd[0]} failed`, err);
      }
    }
    this.settleDecided("inline");
  }

  private die(message: string, err: unknown): void {
    this.env!.error(`[HUD] ${message}: the match runs without HUD.`, err);
    this.phase = "dead";
    this.runtime = null;
    this.buffer = [];
    this.journal = null;
    this.settleDecided(null);
  }

  // ------------------------------------------------------------------
  // Timers
  // ------------------------------------------------------------------

  /**
   * `fn` after `ms`, then DEADLINE_GRACE_MS more (see there). The handle
   * cancels both stages.
   */
  private deadline(ms: number, fn: () => void): { stage: unknown } {
    const env = this.env!;
    const handle: { stage: unknown } = { stage: null };
    handle.stage = env.setTimeout(() => {
      handle.stage = env.setTimeout(fn, DEADLINE_GRACE_MS);
    }, ms);
    return handle;
  }

  private cancel(handle: unknown): void {
    if (handle !== null) this.env!.clearTimeout((handle as { stage: unknown }).stage);
  }

  // ------------------------------------------------------------------
  // Waiting for the mode
  // ------------------------------------------------------------------

  private settleDecided(mode: HudMode | null): void {
    const waiters = this.decidedWaiters.splice(0);
    for (const waiter of waiters) waiter(mode);
  }

  /** Resolves with the mode once final (null: no HUD). */
  private decided(): Promise<HudMode | null> {
    if (this.phase === "frame" || this.phase === "inline") return Promise.resolve(this.phase);
    if (this.phase === "dead") return Promise.resolve(null);
    return new Promise((resolve) => this.decidedWaiters.push(resolve));
  }

  /**
   * Like decided(), but null as soon as the page is (or becomes) hidden
   * while the mode is not final: a hidden tab draws nothing, so the warm-up
   * is skipped — as warmUpHud did — and the loading never waits for the
   * isolation check (which needs a shown page).
   */
  private decidedOrHidden(): Promise<HudMode | null> {
    if (this.phase === "frame" || this.phase === "inline" || this.phase === "dead") return this.decided();
    const env = this.env;
    if (!env || env.hidden()) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (mode: HudMode | null): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(mode);
      };
      const unsubscribe = env.onVisibilityChange(() => {
        if (env.hidden()) finish(null);
      });
      void this.decided().then(finish);
    });
  }

  /** This page's `<html>` class (also before start: the game page's document). */
  private setRootClass(name: string, on: boolean): void {
    if (this.env) this.env.setRootClass(name, on);
    else if (typeof document !== "undefined") document.documentElement.classList.toggle(name, on);
  }
}

/** The game page's HUD host (one per page). */
export const hudHost = new HudHost({ killCascade: optSwitch("killcascade").on });
