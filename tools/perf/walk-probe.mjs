// Walk probe: boots the REAL game in headless Chrome (Vite dev server must be
// running), enters solo play, then renders the world from a grid of eye
// positions / headings over the playable envelope through the dev-only
// perfDebug.renderCost handle, and reports the main-thread CPU cost of the
// render submission + draw calls / triangles per viewpoint.
//
//   node tools/perf/walk-probe.mjs [baseUrl=http://localhost:5173] [map=GIVRE] [quality=LOW]
//
// SwiftShader (CPU rasterizer) makes the GPU part meaningless: only the
// draw-call / triangle counts and the RELATIVE CPU submission cost matter.
import { launch } from "../hud-preview/cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const MAP = process.argv[3] ?? "GIVRE";
const QUALITY = process.argv[4] ?? "LOW";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ width: 960, height: 540, url: `${BASE}/` });
try {
  await b.eval(
    `localStorage.setItem("slideio.mapId", ${JSON.stringify(MAP)});` +
      `localStorage.setItem("beanzo.graphicsQuality", ${JSON.stringify(QUALITY)}); true`,
  );
  await b.send("Page.navigate", { url: `${BASE}/` });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    await sleep(1000);
    ready = await b.eval(`!!document.getElementById("menu-loading")?.classList.contains("hidden")`).catch(() => false);
  }
  if (!ready) throw new Error("the game never finished loading");
  await b.eval(`document.getElementById("menu-cta").click(); true`);
  await sleep(4000);

  const rows = [];
  for (const x of [-110, -60, 0, 60, 110]) {
    for (const z of [-110, -60, -10, 50]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const r = await b.eval(`perfDebug.renderCost(${x}, 1.7, ${z}, ${yaw}, ${Number(process.env.FRAMES ?? 1)})`);
        rows.push({ x, z, yaw: Math.round((yaw * 180) / Math.PI), ...r });
      }
    }
  }
  rows.sort((a, c) => c.calls - a.calls);
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  console.log(`${MAP} ${QUALITY}: ${rows.length} viewpoints · avg ${avg("calls").toFixed(0)} draws / ${(avg("tris") / 1000).toFixed(0)}k tris / ${avg("ms").toFixed(2)} ms submit`);
  console.log("worst 8 by draw calls:");
  for (const r of rows.slice(0, 8)) {
    console.log(`  (${r.x}, ${r.z}) yaw ${r.yaw}°: ${r.calls} draws, ${(r.tris / 1000).toFixed(0)}k tris, ${r.ms.toFixed(2)} ms`);
  }
  const w = rows[0];
  const yawRad = (w.yaw * Math.PI) / 180;
  const br = await b.eval(`perfDebug.drawBreakdown(${w.x}, 1.7, ${w.z}, ${yawRad})`);
  console.log(`breakdown of the worst view (${w.x}, ${w.z}) yaw ${w.yaw}°:`);
  for (const [k, v] of Object.entries(br).sort((a, c) => c[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
} finally {
  b.close();
}
process.exit(0);
