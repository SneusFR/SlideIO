/**
 * Entry of the HUD document (hud.html): the in-match HUD in its own iframe,
 * laid over the game canvas, which Chrome (site isolation) runs in its own
 * renderer process — the HUD's style / layout / paint run beside the game's
 * frame instead of after it. See src/hud/protocol.ts.
 *
 * - Handshake: HUD_HELLO to the parent once this module runs; the parent
 *   answers HUD_CONNECT with a MessagePort; everything else goes through it.
 * - `init` builds the HUD (after checking this document sees the game page's
 *   viewport), then `ready` once the HUD's fonts are in; each `batch` (one
 *   per game frame) is applied the moment it arrives, in order — the browser
 *   draws it at this document's next frame; `warmup` runs the HUD warm-up
 *   behind the loading screen (`gpu-idle`: the game's shader compile is over).
 * - `ping` → `pong` with a counter that runs on this document's own thread:
 *   the game's isolation check (does it keep growing while the game page's
 *   thread is blocked?).
 * - Every 500 ms: `stats` (this document's frame rate, command application
 *   and rendering time per frame). Errors are reported, never fatal; before
 *   `ready` only those that block the HUD (an error then makes the game fall
 *   back to the HUD in its page), the others once `ready` is sent.
 * The HUD never takes input: no focus, no keyboard, no storage (an opaque
 * origin has none).
 */
import { measureDisplayFrames } from "../../ui/displayFrames";
import { untilDrawn } from "../../ui/HudWarmup";
import {
  HUD_CONNECT,
  HUD_HELLO,
  type HudCommand,
  type HudDownMessage,
  type HudInit,
  type HudUpMessage,
} from "../protocol";
import { createHudRuntime } from "./HudRuntime";

const STATS_MS = 500;
/** A font server that never answers must not hold the HUD back. */
const FONT_WAIT_MS = 3000;
/** After the warm-up, the restored HUD's first frames: never longer than this (+0.1 s). */
const RESTORED_DRAWN_MS = 400;
/** The faces the HUD draws with (hud.html's Google Fonts families). */
const HUD_FONTS = ['16px "Luckiest Guy"', ...[400, 500, 600, 700].map((w) => `${w} 16px "Baloo 2"`)];
/** Viewport tolerance (src/hud/protocol.ts, HudInit.viewport). */
const VIEWPORT_PX = 1;
const VIEWPORT_DPR = 0.01;

const runtime = createHudRuntime();
let port: MessagePort | null = null;
let initialized = false;
/** init refused (viewport mismatch, init failure): the host falls back; later traffic is moot. */
let refused = false;
let readySent = false;
let warming = false;

// The warm-up's frame-interval measurement starts at load, while the game
// page mostly waits on downloads (main.ts does the same for its own).
void measureDisplayFrames();

let resolveGpuIdle: () => void = () => {};
/** The game page's shader compile is over (`gpu-idle`, possibly before `warmup`). */
const gpuIdle = new Promise<void>((resolve) => {
  resolveGpuIdle = resolve;
});

// ---------------------------------------------------------------------------
// Frames: a permanent counter (pong, stats) + the browser's work per frame.
// The loop never stops, which also matters to the HUD itself: with a frame
// callback always pending, Chrome keeps document.timeline's time at the last
// frame during the batches' message tasks (it would otherwise jump ahead to
// an estimated 60 Hz frame), so FramePulse / frameStamp() still restart an
// animation at most once per frame actually drawn, as in the game page.
// ---------------------------------------------------------------------------

let frames = 0;
/**
 * The isolation check (src/hud/host) pings, blocks the game page's thread
 * for 80 ms, pings again and wants the counter up by 3 or more. It runs
 * while the game loads, when the GPU process may be too busy (shader
 * compiles, uploads) to give this document frames even though it has its own
 * thread: rAF alone would then read "not isolated" and keep the HUD in the
 * page for the whole session. Until `init`, a 4 ms timer counts too — ~20
 * ticks in 80 ms on a thread of its own, whatever the GPU's load, none on the
 * game page's thread while it is blocked.
 */
let ticks = 0;
let tickTimer: number | null = window.setInterval(() => ticks++, 4);
let windowStart = performance.now();
let windowFrames = 0;
let applySum = 0;
let renderSum = 0;
let renderCount = 0;
/**
 * A message posted from a frame callback is delivered once the browser is
 * done with that frame's rendering steps (style, layout, paint, commit) and
 * the tasks queued before it — DebugHUD's "Browser" measure, for this document.
 */
const afterFrame = new MessageChannel();
afterFrame.port1.onmessage = (e: MessageEvent<number>) => {
  renderSum += performance.now() - e.data;
  renderCount++;
};

function onFrame(): void {
  requestAnimationFrame(onFrame);
  frames++;
  windowFrames++;
  const now = performance.now();
  afterFrame.port2.postMessage(now);
  if (now - windowStart >= STATS_MS) postStats(now);
}
requestAnimationFrame(onFrame);

function postStats(now: number): void {
  const elapsed = now - windowStart;
  if (port) {
    send({
      t: "stats",
      fps: (windowFrames * 1000) / elapsed,
      applyMs: applySum / Math.max(1, windowFrames),
      renderMs: renderCount > 0 ? renderSum / renderCount : 0,
      paintGpuMs: runtime.takePaintGpuMs(),
    });
  }
  windowStart = now;
  windowFrames = 0;
  applySum = 0;
  renderSum = 0;
  renderCount = 0;
}

