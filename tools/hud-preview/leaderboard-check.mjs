// Assertions on the REAL LeaderboardHUD in headless Chrome (virtual time).
//   node tools/hud-preview/leaderboard.mjs && node tools/hud-preview/leaderboard-check.mjs
import { open } from "./leaderboard-driver.mjs";

const { b, J, run, settle, play } = await open(1816);
const fails = [];
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) fails.push(msg);
};

try {
  await run("window.lb.setReduced(false)");
  await settle(200);
  ok((await run("window.lb.pending()")) === 0 && (await run("window.lb.animations()")) === 0, "rest: nothing pending, no running animation");
  let rows = await J("window.lb.rows()");
  ok(rows.length === 5 && (await run("window.lb.crowns()")) === 1, "5 rows, exactly one crown");
  ok(rows[0].crown && rows.filter((r) => r.crown).length === 1, "crown sits on rank 1");
  ok(new Set(rows.map((r) => Math.round(r.badgeX))).size === 1, "rank badges share one column");

  for (const id of await J("window.lb.ids")) {
    for (const reduced of [false, true]) {
      await run(`window.lb.setReduced(${reduced})`);
      await play(id, 2600);
      await settle(1500);
      rows = await J("window.lb.rows()");
      const label = `${id}${reduced ? " (reduced)" : ""}`;
      ok((await run("window.lb.pending()")) === 0, `${label}: pending back to 0`);
      ok((await run("window.lb.animations()")) === 0, `${label}: no animation left`);
      const wantCrowns = id === "newmatch" ? 0 : 1; // everyone at 0 after a reset: nobody leads yet
      ok((await run("window.lb.crowns()")) === wantCrowns, `${label}: crown count ${wantCrowns}`);
      ok((await run("window.lb.particles()")) === 0, `${label}: no particle left`);
      const ys = rows.map((r) => r.y);
      ok(ys.every((v, i) => i === 0 || v > ys[i - 1]), `${label}: rows ordered top to bottom`);
      ok(rows.every((r, i) => r.rank === String(i + 1)), `${label}: badges read 1..${rows.length}`);
      ok(rows.every((r) => Number(r.opacity) === 1), `${label}: all rows fully opaque`);
      // space BETWEEN capsules (the local row is taller by design, so subtract each row's own height)
      const gaps = ys.slice(1).map((v, i) => Math.round((v - ys[i] - rows[i].h) * 10) / 10);
      ok(Math.max(...gaps) - Math.min(...gaps) <= 0.6, `${label}: even gaps between capsules ${JSON.stringify(gaps)}`);
    }
  }

  await run("window.lb.setReduced(false); window.lb.setLongNames(true)");
  await play("long", 1200);
  await settle(1500);
  rows = await J("window.lb.rows()");
  const others = rows.filter((r) => r.name !== "VOUS");
  ok(new Set(others.map((r) => Math.round(r.scoreX))).size === 1, "long: score column x identical on every opponent row");
  ok(new Set(others.map((r) => Math.round(r.w))).size === 1, "long: opponent capsules keep one width");
  ok(rows.every((r) => r.scoreX + r.scoreW <= r.x + r.w + 1), "long: score stays inside its capsule");
  console.log("long rows:", rows.map((r) => `${r.name}=${r.score}`).join(" | "));
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  ok(errs.length === 0, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nall leaderboard checks passed");
} finally {
  b.close();
}
process.exit(fails.length ? 1 : 0);
