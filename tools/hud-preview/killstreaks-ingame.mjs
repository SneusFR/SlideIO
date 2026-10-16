// In-game capture of the killstreak capsules: boots the REAL game (Vite dev
// server must be running), clicks PLAY, then feeds kills through the dev-only
// ksDebug handle (→ the real KillstreakManager) and screenshots the frame.
//   node tools/hud-preview/killstreaks-ingame.mjs [baseUrl=http://localhost:5180] [width=1815] [height=866]
import { mkdirSync, writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";

const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/ks";
mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] ?? "http://localhost:5180";
const W = Number(process.argv[3]) || 1815;
const H = Number(process.argv[4]) || 866;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ width: W, height: H, url: `${BASE}/` });
try {
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(1000);
    ready = await b.eval(`!!document.getElementById("menu-loading")?.classList.contains("hidden")`).catch(() => false);
  }
  if (!ready) throw new Error("the game never finished loading");
  await b.eval(`document.getElementById("menu-cta").click(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await b.eval(`!document.getElementById("hud").classList.contains("menu-active")`)) break;
  }
  await sleep(1500);
  const shot = async (name) => writeFileSync(`${OUT}/${name}.png`, await b.shot({ x: 0, y: 0, width: W, height: H }, 1));
  const caps = () => b.eval(`JSON.stringify([...document.querySelectorAll("#killstreak-hud .ks-cap.on")].map((e) => e.dataset.ks + " " + e.querySelector(".ks-count").textContent + (e.classList.contains("ready") ? " READY " + e.querySelector(".ks-key").textContent : "")))`);
  console.log("loadout start ", await caps());
  await shot("ingame-0");
  await b.eval(`window.ksDebug.kill(3); true`); await sleep(600);
  console.log("3 kills       ", await caps());
  await shot("ingame-3");
  await b.eval(`window.ksDebug.kill(2); true`); await sleep(900);
  console.log("5 kills       ", await caps());
  await shot("ingame-5");
  const errs = b.logs.filter((l) => /EXC/.test(l));
  if (errs.length) console.log("page exceptions:", errs.slice(0, 6));
} finally {
  b.close();
}
process.exit(0);
