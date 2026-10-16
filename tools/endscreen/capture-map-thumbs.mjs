// Captures the end-screen vote thumbnails from the REAL game: boots the app
// on each map (Vite dev server must be running), hides the menu overlay and
// screenshots the cinematic menu-preview camera.
//
//   npx vite --port 5180 --strictPort        (other terminal)
//   node tools/endscreen/capture-map-thumbs.mjs [baseUrl=http://localhost:5180]
//
// Output: src/endscreen/maps/<map>.png (raw captures). Convert / crop them
// with tools/endscreen/encode-map-thumbs.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../hud-preview/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../src/endscreen/maps/raw");
mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] ?? "http://localhost:5180";
const MAPS = (process.env.MAPS ?? "JUNGLE,YARD,GIVRE").split(",");
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ width: W, height: H, url: `${BASE}/` });
try {
  for (const map of MAPS) {
    await b.eval(`localStorage.setItem("slideio.mapId", ${JSON.stringify(map)}); localStorage.setItem("beanzo.graphicsQuality", "HIGH"); true`);
    await b.send("Page.navigate", { url: `${BASE}/` });
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      await sleep(1000);
      ready = await b.eval(`!!document.getElementById("menu-loading")?.classList.contains("hidden")`).catch(() => false);
    }
    if (!ready) throw new Error(`${map}: the game never finished loading`);
    await b.eval(`for (const id of ["main-menu-root","mp-overlay","hud"]) { const e = document.getElementById(id); if (e) e.style.display = "none"; } true`);
    await sleep(Number(process.env.WAIT_MS ?? 6000)); // let the orbit settle + shadows bake
    const png = await b.shot({ x: 0, y: 0, width: W, height: H }, 1);
    writeFileSync(resolve(OUT, `${map.toLowerCase()}.png`), png);
    console.log(`captured ${map} (${png.length} bytes)`);
  }
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 6));
} finally {
  b.close();
}
process.exit(0);
