// HUD HOST × KILL CASCADE (src/hud/host/HudHost.ts + killCascade.ts) — through the real host and
// its facades, with a faked browser (timers, iframe, port): in frame mode a kill's HUD effects go
// out over the next batches (the frames measured on the PC gamer: hit 0 · medal +2 · BEANED! and
// combo +4 · killstreak +6 · leaderboard +8 at 240 Hz), the rest of each frame unchanged; the host
// without the option (the one test-hud-host.mts builds) and the inline mode are unchanged; a late
// fallback to the HUD in the page replays what was still held. No Vite (unlike test-hud-host.mts).
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-host-cascade.mts
import assert from "node:assert/strict";

const H = await import("../src/hud/host/HudHost.ts");
const { HUD_HELLO } = await import("../src/hud/protocol.ts");

let failures = 0;
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${(err as Error).stack}`);
  }
};
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Cmd = [string, ...unknown[]];
type Down = { t: string; cmds?: Cmd[] };

/** A faked browser, as in test-hud-host.mts (only what these checks need). */
function browser(opts: { search?: string } = {}) {
  let clock = 0;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const rafs: (() => void)[] = [];
  const windowListeners = new Set<(e: { source: unknown; data: unknown }) => void>();
  const frameWindow = { posted: [] as unknown[], postMessage(msg: unknown) { this.posted.push(msg); } };
  let rafFrames = 100;
  const port = {
    sent: [] as Down[],
    listener: null as ((data: unknown) => void) | null,
    postMessage(m: Down) {
      this.sent.push(structuredClone(m));
      if (m.t === "ping") queueMicrotask(() => this.listener?.({ t: "pong", frames: rafFrames }));
    },
    listen(fn: (data: unknown) => void) { this.listener = fn; },
    close() {},
  };
  const runtime = {
    calls: [] as unknown[],
    init(init: unknown) { this.calls.push(["init", init]); },
    apply(cmds: unknown[]) { for (const c of cmds) this.run(c); },
    run(cmd: unknown) { this.calls.push(cmd); },
    async warmUp() {},
    takePaintGpuMs() { return null; },
  };
  const env = {
    prod: true,
    search: opts.search ?? "",
    location: { protocol: "https:", hostname: "slideio.vercel.app", port: "" },
    now: () => clock,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ id, at: clock + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: (fn: () => void) => { rafs.push(fn); },
    busyWait: (ms: number) => { clock += ms; rafFrames += Math.floor(ms / (1000 / 60)); },
    hidden: () => false,
    onVisibilityChange: () => () => {},
    createFrame: (url: string, sandboxed: boolean) => ({ url, sandboxed, contentWindow: frameWindow, remove() {} }),
    onWindowMessage: (fn: (e: { source: unknown; data: unknown }) => void) => { windowListeners.add(fn); return () => windowListeners.delete(fn); },
    createChannel: () => ({ port1: port, port2: { name: "port2" } }),
    viewport: () => ({ width: 2844, height: 1600, dpr: 0.9 }),
    setRootClass: () => {},
    importRuntime: () => Promise.resolve({ createHudRuntime: () => runtime }),
    warn: () => {},
    error: () => {},
  };
  return {
    env, port, runtime,
    tick(ms: number) { clock += ms; },
    hello() { for (const fn of [...windowListeners]) fn({ source: frameWindow, data: { [HUD_HELLO]: 1 } }); },
    up(msg: unknown) { port.listener?.(msg); },
    batches() { return port.sent.filter((m) => m.t === "batch").map((m) => m.cmds as Cmd[]); },
  };
}

const INIT = { popcornShots: 2, paintballCapacity: 32, famasCapacity: 9, frisbeeCageCapacity: 5, interact: false, crosshair: { shape: "STICKER", scale: 1, color: "#fbf1da", highContrast: false, reducedMotion: false } };

async function readyFrame(b: ReturnType<typeof browser>, host: InstanceType<typeof H.HudHost>) {
  host.start(b.env as never);
  b.hello();
  host.init(INIT as never);
  await settle();
  b.up({ t: "ready" });
  await settle();
  assert.equal(host.mode, "frame");
}

/** A game frame: the frame's own commands, then the flush (one batch), `ms` later the next. */
function frame(b: ReturnType<typeof browser>, host: InstanceType<typeof H.HudHost>, fn: () => void = () => {}, ms = 1000 / 240) {
  fn();
  host.flush();
  b.tick(ms);
}

/** What a player's kill sends, through the real facades (Game.onBotKilled + HitFeedback + the frame's updates). */
function kill(host: InstanceType<typeof H.HudHost>, n: number) {
  const api = host.api;
  api.hitmarker.show("BODY" as never, 0.09, true);
  api.combat.notifyKill();
  api.combo.notifyKill();
  api.medal.show("KILL" as never, 0);
  api.killstreak.notifyReady(0);
  api.leaderboard.refresh([{ combatantId: 0, displayName: "YOU", isLocalPlayer: true, kills: n, deaths: 0, assists: 0 }] as never);
  api.clock.set(200 - n);
  api.combo.update({ active: true, comboCount: n, ratio: 1, timeRemaining: 5 } as never);
}

/** Batch index (after `from`) where each command first appears. */
function firstAt(batches: Cmd[][], from: number): Record<string, number> {
  const at: Record<string, number> = {};
  for (let k = from; k < batches.length; k++) for (const c of batches[k]) if (!(c[0] in at)) at[c[0]] = k - from;
  return at;
}

await test("frame mode, page host: a kill's effects over the next batches (240 Hz: 0 · 2 · 4 · 6 · 8), the frame's own commands in its batch", async () => {
  const b = browser();
  const host = new H.HudHost({ killCascade: true });
  await readyFrame(b, host);
  for (let i = 0; i < 120; i++) frame(b, host, () => host.api.clock.set(300)); // the play frames before (rate measured)
  const from = b.batches().length;
  frame(b, host, () => kill(host, 1));
  // (the clock changes every frame here, so that every frame posts a batch: indices = frames)
  for (let i = 0; i < 12; i++) frame(b, host, () => { host.api.clock.set(100 - i); host.api.combo.update({ active: true, comboCount: 1, ratio: 0.99 - i / 100, timeRemaining: 4.9 } as never); });
  assert.equal(b.batches().length - from, 13, "one batch per frame");
  const at = firstAt(b.batches(), from);
  assert.deepEqual(
    { hit: at["hitmarker.show"], clock: at["clock.set"], medal: at["medal.show"], sticker: at["combat.kill"], combo: at["combo.kill"], comboState: at["combo.update"], ks: at["killstreak.ready"], lb: at["leaderboard.refresh"] },
    { hit: 0, clock: 0, medal: 2, sticker: 4, combo: 4, comboState: 4, ks: 6, lb: 8 },
  );
  // the combo widget gets its kill first, then its states in order
  const combo = b.batches().slice(from).flat().filter((c) => c[0].startsWith("combo."));
  assert.equal(combo[0][0], "combo.kill");
  const ratios = combo.slice(1).map((c) => (c[1] as { ratio: number }).ratio);
  assert.deepEqual(ratios, [...ratios].sort((x, y) => y - x), "states in the order they were made");
});

await test("the host without the option (test-hud-host.mts) and the inline mode: everything at once, as before", async () => {
  const b = browser();
  const host = new H.HudHost();
  await readyFrame(b, host);
  for (let i = 0; i < 60; i++) frame(b, host, () => host.api.clock.set(300));
  const from = b.batches().length;
  frame(b, host, () => kill(host, 1));
  const at = firstAt(b.batches(), from);
  for (const name of ["hitmarker.show", "combat.kill", "combo.kill", "medal.show", "killstreak.ready", "leaderboard.refresh"]) assert.equal(at[name], 0, name);

  const bi = browser({ search: "?hud=inline" });
  const inline = new H.HudHost({ killCascade: true });
  inline.start(bi.env as never);
  inline.init(INIT as never);
  await settle();
  assert.equal(inline.mode, "inline");
  for (let i = 0; i < 60; i++) frame(bi, inline);
  inline.api.combat.notifyKill();
  assert.deepEqual(bi.runtime.calls.at(-1), ["combat.kill"], "inline: applied synchronously at the call, cascade or not");
});

await test("late fallback to the HUD in the page: what was still held is replayed after the frame's batch", async () => {
  const b = browser();
  const host = new H.HudHost({ killCascade: true });
  await readyFrame(b, host);
  const warm = host.warmUp(Promise.resolve());
  await settle();
  b.up({ t: "warmup-done", ms: 900 });
  await warm;
  for (let i = 0; i < 60; i++) frame(b, host, () => host.api.clock.set(300));
  frame(b, host, () => kill(host, 1)); // medal, sticker, combo, killstreak, leaderboard held
  const posted = b.batches().flat().map((c) => c[0]);
  assert.ok(!posted.includes("medal.show"), "the medal is still held");
  // The iframe stops seeing this page's viewport (3 stats in a row): HUD rebuilt in the page, now.
  for (let i = 0; i < 3; i++) b.up({ t: "stats", fps: 240, applyMs: 0.1, renderMs: 1, paintGpuMs: null, viewport: { width: 100, height: 100, dpr: 1 } });
  await settle(10);
  assert.equal(host.mode, "inline", "fell back");
  const calls = b.runtime.calls.map((c) => (Array.isArray(c) ? c[0] : c)) as string[];
  for (const name of ["medal.show", "combat.kill", "combo.kill", "killstreak.ready", "leaderboard.refresh"]) assert.ok(calls.includes(name), `${name} replayed to the HUD in the page`);
  // (state commands are also replayed first from the HUD's state: compare the last copies — the frame's)
  const order = ["combat.kill", "combo.kill", "medal.show", "killstreak.ready", "leaderboard.refresh"].map((n) => calls.lastIndexOf(n));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "in the order they were held");
});

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
