// Builds a static HUD preview (tools/hud-preview/preview.html) from the real
// index.html HUD markup + the stylesheets index.html links, with the
// dynamic parts (weapon plate, killstreak medallion, leaderboard rows) mocked
// with the same DOM the *HUD classes produce. Screenshot with headless Chrome:
//   node tools/hud-preview/build.mjs
//   chrome --headless --screenshot=out.png --window-size=1295,620 preview.html
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const html = read("index.html");
let hud = html.slice(html.indexOf('<div id="hud"'), html.indexOf('<script type="module"'));
hud = hud.replace('class="menu-active"', "");

// Portrait (extract the BEAN_BUDDY_SVG template, resolve ${INK}).
const icons = read("src/ui/hudIcons.ts");
const INK = "#3a2814";
const tpl = (name) => {
  const s = icons.indexOf(`export const ${name} = \``) + `export const ${name} = \``.length;
  return icons.slice(s, icons.indexOf("`;", s)).replaceAll("${INK}", INK).replace(/\$\{o\((\d+(?:\.\d+)?)\)\}/g,
    (_, w) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`);
};
const buddy = tpl("BEAN_BUDDY_SVG");
const O = `stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
const gun = `<svg class="wpn-icon-art" viewBox="0 0 48 48"><path d="M5 25h25l6-4h6v9h-6l-2 2H21l-3 10h-8l3-10H5z" fill="#ff5fa2" ${O}/><circle cx="21" cy="14" r="8" fill="#ffd23f" ${O}/></svg>`;
const paint = ["#ff4d6d", "#ffd23f", "#3ee0c5"];
const balls = Array.from({ length: 8 }, (_, i) => `<span class="ammo-pip on" style="--pip:${paint[i % 3]}"></span>`).join("");
const plate = `
<div id="paintball-rifle-hud" class="wpn-plate is-visible" data-icon="paintball" style="--wpn:#ff5fa2">
  <div class="wpn-splat"></div>
  <div class="wpn-fx">${"<i></i>".repeat(6)}</div>
  <div class="wpn-burst">${"<i></i>".repeat(6)}</div>
  <div class="wpn-badge"><div class="wpn-ring"></div><div class="wpn-badge-face">${gun}</div></div>
  <div class="wpn-body">
    <div class="wpn-ribbon"><span class="wpn-name">PAINTBALL</span></div>
    <div class="wpn-main">
      <div class="wpn-count"><span class="wpn-count-value">32</span><span class="wpn-count-max">/32</span></div>
      <div class="wpn-ammo"><div class="ammo-pips ammo-ball">${balls}</div></div>
    </div>
  </div>
  <div class="wpn-stamp">RELOAD!</div>
</div>`;
const medal = `
<div id="killstreak-hud"><div class="ks-medal locked">
  <div class="ks-rays"></div><div class="ks-confetti"></div>
  <svg class="ks-ring" viewBox="0 0 80 80"><circle class="ks-ring-track" cx="40" cy="40" r="35"/></svg>
  <div class="ks-disc"><div class="ks-art"><svg class="ks-icon-art" viewBox="0 0 64 64"><circle cx="32" cy="36" r="16" fill="#c98a4a" ${O}/></svg></div>
  <span class="ks-count">1/5</span><span class="ks-used">USED</span></div>
  <span class="ks-key">W</span></div></div>`;
const rows = [["1", "BOT 1", 19], ["2", "BOT 3", 15], ["3", "BOT 4", 14], ["4", "BOT 2", 12]]
  .map(([r, n, k], i) => `<div class="lb-row" style="transform:translateY(${i * 28}px)"><span class="lb-rank">${r}</span><span class="lb-ping"></span><span class="lb-name">${n}</span><span class="lb-k">${k}</span><span class="lb-d">0</span><span class="lb-a">0</span><span class="lb-kd">0</span></div>`)
  .join("") +
  `<div class="lb-row local" style="transform:translateY(${4 * 28}px)"><span class="lb-rank">5</span><span class="lb-ping"></span><span class="lb-name"><span class="lb-avatar">${buddy}</span><span class="lb-you">VOUS</span></span><span class="lb-k">4</span><span class="lb-d">0</span><span class="lb-a">0</span><span class="lb-kd">0</span></div>`;

hud = hud
  .replace('<div id="buddy-portrait"></div>', `<div id="buddy-portrait">${buddy}</div>`)
  .replace('<div id="buddy-name">PLAYER</div>', '<div id="buddy-name">VALENTIN</div>')
  .replace('<div id="health-value">100</div>', "")
  .replace('<span id="health-value">100</span>', '<span id="health-value">79</span>')
  .replace('<div id="health-fill"></div>', '<div id="health-fill" style="transform:scaleX(0.79)"></div>')
  .replace('<div id="health-ghost"></div>', '<div id="health-ghost" style="transform:scaleX(0.79)"></div>')
  .replace('<div id="dash-status"></div>', '<div id="dash-status">PR\u00caT</div>')
  .replace('<div id="right-hud-col">', `<div id="right-hud-col">${medal}`)
  .replace('<div id="weapon-slot"></div>', `<div id="weapon-slot">${plate}</div>`)
  .replace('<div id="leaderboard-hud" class="hidden">', '<div id="leaderboard-hud">')
  .replace('<div id="leaderboard-rows"></div>', `<div id="leaderboard-rows" style="height:${5 * 28}px">${rows}</div>`)
  .replace('<div id="crosshair"></div>', '<div id="crosshair" class="cross" style="--ch-color:#35e0f2"></div>')
  .replace('<div id="death-screen" class="hidden">', '<div id="death-screen" class="hidden" style="display:none">');

// Same stylesheets as the game (the <link>s of index.html); the untracked
// sticker skin experiment is opt-in: `node build.mjs --sticker`.
const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"/g)].map((m) => m[1]);
if (process.argv.includes("--sticker")) sheets.push("src/hudSticker.css");
const styles = sheets.map((s) => `<style>${read(s)}</style>`).join("");

const page = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Baloo+2:wght@400;600;700&display=swap" rel="stylesheet">
${styles}
<style>body{margin:0;background:linear-gradient(180deg,#6a3f8a 0%,#c07a9a 45%,#b98556 46%,#8a6038 100%);height:100vh;overflow:hidden}
#controls-hint,#debug,.hidden{display:none!important}</style></head><body>${hud}</body></html>`;
writeFileSync(resolve(here, "preview.html"), page);
console.log("preview.html written", page.length);
