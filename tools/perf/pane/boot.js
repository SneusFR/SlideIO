// Loads the game in the CURRENT tab with the three.js devtools hook installed BEFORE the game's
// code runs (window.__obs = { renderers, scenes, mixers }: what realplay.js needs to find the
// world scene, the camera and the characters on a production build).
// Run it from a light page of the SAME origin, e.g. https://slide-io.vercel.app/assets/credit.js
// (a fresh window: no other copy of the game running). Optional config first:
//   window.__bootCfg = {
//     preset: "ultra" | "eleve" | "moyen" | "bas" | "auto",   // graphics preset to store
//     custom: { renderScale: 100, antialiasing: "fxaa", … },   // or explicit custom values
//     perfPanel: "full" | "fps" | "off",                       // debug panel
//     query: "?gpu&diag=…",                                    // address the game reads
//   };
// Settings are changed in localStorage (slideio.settings): back them up first and restore them after.
(async () => {
  const cfg = window.__bootCfg || {};
  const s = JSON.parse(localStorage.getItem("slideio.settings") || "null");
  if (s) {
    if (!localStorage.getItem("slideio.settings.bak-perf")) localStorage.setItem("slideio.settings.bak-perf", JSON.stringify(s));
    if (cfg.preset) s.graphics.preset = cfg.preset;
    if (cfg.custom) { s.graphics.preset = "custom"; s.graphics.custom = cfg.custom; }
    if (cfg.perfPanel) s.perfPanel = cfg.perfPanel;
    localStorage.setItem("slideio.settings", JSON.stringify(s));
  }
  const obs = { renderers: [], scenes: [], mixers: [], other: 0, revision: null };
  const hook = new EventTarget();
  hook.addEventListener("observe", (e) => {
    const d = e.detail;
    if (!d) return;
    if (d.isScene) obs.scenes.push(d);
    else if (typeof d.render === "function" && d.domElement) obs.renderers.push(d);
    else if (typeof d.clipAction === "function") obs.mixers.push(d);
    else obs.other++;
  });
  hook.addEventListener("register", (e) => { obs.revision = e.detail && e.detail.revision; });
  window.__THREE_DEVTOOLS__ = hook;
  window.__obs = obs;
  const html = await (await fetch("/", { cache: "no-store" })).text();
  history.replaceState(null, "", "/" + (cfg.query || ""));
  // document.open() keeps this Window (and the hook on it); the game's scripts then run in it.
  document.open();
  document.write(html);
  document.close();
  return "booted " + JSON.stringify(cfg);
})();