// ---------------------------------------------------------------------------
// Handshake + messages
// ---------------------------------------------------------------------------

function onWindowMessage(e: MessageEvent): void {
  if (port || e.source !== window.parent || e.source === window) return;
  const data = e.data as Record<string, unknown> | null;
  const p = e.ports[0];
  if (!data || typeof data !== "object" || !data[HUD_CONNECT] || !p) return;
  window.removeEventListener("message", onWindowMessage);
  port = p;
  port.onmessage = onPortMessage; // (starts the port)
}
window.addEventListener("message", onWindowMessage);

function send(msg: HudUpMessage): void {
  port?.postMessage(msg);
}

function onPortMessage(e: MessageEvent<HudDownMessage>): void {
  const msg = e.data;
  try {
    switch (msg.t) {
      case "ping":
        send({ t: "pong", frames: frames + ticks });
        return;
      case "init":
        onInit(msg.init);
        return;
      case "batch":
        onBatch(msg.cmds);
        return;
      case "warmup":
        onWarmup();
        return;
      case "gpu-idle":
        resolveGpuIdle();
        return;
      default:
        throw new Error(`unknown HUD message: ${String((msg as { t?: unknown }).t)}`);
    }
  } catch (err) {
    reportError(err);
  }
}

function onInit(init: HudInit): void {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
  if (initialized || refused) return;
  // The HUD must be drawn at the game page's scale: same CSS viewport, same
  // device pixel ratio (browser zoom included). Anything else — the host
  // falls back to the HUD in the page, never a HUD at another scale.
  const v = init.viewport;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio;
  if (
    !v ||
    !(Math.abs(v.width - width) <= VIEWPORT_PX) ||
    !(Math.abs(v.height - height) <= VIEWPORT_PX) ||
    !(Math.abs(v.dpr - dpr) <= VIEWPORT_DPR)
  ) {
    refused = true;
    const page = v ? `${v.width}×${v.height} @${v.dpr}` : "none";
    send({ t: "error", message: `viewport mismatch: page ${page}, HUD frame ${width}×${height} @${dpr}` });
    return;
  }
  try {
    runtime.init(init);
  } catch (err) {
    // A half-built HUD: the game keeps it in its page instead.
    refused = true;
    reportError(err, true);
    return;
  }
  initialized = true;
  // Hidden behind the menu, the HUD lays out no text yet: nothing would ask
  // for its faces before the warm-up. Asked now, so the warm-up (and the
  // match) draw with them — this document shares no font cache with the page.
  void hudFontsLoaded().then(() => {
    send({ t: "ready" });
    readySent = true;
    for (const message of deferredErrors.splice(0)) send({ t: "error", message });
  });
}

function onBatch(cmds: HudCommand[]): void {
  if (!initialized) {
    if (!refused) reportError(new Error("HUD batch before init"));
    return;
  }
  const t0 = performance.now();
  try {
    runtime.apply(cmds);
  } catch (err) {
    reportError(err);
  }
  applySum += performance.now() - t0;
}

function onWarmup(): void {
  if (!initialized) {
    // Never leave the game waiting on a warm-up that cannot run.
    if (!refused) reportError(new Error("HUD warm-up before init"));
    send({ t: "warmup-done", ms: 0 });
    return;
  }
  if (warming) return;
  warming = true;
  const t0 = performance.now();
  // `warmup-done` lets the game page drop its loading screen. This document
  // reaches the screen apart from it: under a busy GPU process its last
  // frame on screen could still be a warm-up state (a KILL medal, a combo
  // tag over the menu) — so the restored HUD is drawn first (short cap).
  const done = (): void => {
    void untilDrawn(RESTORED_DRAWN_MS).then(() => send({ t: "warmup-done", ms: performance.now() - t0 }));
  };
  runtime.warmUp(gpuIdle).then(done, (err: unknown) => {
    reportError(err);
    done();
  });
}

/** Resolves once the HUD's faces are loaded (or failed, or FONT_WAIT_MS passed); never rejects. */
async function hudFontsLoaded(): Promise<void> {
  try {
    const fonts = document.fonts;
    if (!fonts) return;
    const loads = Promise.allSettled(HUD_FONTS.map((font) => fonts.load(font))).then(() => fonts.ready);
    await Promise.race([loads, new Promise((resolve) => window.setTimeout(resolve, FONT_WAIT_MS))]);
  } catch {
    /* no FontFaceSet: the HUD draws with whatever is there, as the page would */
  }
}

// ---------------------------------------------------------------------------
// Errors: reported to the game page (once per distinct message), never fatal.
// ---------------------------------------------------------------------------

const reported = new Set<string>();
/** Reported once `ready` is sent (an error before it makes the game fall back). */
const deferredErrors: string[] = [];

/** `blocker`: the HUD cannot run here (sent at once, even before `ready`). */
function reportError(err: unknown, blocker = false): void {
  const message = err instanceof Error ? err.message : String(err);
  if (reported.has(message) || reported.size >= 32) return;
  reported.add(message);
  console.error("[hud]", err);
  if (port && (readySent || blocker)) send({ t: "error", message });
  else deferredErrors.push(message);
}

window.addEventListener("error", (e) => reportError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

window.parent.postMessage({ [HUD_HELLO]: 1 }, "*");
