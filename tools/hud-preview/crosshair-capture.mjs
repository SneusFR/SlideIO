// Verification + captures of the REAL CrosshairHUD / HitmarkerHUD (see crosshair.mjs), virtual time.
//   node tools/hud-preview/crosshair-capture.mjs check                     numeric assertions on every scenario
//   node tools/hud-preview/crosshair-capture.mjs sheet <scenario> [stepMs=20] [frames=12] [bg=dark]
//   node tools/hud-preview/crosshair-capture.mjs states [bg=dark]           the 5 reference states, side by side
//   node tools/hud-preview/crosshair-capture.mjs bgs                        rest state on every background
// Env: REDUCED=1 (reduced motion)  CONTRAST=1 (high contrast)  SCALE=n (crosshair size)  OUT=dir
// Output: C:\Users\Sneus\AppData\Local\Temp\hudref\out  (override with OUT=...)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/out";
mkdirSync(OUT, { recursive: true });
const [, , mode = "check", a2 = "", a3 = "", a4 = "", a5 = ""] = process.argv;

const W = 1280;
const H = 720;
const b = await launch({ width: W, height: H, url: pathToFileURL(resolve(here, "crosshair.html")).href });
const run = (expr) => b.eval(expr);
const J = (expr) => b.eval(`JSON.stringify(${expr})`).then(JSON.parse);
const settle = async (ms) => {
  await run(`window.ch.step(${ms})`);
  await new Promise((r) => setTimeout(r, 30));
};
const reset = async () => {
  await b.send("Page.reload");
  await new Promise((r) => setTimeout(r, 1200));
  await run(
    `window.ch.options({reduced:${process.env.REDUCED === "1"},contrast:${process.env.CONTRAST === "1"},scale:${Number(process.env.SCALE) || 1}})`,
  );
  await settle(300); // let the option-driven transitions (e.g. contrast spacing) finish before sampling
};

/** Play a scenario frame by frame; onFrame(t) runs after each step. */
async function play(id, stepMs, onFrame, until) {
  const sc = await J(`window.ch.scenarios[${JSON.stringify(id)}]`);
  const pending = [...sc.steps].sort((x, y) => x.t - y.t);
  const end = until ?? sc.length;
  for (let t = 0; t <= end; t += stepMs) {
    while (pending.length && pending[0].t <= t) await run(`window.ch.apply(${JSON.stringify(pending.shift().do)})`);
    await onFrame(t);
    await settle(stepMs);
  }
  return sc;
}

const shot = async (zoom = 4) =>
  (await b.shot({ x: W / 2 - 60, y: H / 2 - 60, width: 120, height: 120 }, zoom)).toString("base64");

