// Popcorn HUD (3D machine) validation captures through the REAL HUD classes
// (weapons.html, see weapons.mjs). The fake weapon follows the REAL shotgun:
// a shot drops ammo and bumps shotSerial in the same frame; a refused click at
// empty changes NOTHING; the reload (isReloading) refills at 1.75 s of 2.2 s.
//   node tools/hud-preview/popcorn-capture.mjs <scenario> [stepMs=30] [frames=16] [width=1920] [slow=1]
//   scenarios: still | shot | spam | last | empty-click | reload | cancel | equip
// Output: C:\Users\Sneus\AppData\Local\Temp\hudref\popcorn  (override with OUT=...)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/popcorn";
mkdirSync(OUT, { recursive: true });
const [, , scenario = "shot", stepArg = "30", framesArg = "16", widthArg = "1920", slowArg = "1"] = process.argv;
const stepMs = Number(stepArg) || 30;
const frames = Number(framesArg) || 16;
const W = Number(widthArg) || 1920;
const H = Math.round(W * 0.5625);
const SCALE = Number(process.env.SCALE) || 2;

const b = await launch({ width: W, height: H, url: pathToFileURL(resolve(here, "weapons.html")).href });
const step = (ms) => b.eval(`window.hud.step(${ms})`);

let w = { ammo: 2, isReloading: false, shotSerial: 0 };
const push = (patch) => {
  w = { ...w, ...patch };
  return b.eval(`window.hud.set(${JSON.stringify(patch)})`);
};
/** A real shot: ammo - 1 and shotSerial + 1 in the same frame. */
const shotNow = () => ({ ammo: w.ammo - 1, shotSerial: w.shotSerial + 1 });

try {
  await b.eval(`window.hud.show("popcorn")`);
  await b.eval(`window.hud.slow(${Number(slowArg) || 1})`);
  await step(800);
  const events = []; // { t, p() } ammo patch, or { t, js } raw page call
  const s0 = stepMs; // first event one frame after the first capture (frame 0 = rest)
  if (scenario === "still") {
    // rest state only
  } else if (scenario === "shot") events.push({ t: s0, p: shotNow });
  else if (scenario === "spam") {
    // Two shots 150 ms apart (faster than the real 580 ms cadence, to stress the restart), then a forced burst of 3 serials in ONE frame.
    await push({ ammo: 2 });
    events.push({ t: s0, p: shotNow }, { t: s0 + 150, p: () => ({ ammo: 2, shotSerial: w.shotSerial + 1 }) });
    events.push({ t: s0 + 300, p: () => ({ shotSerial: w.shotSerial + 3 }) });
  } else if (scenario === "last") {
    await push({ ammo: 1 });
    await step(400);
    events.push({ t: s0, p: shotNow });
  } else if (scenario === "empty-click") {
    await push({ ammo: 0 });
    await step(600);
    // the refused click changes nothing in the weapon data: ammo 0, same serial, no reload yet
    events.push({ t: s0, p: () => ({}) }, { t: s0 + 90, p: () => ({}) });
  } else if (scenario === "reload") {
    await push({ ammo: 0 });
    await step(600);
    events.push(
      { t: s0, p: () => ({ isReloading: true }) },
      { t: s0 + 1750, p: () => ({ ammo: 2 }) },
      { t: s0 + 2200, p: () => ({ isReloading: false }) },
    );
  } else if (scenario === "cancel") {
    await push({ ammo: 1 });
    await step(400);
    events.push(
      { t: s0, p: () => ({ isReloading: true }) },
      { t: s0 + 300, p: () => ({ isReloading: false }) }, // weapon switch before the refill: undone
    );
  } else if (scenario === "equip") {
    events.push({ t: s0, p: shotNow }, { t: s0 + 90, js: `window.hud.show("heat")` }, { t: s0 + 400, js: `window.hud.show("popcorn")` });
  } else throw new Error("scenario: still|shot|spam|last|empty-click|reload|cancel|equip");

  const shots = [];
  for (let i = 0; i < frames; i++) {
    const t = i * stepMs;
    for (const e of events) {
      if (e.done || e.t > t) continue;
      e.done = true;
      if (e.js) await b.eval(e.js);
      else await push(e.p());
    }
    const box = await b.eval("JSON.stringify(window.hud.box())").then(JSON.parse);
    const clip = { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 50), width: box.w + 70, height: box.h + 70 };
    shots.push((await b.shot(clip, SCALE)).toString("base64"));
    await step(stepMs);
  }
  if (frames === 1) {
    writeFileSync(`${OUT}/popcorn-${scenario}-${W}.png`, Buffer.from(shots[0], "base64"));
    console.log(`popcorn-${scenario}-${W}.png written`);
  } else {
    const res = await b.eval(`(async () => {
      const imgs = await Promise.all(${JSON.stringify(shots)}.map(async (s) => createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob())));
      const cols = 4, w = imgs[0].width, h = imgs[0].height, rows = Math.ceil(imgs.length / cols);
      const c = document.createElement("canvas"); c.width = cols * w; c.height = rows * h;
      const g = c.getContext("2d"); g.fillStyle = "#3c2518"; g.fillRect(0, 0, c.width, c.height);
      imgs.forEach((im, i) => {
        g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h);
        g.fillStyle = "#fff"; g.font = "16px sans-serif";
        g.fillText(i * ${stepMs} + " ms", (i % cols) * w + 6, Math.floor(i / cols) * h + 18);
      });
      return c.toDataURL("image/png").split(",")[1];
    })()`);
    const name = `seq-popcorn-${scenario}-${stepMs}ms`;
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res, "base64"));
    console.log(name, "written");
  }
  const errs = b.logs.filter((l) => /EXC|error/i.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}
