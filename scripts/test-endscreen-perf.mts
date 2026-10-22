/**
 * End-of-match performance switches (src/match/EndScreenPerf.ts): every change
 * on by default, each one turned off by its own `?diag=` value, all of them by
 * `oldendscreen`; other experiments never touch them. And the opacity scan of
 * the end screen's snapshot (EndScreen._scanBackdrop): the world is only
 * covered once EVERY pixel is known opaque, band by band, never in the
 * intro's first frame.
 * Run: tsx scripts/test-endscreen-perf.mts
 */
import assert from "node:assert/strict";
import { endScreenPerf } from "../src/match/EndScreenPerf";
import { perfExperiments } from "../src/ui/perfDiag";
// Plain JS modules of the end screen (no type declarations for their internals).
// @ts-ignore
import { EndScreen } from "../src/endscreen/EndScreen.js";
// @ts-ignore
import { Sfx, prewarmSfx } from "../src/endscreen/sfx.js";

const perf = (search: string) => endScreenPerf(perfExperiments(search));
const ALL = { warm: true, cover: true, skip: true, snap: true, layout: true };
const NONE = { warm: false, cover: false, skip: false, snap: false, layout: false };

assert.deepEqual(perf(""), ALL, "default: every change on");
assert.deepEqual(perf("?gpu&diag=noflush,scale50,empty"), ALL, "other experiments leave them on");
assert.deepEqual(perf("?diag=oldendscreen"), NONE, "oldendscreen: all off");
assert.deepEqual(perf("?diag=noendwarm"), { ...ALL, warm: false });
assert.deepEqual(perf("?diag=noendcover"), { ...ALL, cover: false });
assert.deepEqual(perf("?diag=noendskip"), { ...ALL, skip: false });
assert.deepEqual(perf("?diag=noendsnap"), { ...ALL, snap: false });
assert.deepEqual(perf("?diag=noendlayout"), { ...ALL, layout: false });
assert.deepEqual(perf("?diag=noendwarm,noendskip"), { ...ALL, warm: false, skip: false }, "several at once");
assert.deepEqual(perf("?diag= NoEndCover , scale50"), { ...ALL, cover: false }, "case and spaces ignored (perfExperiments)");
assert.deepEqual(perf("?diag=noendwarmx"), ALL, "an unknown value changes nothing");
assert.deepEqual(perf("?diag=oldendscreen,noendcover"), NONE);

// ---- opacity scan (EndScreen._scanBackdrop on a fake 2D context: RGBA rows)
type Scan = { _scan: { g: unknown; w: number; h: number; y: number; wait: number } | null; opts: { onBackdropOpaque: () => void } };
function scanOf(w: number, h: number, translucentAt: number | null, alpha = 254) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  if (translucentAt !== null) px[translucentAt * 4 + 3] = alpha;
  let reads = 0;
  let readPixels = 0;
  const g = {
    getImageData(x: number, y: number, ww: number, hh: number) {
      assert.equal(x, 0);
      assert.equal(ww, w);
      reads++;
      readPixels += ww * hh;
      return { data: px.subarray(y * w * 4, (y + hh) * w * 4) };
    },
  };
  let opaque = 0;
  const self: Scan = { _scan: { g, w, h, y: 0, wait: 1 }, opts: { onBackdropOpaque: () => opaque++ } };
  let frames = 0;
  while (self._scan && frames < 10000) {
    EndScreen.prototype._scanBackdrop.call(self);
    frames++;
  }
  return { opaque, frames, reads, readPixels };
}
{
  const r = scanOf(300, 200, null);
  assert.deepEqual([r.opaque, r.frames, r.reads, r.readPixels], [1, 2, 1, 60000], "small frame: one band, after a first frame without reading");
}
{
  // 2048 × 990 (a 2400 × 1160 game frame, capped at 2048): bands of 64 rows (131 072 px)
  const r = scanOf(2048, 990, null);
  assert.equal(r.opaque, 1, "opaque everywhere: reported once");
  assert.equal(r.reads, 16, "16 bands");
  assert.equal(r.frames, 17, "one band per frame, from the 2nd frame");
  assert.equal(r.readPixels, 2048 * 990, "every pixel read exactly once");
}
for (const [at, a] of [[0, 254], [2048 * 990 - 1, 254], [2048 * 500 + 7, 0], [123456, 128]] as const) {
  const r = scanOf(2048, 990, at, a);
  assert.equal(r.opaque, 0, `one translucent pixel (#${at}, alpha ${a}): never reported`);
  assert.equal(r.reads, Math.floor(Math.floor(at / 2048) / 64) + 1, `scan stops at the band holding pixel #${at}`);
}
{
  const r = scanOf(1, 5000, null);
  assert.deepEqual([r.opaque, r.reads], [1, 1], "a one-pixel-wide frame: bands of many rows, never 0");
}

// ---- the session's audio context (sfx.js, EndScreen warmIntro): opened once, ahead of the
// end of the match and only after a user gesture; every warm end screen uses it; the old path
// (not shared) still opens one per end screen.
let opened = 0;
class FakeAudioContext {
  state = "running";
  sampleRate = 16;
  destination = {};
  constructor() { opened++; }
  createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
  createDynamicsCompressor() { return { threshold: { value: 0 }, ratio: { value: 0 }, connect: (n: unknown) => n }; }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
}
const activation = { hasBeenActive: false };
Object.defineProperty(globalThis, "window", { value: { AudioContext: FakeAudioContext }, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: { userActivation: activation }, configurable: true });
prewarmSfx();
assert.equal(opened, 0, "no gesture yet: not opened (it would start suspended, with a warning)");
activation.hasBeenActive = true;
prewarmSfx();
prewarmSfx();
assert.equal(opened, 1, "after a gesture: opened once");
const a = new Sfx(true, 0.4);
a.shared = true;
const ctxA = a._ensure();
assert.equal(opened, 1, "a warm end screen uses the session's context");
assert.equal(a.master.gain.value, 0.4, "with its own volume");
a.setEnabled(false);
assert.equal(ctxA.state, "suspended");
const b = new Sfx(true, 0.55);
b.shared = true;
assert.equal(b._ensure(), ctxA, "the next one: the same context");
assert.equal(ctxA.state, "running", "woken up again");
assert.equal(b.master.gain.value, 0.55);
assert.equal(opened, 1, "still one context for the session");
const c = new Sfx(true, 0.55);
c._ensure();
const d = new Sfx(true, 0.55);
d._ensure();
assert.equal(opened, 3, "the old path (not shared): one new context per end screen, as before");
assert.notEqual(c.ctx, d.ctx);

console.log("test-endscreen-perf: OK (12 switch cases, 8 opacity-scan cases, 10 audio-context cases)");
