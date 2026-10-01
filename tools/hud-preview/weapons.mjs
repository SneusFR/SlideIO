// Builds tools/hud-preview/weapons.html: the REAL HUD markup + stylesheets of
// index.html and the weapon HUD classes bundled with esbuild (virtual clock
// first, so a driver can step time deterministically). Used by weapons-capture.mjs.
//   node tools/hud-preview/weapons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
// esbuild is a Vite dependency (hoisted in node_modules).
const { buildSync } = createRequire(resolve(root, "package.json"))("esbuild");

const bundle = buildSync({
  entryPoints: [resolve(here, "weapons-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});
const js = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");

const html = read("index.html");
let hud = html.slice(html.indexOf('<div id="hud"'), html.indexOf('<script type="module"'));
hud = hud.replace('class="menu-active"', "");

const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"/g)].map((m) => m[1]);
const styles = sheets.map((s) => `<style>${read(s)}</style>`).join("");

const page = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Baloo+2:wght@400;600;700&display=swap" rel="stylesheet">
${styles}
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#3b2415}
body{background:linear-gradient(90deg,#8a5a34 0%,#8a5a34 62%,#3b2415 62.5%,#3b2415 100%)}
#hud>*:not(#right-hud-col){display:none!important}
#hud #right-hud-col>*:not(#weapon-row){display:none!important}
#controls-hint,#debug,.hidden{display:none!important}
</style></head><body>${hud}<script>${js}</script></body></html>`;
writeFileSync(resolve(here, "weapons.html"), page);
console.log("weapons.html written", page.length, "bytes; bundle", js.length);
