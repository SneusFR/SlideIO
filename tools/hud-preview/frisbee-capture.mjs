// Frisbee HUD (3D mechanism) validation captures through the REAL HUD classes
// (weapons.html, see weapons.mjs). The fake weapon follows the REAL launcher
// timeline (shared/combat/FrisbeeLauncherRules.ts): shot -> disc taken from the
// cage at 0.95 s -> seated on the deck at 1.29 s -> can fire again at 1.50 s;
// cage swap x1.5: cage full at 0.47 s.
//   node tools/hud-preview/frisbee-capture.mjs <scenario> [stepMs=33] [frames=16] [width=1920] [slow=1]
//   scenarios: still | shot | spam | last | refill | swap-cancel | equip
// Output: C:\Users\Sneus\AppData\Local\Temp\hudref\frisbee  (override with OUT=...)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/frisbee";
mkdirSync(OUT, { recursive: true });
const [, , scenario = "shot", stepArg = "33", framesArg = "16", widthArg = "1920", slowArg = "1"] = process.argv;
const stepMs = Number(stepArg) || 33;
const frames = Number(framesArg) || 16;
const W = Number(widthArg) || 1920;
const H = Math.round(W * 0.5625);
const SCALE = Number(process.env.SCALE) || 2;

const b = await launch({ width: W, height: H, url: pathToFileURL(resolve(here, "weapons.html")).href });
const step = (ms) => b.eval(`window.hud.step(${ms})`);

/** Fake launcher (mirrors FrisbeeLauncherController's ammo transitions). */
let w = { deckLoaded: true, cageCount: 5, discInHand: false, isReloading: false, shotSerial: 0 };
const push = (patch) => {
  w = { ...w, ...patch };
  return b.eval(`window.hud.set(${JSON.stringify(patch)})`);
};
/** A real shot: deck empties now; with a disc in the cage the re-cock takes it (0.95 s) and seats it (1.29 s). */
const shotEvents = (t0, withCage) => [
  { t: t0, p: () => ({ deckLoaded: false, shotSerial: w.shotSerial + 1 }) },
  ...(withCage
    ? [
        { t: t0 + 950, p: () => ({ cageCount: w.cageCount - 1, discInHand: true }) },
        { t: t0 + 1290, p: () => ({ discInHand: false, deckLoaded: true }) },
      ]
    : []),
];

try {
  await b.eval(`window.hud.show("frisbee")`);
  await b.eval(`window.hud.slow(${Number(slowArg) || 1})`);
  await step(800);
  const events = []; // { t, p() } ammo patch, or { t, js } raw page call
  const add = (list) => events.push(...list);
  const s0 = stepMs; // first event one frame after the first capture (frame 0 = rest)
  if (scenario === "still") {
    // rest state only
  } else if (scenario === "shot") add(shotEvents(s0, true));
  else if (scenario === "spam") {
    // Max real cadence = one shot every 1.50 s. Plus a forced burst of 3 serials in ONE frame (cannot happen in
    // game) to check the cap: one reaction, no accumulation.
    add(shotEvents(s0, true));
    add([{ t: s0 + stepMs * 3, p: () => ({ shotSerial: w.shotSerial + 3 }) }]);
  } else if (scenario === "last") {
    await push({ deckLoaded: true, cageCount: 0 });
    await step(600);
    add(shotEvents(s0, false));
  } else if (scenario === "refill") {
    await push({ deckLoaded: false, cageCount: 0 });
    await step(600);
    add([
      { t: s0, p: () => ({ isReloading: true }) },
      { t: s0 + 470, p: () => ({ cageCount: 5 }) }, // cageSwap 0.71 / 1.5
      { t: s0 + 1230, p: () => ({ cageCount: 4, discInHand: true }) }, // discTaken 1.85 / 1.5
      { t: s0 + 1460, p: () => ({ discInHand: false, deckLoaded: true }) }, // discSeated 2.19 / 1.5
      { t: s0 + 1650, p: () => ({ isReloading: false }) },
    ]);
  } else if (scenario === "swap-cancel") {
    await push({ deckLoaded: true, cageCount: 2 });
    await step(600);
    add([
      { t: s0, p: () => ({ isReloading: true }) },
      { t: s0 + 470, p: () => ({ cageCount: 5 }) },
      // interrupted before cageIn (weapon switch / knockdown) -> the old cage (2) is kept
      { t: s0 + 600, p: () => ({ isReloading: false, cageCount: 2 }) },
    ]);
  } else if (scenario === "equip") {
    add(shotEvents(s0, true));
    add([
      { t: s0 + 90, js: `window.hud.show("heat")` },
      { t: s0 + 400, js: `window.hud.show("frisbee")` },
    ]);
  } else throw new Error("scenario: still|shot|spam|last|refill|swap-cancel|equip");

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
    writeFileSync(`${OUT}/frisbee-${scenario}-${W}.png`, Buffer.from(shots[0], "base64"));
    console.log(`frisbee-${scenario}-${W}.png written`);
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
    const name = `seq-frisbee-${scenario}-${stepMs}ms`;
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res, "base64"));
    console.log(name, "written");
  }
  const errs = b.logs.filter((l) => /EXC|error/i.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}

