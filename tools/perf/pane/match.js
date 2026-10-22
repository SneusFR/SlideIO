// After boot.js: menu → solo match with BOTS bots (default 8) → fake pointer lock (the game sees
// a locked pointer, synthetic mouse / keyboard work) → realplay.js calibrated. Needs the scripts
// probe-autopilot.js (window.__bz probe), realplay.js and, optionally, glcensus.js evaluated in the
// page first (localStorage keys __abScript / __rpScript / __gcScript if you stored them there).
// Returns { k: mouse units per radian, setup: debug-panel lines }.
(async (bots = 8) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.querySelector("#menu-cta"); i++) await sleep(500);
  await sleep(3000);
  for (const k of ["__abScript", "__rpScript", "__gcScript"]) {
    const src = localStorage.getItem(k);
    if (src) (0, eval)(src);
  }
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get() { return window.__fakeLock || null; } });
  const minus = document.getElementById("bots-minus"), plus = document.getElementById("bots-plus");
  for (let i = 0; i < 10 && minus; i++) { minus.click(); await sleep(60); }
  for (let i = 0; i < bots && plus; i++) { plus.click(); await sleep(60); }
  document.getElementById("menu-cta")?.click();
  await sleep(9000);
  const canvas = [...document.querySelectorAll("canvas")].sort((x, y) => y.width * y.height - x.width * x.height)[0];
  window.__fakeLock = canvas;
  document.dispatchEvent(new Event("pointerlockchange"));
  await sleep(1500);
  window.__rp.pickScene();
  const k = await window.__rp.calibrate();
  return { k, setup: (document.getElementById("debug")?.textContent || "").split("\n").filter((l) => /FPS|Setup|CPU|Render:/.test(l)) };
})
