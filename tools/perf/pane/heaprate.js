// Garbage produced per frame, from performance.memory (Chromium only; values are coarse):
// the heap's growth between 100 ms samples, summed (drops = collections), over `ms`.
//   const hr = (0, eval)(<this file>); await hr(10000)
//   → { MBps, KBperFrame, fps, drops, heapMB }
(async (ms) => {
  let last = performance.memory.usedJSHeapSize, grow = 0, drops = 0;
  const t0 = performance.now();
  let frames = 0;
  const f = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); };
  requestAnimationFrame(f);
  while (performance.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
    const h = performance.memory.usedJSHeapSize;
    if (h >= last) grow += h - last;
    else drops++;
    last = h;
  }
  return {
    MBps: +(grow / 1048576 / (ms / 1000)).toFixed(2),
    KBperFrame: +(grow / 1024 / Math.max(1, frames)).toFixed(1),
    fps: +(frames / (ms / 1000)).toFixed(1),
    drops,
    heapMB: +(last / 1048576).toFixed(1),
  };
})
