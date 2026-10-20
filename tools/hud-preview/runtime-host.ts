/**
 * Host page of the HUD runtime harness (runtime-harness.mjs): plays the GAME
 * PAGE's side of the HUD protocol (what src/hud/host does) for one mode —
 *   frame   the HUD in its sandboxed iframe (#hud-frame → /hud.html):
 *           handshake, init → ready, per-frame batches, warm-up, ping/pong,
 *           stats, errors;
 *   inline  the same runtime in this page, every command applied at once;
 *   old     the pre-change widgets (runtime-old-entry.ts, built from the
 *           commit before the iframe work), driven like Game drove them.
 * It mirrors the game page's own classes the host keeps (html.hud-menu-active
 * with #hud.menu-active, body.game-paused), fills the debug panel like
 * DebugHUD, and steps the HUD document's virtual clock (runtime-vt.js) after
 * every frame. Driven from the harness through `window.hh`.
 */
import { HUD_CONNECT, HUD_HELLO, type HudCommand, type HudInit, type HudRuntime, type HudUpMessage } from "../../src/hud/protocol";

interface VirtualTime {
  freeze(): void;
  advance(ms: number): void;
  rendered(frames?: number): Promise<void>;
}

type Mode = "frame" | "inline" | "old";

const HUD_FONTS = ['16px "Luckiest Guy"', ...[400, 500, 600, 700].map((w) => `${w} 16px "Baloo 2"`)];

