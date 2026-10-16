// Captures the REAL killstreak capsules (see killstreaks.mjs) at the reference
// size and compares them with the reference frame.
//   node tools/hud-preview/killstreaks-capture.mjs [refPng] [width=1815] [height=866]
// Output (OUT, default C:/Users/Sneus/AppData/Local/Temp/hudref/ks):
//   real-<state>.png   full frame, flat background
//   onref-<state>.png  the real HUD drawn over the reference frame
//   overlay.png        reference vs real at 50 % opacity (column crop)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/ks";
mkdirSync(OUT, { recursive: true });
const REF = process.argv[2] ?? `${OUT}/ref.png`;
const W = Number(process.argv[3]) || 1815;
const H = Number(process.argv[4]) || 866;

const b = await launch({ width: W, height: H, url: pathToFileURL(resolve(here, "killstreaks.html")).href });
const ev = (js) => b.eval(js);
const caps = () => ev("JSON.stringify(window.ks.caps())").then(JSON.parse);
const shoot = async (name, clip = { x: 0, y: 0, width: W, height: H }) => writeFileSync(`${OUT}/${name}.png`, await b.shot(clip, 1));
const refUrl = existsSync(REF) ? `data:image/png;base64,${readFileSync(REF).toString("base64")}` : "";

try {
  await ev(`document.fonts.ready.then(() => true)`);
  const ALL = '["MOLE_STRIKE","ORBITAL_SCAN","NOVA_STRIKE"]';
  const log = async (label) => console.log(label.padEnd(26), JSON.stringify((await caps()).map((c) => `${c.id.slice(0, 4)} ${c.text}${c.ready ? " READY " + c.key : ""}`)));

  // 1) Reference state: 5 kills with the three streaks equipped.
  await ev(`window.ks.equip(${ALL}); window.ks.kills(5); window.ks.step(1000)`);
  await log("5 kills");
  console.log("geometry", JSON.stringify(await caps()));
  await shoot("real-5");
  if (refUrl) {
    await ev(`document.body.style.backgroundImage = "url(${refUrl})"; true`);
    await shoot("onref-5");
    // 50 % overlay: the real HUD at half opacity over the reference.
    await ev(`document.getElementById("right-hud-col").style.opacity = "0.5"; true`);
    await shoot("overlay", { x: W - 260, y: 380, width: 260, height: 486 });
    await ev(`document.getElementById("right-hud-col").style.opacity = ""; document.body.style.backgroundImage = ""; true`);
    // Side-by-side at 4x: reference column | real column (same clip).
    const clip = { x: 1620, y: 405, width: 180, height: 225 };
    const real = (await b.shot(clip, 4)).toString("base64");
    const sbs = await ev(`(async () => {
      const ref = await createImageBitmap(await (await fetch("${refUrl}")).blob());
      const im = await createImageBitmap(await (await fetch("data:image/png;base64,${real}")).blob());
      const c = document.createElement("canvas"); c.width = im.width * 2 + 8; c.height = im.height;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = "high";
      g.drawImage(ref, ${clip.x}, ${clip.y}, ${clip.width}, ${clip.height}, 0, 0, im.width, im.height);
      g.drawImage(im, im.width + 8, 0);
      return c.toDataURL("image/png").split(",")[1];
    })()`);
    writeFileSync(`${OUT}/sbs.png`, Buffer.from(sbs, "base64"));
  }

  // 2) Before threshold / at threshold / after use / death / equipment.
  await ev(`window.ks.death(); window.ks.kills(4); window.ks.step(500)`); await log("4 kills (before 5)"); await shoot("real-4");
  await ev(`window.ks.kills(1); window.ks.step(100)`); await log("5 kills (at threshold)");
  await shoot("pulse-100ms", { x: W - 260, y: 380, width: 260, height: 290 });
  await ev(`window.ks.step(400)`);
  console.log("animations after 500 ms:", await ev("window.ks.animations()"));
  await ev(`window.ks.kills(5); window.ks.step(500)`); await log("10 kills"); await shoot("real-10");
  await ev(`window.ks.use(0); window.ks.step(300)`); await log("Mole used (active)");
  await ev(`window.ks.finish(0); window.ks.step(300)`); await log("Mole finished (spent)"); await shoot("real-spent");
  await ev(`window.ks.kills(30); window.ks.step(500)`); await log("40 kills"); await shoot("real-25");
  console.log("fit 25/25", JSON.stringify((await caps()).map((c) => [c.text, c.textL, c.textR, c.keyL, c.keyR, c.w])));
  await ev(`window.ks.death(); window.ks.kills(24); window.ks.step(500)`);
  console.log("fit 24", JSON.stringify((await caps()).map((c) => [c.text, c.textL, c.textR, c.keyL, c.keyR, c.w])));
  await ev(`window.ks.kills(1); window.ks.step(500)`);
  await ev(`window.ks.death(); window.ks.step(300)`); await log("death"); await shoot("real-death");
  await ev(`window.ks.equip(["MOLE_STRIKE","NONE","NONE"]); window.ks.kills(2); window.ks.step(300)`); await log("loadout Mole only"); await shoot("real-mole-only");
  await ev(`window.ks.equip(["NONE","NONE","NONE"]); window.ks.step(300)`); await log("loadout empty");
  await ev(`window.ks.equip(["NONE","NOVA_STRIKE","MOLE_STRIKE"]); window.ks.kills(5); window.ks.step(500)`); await log("Nova X + Mole C");
  await shoot("real-swapped");

  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}
process.exit(0);
