// Captures the weapon plates through the REAL HUD classes (see weapons.mjs).
//   node tools/hud-preview/weapons-capture.mjs still  [weapon] [width]   → out/<weapon>.png at 2.2x
//   node tools/hud-preview/weapons-capture.mjs all                       → every weapon, 2.2x contact sheet frames
//   node tools/hud-preview/weapons-capture.mjs seq <weapon> <scenario>   → frame sequence (virtual time)
// Output: C:\Users\Sneus\AppData\Local\Temp\hudref\out  (override with OUT=…)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/out";
mkdirSync(OUT, { recursive: true });
const [, , mode = "still", arg1 = "paintball", arg2 = "1295", arg3 = "1200"] = process.argv;
const W = mode === "still" || mode === "all" ? Number(arg2) || 1295 : 1295;
const H = Math.round(W * 0.477);

const b = await launch({ width: W, height: H, url: pathToFileURL(resolve(here, "weapons.html")).href });
const crop = async (name, pad = 14, scale = Number(process.env.SCALE) || 2.2) => {
  const box = await b.eval("JSON.stringify(window.hud.box())").then(JSON.parse);
  const clip = { x: Math.max(0, box.x - pad - 30), y: Math.max(0, box.y - pad - 30), width: Math.min(W - Math.max(0, box.x - pad - 30), box.w + pad * 2 + 100), height: box.h + pad * 2 + 70 };
  const png = await b.shot(clip, scale);
  writeFileSync(`${OUT}/${name}.png`, png);
  return { clip, box };
};
const settle = (ms) => b.eval(`window.hud.step(${ms})`);

try {
  const fail = b.logs.filter((l) => /EXC|error/.test(l));
  if (fail.length) console.log("page logs:", fail.slice(0, 5));
  if (mode === "still") {
    await b.eval(`window.hud.show(${JSON.stringify(arg1)})`);
    await settle(Number(arg3) || 1200);
    const r = await crop(`${arg1}-${W}`);
    console.log("plate box", JSON.stringify(r.box), `(${((r.box.w / W) * 100).toFixed(1)}% of ${W}px)`);
  } else if (mode === "seq") {
    // seq <weapon> <scenario: shot|spam|reload|equip> [stepMs=50] [frames=16]
    const stepMs = Number(process.argv[5]) || 50;
    const frames = Number(process.argv[6]) || 16;
    const MAIN = { paintball: "ammo", popcorn: "ammo", water: "ammo", revolver: "currentAmmo", bass: "currentAmmo", frisbee: "cageCount", poison: "fillFraction", heat: "ratio" };
    const key = MAIN[arg1];
    await b.eval(`window.hud.show(${JSON.stringify(arg1)})`);
    await settle(1500);
    const st = await b.eval(`JSON.stringify(window.hud.state[${JSON.stringify(arg1)}])`).then(JSON.parse);
    const full = st[key];
    const dec = arg1 === "poison" ? 0.12 : arg1 === "heat" ? -0.12 : arg1 === "revolver" || arg1 === "frisbee" ? 1 : 1;
    const events = [];
    const set = (t, patch) => events.push({ t, js: `window.hud.set(${JSON.stringify(patch)})` });
    const cur = { v: full };
    const fire = (t) => { cur.v = Math.round((cur.v - dec) * 1000) / 1000; set(t, { [key]: cur.v }); };
    if (arg2 === "shot") fire(0);
    else if (arg2 === "spam") for (let i = 0; i < 8; i++) fire(i * 110);
    else if (arg2 === "reload") {
      fire(0);
      if ("isReloading" in st) { set(stepMs * 3, { isReloading: true }); set(stepMs * 9, { isReloading: false, [key]: full }); }
      else set(stepMs * 9, { [key]: full });
    } else if (arg2 === "equip") {
      events.push({ t: 0, js: `window.hud.show("heat"); window.hud.show(${JSON.stringify(arg1)})` });
    } else throw new Error("scenario: shot|spam|reload|equip");
    const shots = [];
    for (let i = 0; i < frames; i++) {
      const t = i * stepMs;
      for (const e of events) if (!e.done && e.t <= t) { await b.eval(e.js); e.done = true; }
      const clipPng = await (async () => {
        const box = await b.eval("JSON.stringify(window.hud.box())").then(JSON.parse);
        const clip = { x: Math.max(0, box.x - 44), y: Math.max(0, box.y - 44), width: Math.min(W - Math.max(0, box.x - 44), box.w + 128), height: box.h + 98 };
        return b.shot(clip, 1.4);
      })();
      shots.push(clipPng.toString("base64"));
      await settle(stepMs);
    }
    // contact sheet + per-frame difference measured in the page (pop detector)
    const res = await b.eval(`(async () => {
      const imgs = await Promise.all(${JSON.stringify(shots)}.map(async (s) => createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob())));
      const cols = 4, w = imgs[0].width, h = imgs[0].height, rows = Math.ceil(imgs.length / cols);
      const c = document.createElement("canvas"); c.width = cols * w; c.height = rows * h;
      const g = c.getContext("2d"); g.fillStyle = "#3c2518"; g.fillRect(0, 0, c.width, c.height);
      const diffs = []; let prev = null;
      const tmp = document.createElement("canvas"); tmp.width = w; tmp.height = h; const tg = tmp.getContext("2d", { willReadFrequently: true });
      imgs.forEach((im, i) => {
        g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h);
        g.fillStyle = "#fff"; g.font = "14px sans-serif"; g.fillText("#" + i, (i % cols) * w + 6, Math.floor(i / cols) * h + 16);
        tg.clearRect(0, 0, w, h); tg.drawImage(im, 0, 0);
        const d = tg.getImageData(0, 0, w, h).data;
        if (prev) { let s = 0; for (let k = 0; k < d.length; k += 4) s += Math.abs(d[k] - prev[k]) + Math.abs(d[k + 1] - prev[k + 1]) + Math.abs(d[k + 2] - prev[k + 2]); diffs.push(Math.round(s / (d.length / 4) * 100) / 100); }
        prev = d;
      });
      return JSON.stringify({ png: c.toDataURL("image/png").split(",")[1], diffs });
    })()`).then(JSON.parse);
    const name = `seq-${arg1}-${arg2}-${stepMs}ms`;
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.png, "base64"));
    console.log(name, "frame-to-frame mean diff:", res.diffs.join(" "));  } else if (mode === "all") {
    const ids = await b.eval("JSON.stringify(window.hud.ids)").then(JSON.parse);
    for (const id of ids) {
      await b.eval(`window.hud.show(${JSON.stringify(id)})`);
      await settle(1500);
      await crop(`all-${id}`);
      console.log("captured", id);
    }
  }
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}
