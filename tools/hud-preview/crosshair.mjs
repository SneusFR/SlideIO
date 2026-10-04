// Builds tools/hud-preview/crosshair.html: the REAL HUD markup + stylesheets of index.html and the
// REAL CrosshairHUD / HitmarkerHUD bundled with esbuild (virtual clock first).
//   node tools/hud-preview/crosshair.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const { buildSync } = createRequire(resolve(root, "package.json"))("esbuild");

const bundle = buildSync({
  entryPoints: [resolve(here, "crosshair-entry.ts")],
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
hud = hud.replace('class="menu-active"', "");

const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"/g)].map((m) => m[1]);
// The sticker skin is an opt-in experiment (see build.mjs): `--sticker` loads it so the palette
// variables (--st-ink / --st-cream) are the real HUD ones.
if (process.argv.includes("--sticker")) sheets.push("src/hudSticker.css");
const styles = sheets.map((s) => `<style>${read(s)}</style>`).join("");

const page = `<!doctype html><html><head><meta charset="utf-8">
${styles}
<style>
html,body{margin:0;height:100%;overflow:hidden;background:linear-gradient(180deg,#1b1b24,#0b0b10)}
#hud>*:not(#crosshair){display:none!important}
#hud{position:fixed;inset:0}
#controls-hint,#debug{display:none!important}
</style></head><body>${hud}<script>${js}</script></body></html>`;
writeFileSync(resolve(here, "crosshair.html"), page);
console.log("crosshair.html written", page.length, "bytes; bundle", js.length);