export function startHost(local: (() => Promise<HudRuntime>) | null): void {
  const params = new URLSearchParams(location.search);
  const mode: Mode = local ? (params.get("mode") === "old" ? "old" : "inline") : "frame";
  /** Virtual time (runtime-vt.js) in the HUD document: this page (inline / old) or the iframe. */
  const virtual = params.get("vt") !== "0";
  /** Real frames drawn after each virtual frame in lockstep (`?settle=`). */
  const settle = Number(params.get("settle") ?? 2);
  const vt = (window as unknown as { __vt?: VirtualTime }).__vt ?? null;
  const errors: string[] = [];
  const stats: HudUpMessage[] = [];
  const log: string[] = [];
  let runtime: HudRuntime | null = null;
  let port: MessagePort | null = null;
  let iframe: HTMLIFrameElement | null = null;
  const pongs: ((frames: number) => void)[] = [];
  const renderedWaits: (() => void)[] = [];
  let onReady: ((ok: boolean) => void) | null = null;
  let onWarmed: (() => void) | null = null;
  const t0 = performance.now();

  const debug = document.getElementById("debug");
  if (debug) {
    // Like DebugHUD: one text node per line.
    for (const line of ["FPS: 240 / 244 Hz", "CPU 3.1 ms (sim 1.4 · rendu 1.7)", "Browser 0.4 ms · max 1.2", "World: 41 draws"]) {
      debug.appendChild(document.createTextNode(line + "\n"));
    }
  }

  function onUp(e: MessageEvent<HudUpMessage | { t: "__vt-rendered" }>): void {
    const msg = e.data;
    switch (msg.t) {
      case "pong":
        pongs.shift()?.(msg.frames);
        return;
      case "ready":
        log.push(`ready ${Math.round(performance.now() - t0)} ms`);
        onReady?.(true);
        return;
      case "warmup-done":
        log.push(`warmup-done ${msg.ms.toFixed(0)} ms`);
        onWarmed?.();
        return;
      case "stats":
        stats.push(msg);
        return;
      case "error":
        errors.push(msg.message);
        if (msg.message.startsWith("viewport")) onReady?.(false);
        return;
      case "__vt-rendered":
        renderedWaits.shift()?.();
        return;
    }
  }

  const post = (msg: unknown): void => {
    if (!port) throw new Error("not connected");
    port.postMessage(msg);
  };
  const ping = (): Promise<number> =>
    new Promise((resolve) => {
      pongs.push(resolve);
      post({ t: "ping" });
    });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** The game page's own mirror of the HUD's classes (src/hud/host's contract). */
  function mirror(cmd: HudCommand): void {
    if (cmd[0] !== "doc.class" || mode === "old") return;
    if (cmd[1] === "hud" && cmd[2] === "menu-active") document.documentElement.classList.toggle("hud-menu-active", cmd[3]);
    if (cmd[1] === "body" && cmd[2] === "game-paused") document.body.classList.toggle("game-paused", cmd[3]);
  }

  async function connect(src: string): Promise<void> {
    iframe = document.createElement("iframe");
    iframe.id = "hud-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "";
    iframe.src = src;
    const hello = new Promise<void>((resolve) => {
      const onHello = (e: MessageEvent): void => {
        if (e.source !== iframe?.contentWindow || !(e.data as Record<string, unknown>)?.[HUD_HELLO]) return;
        window.removeEventListener("message", onHello);
        resolve();
      };
      window.addEventListener("message", onHello);
    });
    document.body.appendChild(iframe);
    await hello;
    log.push(`hello ${Math.round(performance.now() - t0)} ms`);
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = onUp;
    iframe.contentWindow!.postMessage({ [HUD_CONNECT]: 1 }, "*", [channel.port2]);
  }

  const hh = {
    mode,
    errors,
    stats,
    log,
    /** Fonts the HUD draws with, loaded in this page (the iframe loads its own at init). */
    async loaded(): Promise<void> {
      await Promise.allSettled(HUD_FONTS.map((f) => document.fonts.load(f)));
      await document.fonts.ready;
    },
    /** Builds the HUD (init → ready in frame mode). False = refused (viewport). */
    async boot(init: Omit<HudInit, "viewport">, viewport?: HudInit["viewport"]): Promise<boolean> {
      const full: HudInit = {
        ...init,
        viewport: viewport ?? { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      };
      if (local) {
        runtime = await local();
        runtime.init(full);
        return true;
      }
      await connect(params.get("hud") ?? "/hud.html" + (virtual ? "" : "?vt=0"));
      // src/hud/host's isolation check runs here, before init (its counter
      // then includes the iframe's 4 ms timer ticks).
      const iso = await hh.isolationCheck(80);
      log.push(`isolation before init +${iso.n1 - iso.n0}`);
      const ok = new Promise<boolean>((resolve) => (onReady = resolve));
      post({ t: "init", init: full });
      return ok;
    },
    /** The HUD warm-up, its holds paced by virtual frames (or real ones without the virtual clock); `lockstep` as frames(). */
    async warmUp(frameMs: number, lockstep = false): Promise<void> {
      let done = false;
      if (runtime) {
        void runtime.warmUp(Promise.resolve()).then(() => (done = true));
        while (!done) {
          vt?.advance(frameMs);
          await (lockstep && vt ? vt.rendered(settle) : tick());
        }
        return;
      }
      const warmed = new Promise<void>((resolve) => (onWarmed = resolve));
      void warmed.then(() => (done = true));
      post({ t: "warmup" });
      post({ t: "gpu-idle" });
      while (!done) {
        if (virtual) post({ t: "__vt", ms: frameMs });
        if (lockstep && virtual) {
          await new Promise<void>((resolve) => {
            renderedWaits.push(resolve);
            post({ t: "__vt-rendered", frames: settle });
          });
        } else {
          await ping();
        }
        if (!virtual) await new Promise((r) => setTimeout(r, 16));
      }
    },
    /**
     * Game frames: each one's batch, then frameMs of HUD time. `lockstep`:
     * the HUD document draws (two real frames) after every one of them, in
     * every mode — the browser then draws the same sequence of states (a
     * layer's raster scale, for one, depends on the states it was drawn in).
     */
    async frames(list: { cmds: HudCommand[] }[], frameMs: number, lockstep = false): Promise<void> {
      for (const { cmds } of list) {
        for (const cmd of cmds) mirror(cmd);
        if (runtime) {
          runtime.apply(cmds);
          vt?.freeze();
          vt?.advance(frameMs);
          if (lockstep) await vt?.rendered(settle);
        } else {
          post({ t: "batch", cmds });
          if (virtual) post({ t: "__vt", ms: frameMs });
          if (lockstep && virtual) {
            await new Promise<void>((resolve) => {
              renderedWaits.push(resolve);
              post({ t: "__vt-rendered", frames: settle });
            });
          }
        }
      }
    },
    /** Everything sent is applied and drawn (two real frames of the HUD document). */
    async sync(): Promise<void> {
      if (runtime) {
        await vt?.rendered();
        return;
      }
      await ping();
      if (virtual) {
        await new Promise<void>((resolve) => {
          renderedWaits.push(resolve);
          post({ t: "__vt-rendered" });
        });
      }
      // (This page has no virtual clock in frame mode: real frames.)
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    },
    ping,
    /** Raw protocol message (error-path tests). */
    send(msg: unknown): void {
      post(msg);
    },
    /** Busy main thread for `ms` (the isolation check). */
    block(ms: number): number {
      const end = performance.now() + ms;
      let n = 0;
      while (performance.now() < end) n++;
      return n;
    },
    /** The iframe check of src/hud/host: frames counted across an 80 ms busy wait. */
    async isolationCheck(busyMs = 80): Promise<{ n0: number; n1: number }> {
      const n0 = await ping();
      hh.block(busyMs);
      const n1 = await ping();
      return { n0, n1 };
    },
  };
  (window as unknown as { hh: typeof hh }).hh = hh;
}