async function sheet(frames, labels, name) {
  const png = await run(`(async () => {
    const imgs = await Promise.all(${JSON.stringify(frames)}.map(async (s) => createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob())));
    const labels = ${JSON.stringify(labels)};
    const cols = Math.min(6, imgs.length), w = imgs[0].width, h = imgs[0].height, rows = Math.ceil(imgs.length / cols);
    const cv = document.createElement("canvas"); cv.width = cols * w; cv.height = rows * h;
    const g = cv.getContext("2d");
    imgs.forEach((im, i) => { g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h); g.strokeStyle = "#888"; g.strokeRect((i % cols) * w, Math.floor(i / cols) * h, w, h); g.fillStyle = "#0f0"; g.font = "bold 18px sans-serif"; g.fillText(labels[i], (i % cols) * w + 8, Math.floor(i / cols) * h + 22); });
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png, "base64"));
  console.log("wrote", `${OUT}/${name}.png`);
}

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

try {
  if (mode === "check") {
    const reduced = process.env.REDUCED === "1";
    // Sample every scenario at 8 ms: centre position, tick geometry, hitmarker opacity.
    const rec = {};
    for (const id of ["rest", "aim", "shot", "burst", "aimshot", "miss", "hit", "head", "kill", "tick"]) {
      await reset();
      const samples = [];
      await play(id, 8, async (t) => {
        const p = await J("window.ch.probe()");
        const g = await J("window.ch.bars()");
        const h = await J("window.ch.hm()");
        samples.push({ t, cx: p.cx, cy: p.cy, inner: g.inner[0], len: g.len[0], hmCls: h.cls, hm: h.opacity });
      });
      rec[id] = samples;
      const c0 = samples[0];
      ok(samples.every((s) => s.cx === c0.cx && s.cy === c0.cy), `${id}: le centre ne bouge jamais (${c0.cx}, ${c0.cy})`);
    }
    const rest = rec.rest[0].inner;
    const restLen = rec.rest[0].len;
    console.log(`repos: ecart interieur ${rest.toFixed(2)} px, longueur ${restLen.toFixed(2)} px`);
    const at = (id, t) => rec[id].find((s) => s.t >= t);
    const peak = (id, from, to) => rec[id].filter((s) => s.t >= from && s.t <= to).reduce((m, s) => (s.inner > m.inner ? s : m));

    // AIM
    const aimIn = at("aim", 40 + 136); // 125 ms after the aim started (+ one sample)
    ok(reduced ? true : aimIn.inner < rest - 1, `visee: traits resserres apres 125 ms (${aimIn.inner.toFixed(2)} < ${rest.toFixed(2)})`);
    ok(aimIn.len < restLen, `visee: traits plus courts (${aimIn.len.toFixed(2)} < ${restLen.toFixed(2)})`);
    if (!reduced) {
      const mid = at("aim", 40 + 56);
      ok(mid.inner < rest && mid.inner > aimIn.inner, "visee: transition progressive (pas un saut)");
    }
    const aimOut = at("aim", 400 + 200);
    ok(Math.abs(aimOut.inner - rest) < 0.3, "visee: retour a l'etat repos apres relachement");

    // SHOT (medium = 5 px)
    const pk = peak("shot", 20, 120);
    if (!reduced) {
      ok(pk.inner > rest + 3.5, `tir: impulsion visible (+${(pk.inner - rest).toFixed(2)} px)`);
      ok(pk.t - 20 >= 16 && pk.t - 20 <= 48, `tir: montee en ~32 ms (pic a +${pk.t - 20} ms)`);
    }
    const back = at("shot", 20 + 200 + 8);
    ok(Math.abs(back.inner - rest) < 0.2, `tir: retour complet apres 200 ms (${back.inner.toFixed(2)})`);

    // BURST: same peak every shot, no stacking
    if (!reduced) {
      const peaks = [0, 1, 2, 3, 4, 5, 6].map((k) => peak("burst", 20 + k * 100, 20 + k * 100 + 90).inner);
      ok(Math.max(...peaks) - Math.min(...peaks) < 0.2, `rafale: amplitude constante, pas d'empilement (${peaks.map((x) => x.toFixed(1)).join(" ")})`);
    }

    // AIM + SHOT: the pulse plays on top of the transition, ends back on the AIM spacing
    const asEnd = at("aimshot", 400);
    ok(asEnd.inner < rest - 1, "visee+tir: revient a l'ecart de visee, pas a celui du repos");

    // MISS: no hitmarker at all
    ok(rec.miss.every((s) => s.hm === 0), "tir rate: aucun marqueur d'impact");

    // HIT (body): armed only by the confirmation, fades inside 160 ms
    ok(rec.hit.filter((s) => s.t < 100).every((s) => s.hm === 0), "touche: rien avant la confirmation");
    ok(at("hit", 100 + 16).hm > 0.5, "touche: marqueur visible a la confirmation");
    ok(at("hit", 100 + 160 + 16).hm === 0, "touche: marqueur disparu apres 160 ms");

    // HEAD
    ok(at("head", 60 + 16).hmCls.includes("hm-head"), "tete: etat hm-head");
    ok(at("head", 60 + 160 + 16).hm === 0, "tete: disparu apres 160 ms");

    // KILL then a late non-lethal confirmation
    ok(rec.kill.filter((s) => s.t >= 150 && s.t <= 300).every((s) => s.hmCls.includes("hm-kill")), "elimination: non ecrasee par la touche tardive (+90 ms)");
    ok(at("kill", 60 + 130).hm > 0.5, "elimination: encore visible a +130 ms");
    ok(at("kill", 60 + 260 + 16).hm === 0, "elimination: disparue apres ~260 ms");

    // TICK (paintball): every ball restarts a short pulse that fully fades before the next
    const tickPulses = [60, 160, 260, 360].map((t0) => at("tick", t0 + 16).hm > 0.4 && at("tick", t0 + 92).hm < 0.1);
    ok(tickPulses.every(Boolean), "paintball: chaque bille = une pulsation courte qui retombe avant la suivante");

    console.log(failures ? `\n${failures} ECHEC(S)` : "\nTOUT PASSE");
  } else if (mode === "sheet") {
    const id = a2 || "shot";
    const stepMs = Number(a3) || 20;
    const frames = Number(a4) || 12;
    await reset();
    await run(`window.ch.bg(${JSON.stringify(a5 || "dark")})`);
    const shots = [];
    const labels = [];
    await play(id, stepMs, async (t) => {
      shots.push(await shot(3));
      labels.push(`${t} ms`);
    }, (frames - 1) * stepMs);
    const tag = `${process.env.REDUCED === "1" ? "-reduced" : ""}${process.env.CONTRAST === "1" ? "-contrast" : ""}`;
    await sheet(shots, labels, `cx-${id}-${stepMs}ms-${a5 || "dark"}${tag}`);
  } else if (mode === "states") {
    const bg = a2 || "dark";
    await reset();
    await run(`window.ch.bg(${JSON.stringify(bg)})`);
    const shots = [];
    const labels = [];
    const grab = async (label) => { shots.push(await shot(4)); labels.push(label); };
    await grab("repos");
    await run(`window.ch.apply({op:"aim",on:true})`); await settle(200); await grab("visee");
    await run(`window.ch.apply({op:"aim",on:false})`); await settle(200);
    await run(`window.ch.apply({op:"fire",kick:"heavy"})`); await settle(32); await grab("tir (pic)");
    await settle(400);
    await run(`window.ch.apply({op:"hit",zone:"BODY"})`); await settle(20); await grab("impact");
    await settle(400);
    await run(`window.ch.apply({op:"hit",zone:"BODY",kill:true})`); await settle(60); await grab("elimination");
    await sheet(shots, labels, `cx-states-${bg}${process.env.REDUCED === "1" ? "-reduced" : ""}${process.env.CONTRAST === "1" ? "-contrast" : ""}`);
  } else if (mode === "bgs") {
    await reset();
    const shots = [];
    const labels = [];
    for (const bg of await J("window.ch.backgrounds")) {
      await run(`window.ch.bg(${JSON.stringify(bg)})`);
      await run(`window.ch.apply({op:"hit",zone:"BODY"})`); await settle(16);
      shots.push(await shot(4)); labels.push(bg);
      await settle(300);
    }
    await sheet(shots, labels, `cx-bgs${process.env.CONTRAST === "1" ? "-contrast" : ""}`);
  }
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}
process.exit(failures ? 1 : 0);