// Builds tools/hud-preview/leaderboard.html: the REAL HUD markup + stylesheets of
// index.html and the REAL LeaderboardHUD bundled with esbuild (virtual clock first).
//   node tools/hud-preview/leaderboard.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const { buildSync } = createRequire(resolve(root, "package.json"))("esbuild");

const bundle = buildSync({
  entryPoints: [resolve(here, "leaderboard-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: false,
  logLevel: "warning",
});
const js = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");

const html = read("index.html");
let hud = html.slice(html.indexOf('<div id="hud"'), html.indexOf('<script type="module"'));
hud = hud.replace('class="menu-active"', "").replace('<div id="leaderboard-hud" class="hidden">', '<div id="leaderboard-hud">');

const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"/g)].map((m) => m[1]);
const styles = sheets.map((s) => `<style>${read(s)}</style>`).join("");

// BG env: "flat" (default, brown) keeps comparisons clean; the capture script can
// also paste the reference frame behind via a data URL when asked.
const page = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Baloo+2:wght@400;600;700;800&display=swap" rel="stylesheet">
${styles}
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#7a4d2b}
#hud>*:not(#leaderboard-hud){display:none!important}
#controls-hint,#debug{display:none!important}
</style></head><body>${hud}<script>${js}</script></body></html>`;
writeFileSync(resolve(here, "leaderboard.html"), page);
console.log("leaderboard.html written", page.length, "bytes; bundle", js.length);
