// Screenshots of the REAL LeaderboardHUD (see leaderboard.mjs), virtual time.
//   node tools/hud-preview/leaderboard-capture.mjs still [scenario] [width]
//   node tools/hud-preview/leaderboard-capture.mjs seq <scenario> [stepMs=40] [frames=20] [slow=1]   (REDUCED=1 for reduced motion)
// Output: C:\Users\Sneus\AppData\Local\Temp\hudref\out  (override with OUT=...)
import { mkdirSync, writeFileSync } from "node:fs";
import { open } from "./leaderboard-driver.mjs";

const OUT = process.env.OUT ?? "C:/Users/Sneus/AppData/Local/Temp/hudref/out";
mkdirSync(OUT, { recursive: true });
const [, , mode = "still", id = "single", a3 = "", a4 = "", a5 = ""] = process.argv;
const W = mode === "still" ? Number(a3) || 1816 : 1816;
const { b, run, settle, box, play } = await open(W);
const reduced = process.env.REDUCED === "1";

try {
  await run(`window.lb.setReduced(${reduced})`);
  if (mode === "still") {
    await play(id, 3000);
    await settle(1500);
    const c = await box();
    writeFileSync(`${OUT}/lb-${id}-${W}.png`, await b.shot({ x: c.x, y: c.y, width: c.width, height: c.height }, Number(process.env.SCALE) || 2));
    console.log("box", JSON.stringify(c.bx), `(${((c.bx.w / W) * 100).toFixed(1)}% of ${W}px)`);
  } else {
    const stepMs = Number(a3) || 40;
    const frames = Number(a4) || 20;
    const slow = Number(a5) || 1;
    await run(`window.lb.setSlow(${slow})`);
    const shots = [];
    const c = await box(30);
    await play(id, (frames - 1) * stepMs, async () => {
      shots.push((await b.shot({ x: c.x, y: c.y, width: c.width, height: c.height }, 1.2)).toString("base64"));
    }, stepMs);
    const png = await run(`(async () => {
      const imgs = await Promise.all(${JSON.stringify(shots)}.map(async (s) => createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob())));
      const cols = 5, w = imgs[0].width, h = imgs[0].height, rows = Math.ceil(imgs.length / cols);
      const cv = document.createElement("canvas"); cv.width = cols * w; cv.height = rows * h;
      const g = cv.getContext("2d"); g.fillStyle = "#3c2518"; g.fillRect(0, 0, cv.width, cv.height);
      imgs.forEach((im, i) => { g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h); g.fillStyle = "#fff"; g.font = "13px sans-serif"; g.fillText("#" + i, (i % cols) * w + 4, Math.floor(i / cols) * h + 13); });
      return cv.toDataURL("image/png").split(",")[1];
    })()`);
    const name = `lb-seq-${id}-${stepMs}ms${slow > 1 ? "-x" + slow : ""}${reduced ? "-reduced" : ""}`;
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(png, "base64"));
    console.log("wrote", name);
  }
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 8));
} finally {
  b.close();
}
process.exit(0);
