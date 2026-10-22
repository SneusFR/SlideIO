// The HUD document's frames on demand (src/hud/runtime/frameClock.ts) + FramePulse on its frame
// number (src/ui/framePulse.ts) — pure unit test, a fake requestAnimationFrame (no DOM).
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-frame-clock.mts
import assert from "node:assert/strict";

// A fake display: requestAnimationFrame queues, frame() runs the queue in order (callbacks
// registered meanwhile go to the next frame), like Chrome's animation frame callbacks.
let queue: (() => void)[] = [];
let now = 0;
const nativeRaf = (cb: () => void): number => {
  queue.push(cb);
  return queue.length;
};
const frame = (ms = 1000 / 60): void => {
  now += ms;
  const run = queue;
  queue = [];
  for (const cb of run) cb();
};
const plainRaf = (cb: FrameRequestCallback): number => nativeRaf(() => cb(now));
const setGlobalRaf = (raf: (cb: FrameRequestCallback) => number): void => {
  (globalThis as Record<string, unknown>).requestAnimationFrame = raf;
};
setGlobalRaf(plainRaf);

const { FrameClock } = await import("../src/hud/runtime/frameClock.ts");
const { FramePulse, setFrameStampSource, frameStamp } = await import("../src/ui/framePulse.ts");

let failures = 0;
const test = (name: string, fn: () => void): void => {
  queue = [];
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};
const make = (permanent = false) => new FrameClock({ requestFrame: nativeRaf, now: () => now }, permanent);

test("until the HUD is built, every frame is counted (isolation check); then nothing at rest", () => {
  const c = make();
  c.watch();
  for (let i = 0; i < 5; i++) frame();
  assert.equal(c.frames, 5);
  c.loopForever = false;
  frame(); // the pending callback runs once more, registers nothing
  assert.equal(c.frames, 6);
  assert.equal(queue.length, 0, "no frame callback pending at rest");
  for (let i = 0; i < 10; i++) frame();
  assert.equal(c.frames, 6, "no frame drawn, none counted");
});

test("?diag=nohudidle: the old permanent loop", () => {
  const c = make(true);
  c.loopForever = false;
  c.watch();
  for (let i = 0; i < 8; i++) frame();
  assert.equal(c.frames, 8);
  assert.equal(queue.length, 1);
});

test("frame number: every stamp before a frame reads the same, the next frame another", () => {
  const c = make();
  c.loopForever = false;
  const a = c.stamp();
  const b = c.stamp();
  assert.equal(a, b, "two batches before the same frame");
  assert.equal(queue.length, 1, "one callback for the frame");
  frame();
  const d = c.stamp();
  assert.notEqual(d, a, "a batch after the frame");
  assert.equal(c.stamp(), d);
});

test("requestAnimationFrame wrapped: this document's callback runs FIRST in the frame (the number has moved for every other callback)", () => {
  const c = make();
  c.loopForever = false;
  const raf = c.wrap(plainRaf);
  const seen: number[] = [];
  const before = c.frameNumber;
  raf(() => seen.push(c.frameNumber));
  raf(() => seen.push(c.frameNumber));
  frame();
  assert.deepEqual(seen, [before + 1, before + 1]);
  assert.equal(c.frames, 1, "one frame counted for two callbacks");
});

test("after a ping, frames are counted for a while, then the loop stops", () => {
  const c = make();
  c.loopForever = false;
  c.countFor(100);
  for (let i = 0; i < 12; i++) frame();
  const n = c.frames;
  assert.ok(n >= 6 && n <= 7, `${n} frames in ~100 ms`);
  assert.equal(queue.length, 0);
});

test("FramePulse on the frame number: two batches before one frame restart once; the next frame restarts again", () => {
  const c = make();
  c.loopForever = false;
  // As in the HUD document: requestAnimationFrame wrapped, the frame number as frameStamp().
  setGlobalRaf(c.wrap(plainRaf));
  setFrameStampSource(() => c.stamp());
  const restarts: boolean[] = [];
  const pulse = new FramePulse((restart) => restarts.push(restart));
  // Batch 1 and batch 2 of the same display frame (the game ran faster than the HUD drew).
  pulse.request();
  pulse.flush();
  pulse.request();
  pulse.flush();
  assert.deepEqual(restarts, [true, false], "the second one must not swap the twin back");
  frame(); // drawn; FramePulse's own fallback finds nothing pending
  pulse.request();
  pulse.flush();
  assert.deepEqual(restarts, [true, false, true]);
  frame();
  frame();
  assert.equal(queue.length, 0, "nothing pending once drawn");
  setFrameStampSource(null);
  setGlobalRaf(plainRaf);
});

test("FramePulse fallback (request outside a batch): applied in the next frame's callbacks, after the number moved", () => {
  const c = make();
  c.loopForever = false;
  setGlobalRaf(c.wrap(plainRaf));
  setFrameStampSource(() => c.stamp());
  const restarts: boolean[] = [];
  const pulse = new FramePulse((restart) => restarts.push(restart));
  pulse.request();
  pulse.flush(); // a batch's flush
  pulse.request(); // a request with no flush (no batch follows)
  frame(); // the fallback flushes it in this frame: another frame than the batch's
  assert.deepEqual(restarts, [true, true]);
  setFrameStampSource(null);
  setGlobalRaf(plainRaf);
});

test("frameStamp() without a source: document.timeline / performance.now (the game page)", () => {
  setFrameStampSource(null);
  assert.equal(typeof frameStamp(), "number");
});

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
