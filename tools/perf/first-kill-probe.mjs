// First-kill hitch probe: boots the REAL game in headless Chrome (Vite dev
// server must be running), enters solo play on the selected map, then kills
// bots one by one through the dev-only perfDebug handle (the real death
// path) and reports, per kill: the synchronous JS time of the kill itself,
// the shader programs compiled by the NEXT frames, and the longest frame.
//
//   npx vite --port 5173                         (other terminal)
//   node tools/perf/first-kill-probe.mjs [baseUrl=http://localhost:5173] [map=GIVRE] [quality=LOW]
//
// Headless Chrome renders with SwiftShader (CPU): absolute frame times are
// meaningless — the PROGRAM COUNT deltas and the kill-call JS time are what
// this probe is for (a lazy compile shows up as +N programs on a kill).
import { launch } from "../hud-preview/cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const MAP = process.argv[3] ?? "GIVRE";
const QUALITY = process.argv[4] ?? "LOW";
const KILLS = Number(process.env.KILLS ?? 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ width: 1280, height: 720, url: `${BASE}/` });
try {
  await b.eval(
    `localStorage.setItem("slideio.mapId", ${JSON.stringify(MAP)});` +
      `localStorage.setItem("beanzo.graphicsQuality", ${JSON.stringify(QUALITY)}); true`,
  );
  await b.send("Page.navigate", { url: `${BASE}/` });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    await sleep(1000);
    ready = await b.eval(`!!document.getElementById("menu-loading")?.classList.contains("hidden")`).catch(() => false);
  }
  if (!ready) throw new Error("the game never finished loading");
  await b.eval(`document.getElementById("menu-cta").click(); true`);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await b.eval(`!document.getElementById("hud").classList.contains("menu-active")`)) break;
  }
  await sleep(3000); // bots spawned, assets settled

  // Frame-time recorder (rAF deltas) living in the page.
  await b.eval(`(() => {
    window.__ft = [];
    let last = performance.now();
    const tick = (t) => { window.__ft.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return true;
  })()`);
  await sleep(1500);
  console.log(`map ${MAP} · ${QUALITY} · programs at start: ${await b.eval("perfDebug.programs()")}`);

  await b.send("Profiler.enable");
  await b.send("Profiler.setSamplingInterval", { interval: 100 });
  /** Top self-time functions of a CPU profile (ms). */
  const top = (profile, n = 12) => {
    const self = new Map();
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
    const dt = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    }
    for (const [id, ms] of dt) {
      const cf = byId.get(id).callFrame;
      const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + ms);
    }
    return [...self].sort((a, b2) => b2[1] - a[1]).slice(0, n).map(([k, v]) => `    ${v.toFixed(1).padStart(6)} ms  ${k}`).join("\n");
  };

  for (let k = 1; k <= KILLS; k++) {
    const before = await b.eval("perfDebug.programs()");
    const progNamesBefore = new Set(await b.eval("perfDebug.programNames()"));
    const texBefore = await b.eval("perfDebug.textures()");
    const sceneTexBefore = await b.eval("perfDebug.sceneTextures()");
    await b.send("Profiler.start");
    const r = await b.eval(`(() => {
      window.__ft.length = 0;
      const t0 = performance.now();
      const ok = perfDebug.killBot();
      return { ok, ms: performance.now() - t0 };
    })()`);
    await sleep(1200); // corpse + loot rendered for a while
    const { profile } = await b.send("Profiler.stop");
    if (k <= 2 || process.env.PROFILE_ALL) console.log(`  top self time (kill ${k} + 1.2 s):\n${top(profile)}`);
    const sceneTexAfter = await b.eval("perfDebug.sceneTextures()");
    for (const [uuid, t] of Object.entries(sceneTexAfter)) {
      const prev = sceneTexBefore[uuid];
      if (!prev) console.log(`  NEW texture in scene: ${t.name} ${t.size} uploaded=${t.uploaded} (${t.owner})`);
      else if (!prev.uploaded && t.uploaded) console.log(`  LAZY UPLOAD: ${t.name} ${t.size} (${t.owner})`);
    }
    const after = await b.eval("perfDebug.programs()");
    const fresh = [];
    for (const p of await b.eval("perfDebug.programNames()")) {
      if (!progNamesBefore.has(p)) {
        console.log(`  NEW PROGRAM: ${p.slice(0, 90)}`);
        fresh.push(Number(/#(\d+)/.exec(p)?.[1]));
      }
    }
    if (fresh.length) {
      for (const line of await b.eval(`perfDebug.whoUses(${JSON.stringify(fresh)})`)) console.log(`    used by ${line}`);
      // Why did a twin compile? Diff its key against the same-name programs.
      const names = new Set((await b.eval("perfDebug.programNames()")).filter((p) => fresh.includes(Number(/#(\d+)/.exec(p)?.[1]))).map((p) => p.split(" #")[0]));
      for (const name of names) {
        const keys = (await b.eval(`perfDebug.programKeys(${JSON.stringify(name)})`)).map((k) => ({ id: Number(/#(\d+)/.exec(k)[1]), parts: k.split(" ").slice(1).join(" ").split(",") }));
        const neu = keys.find((k) => fresh.includes(k.id));
        for (const old of keys.filter((k) => !fresh.includes(k.id))) {
          const diff = [];
          for (let i = 0; i < Math.max(neu.parts.length, old.parts.length); i++) {
            if (neu.parts[i] !== old.parts[i]) diff.push(`[${i}] ${old.parts[i]} → ${neu.parts[i]}`);
          }
          console.log(`    key diff "${name}" #${old.id} → #${neu.id}: ${diff.join(" | ").slice(0, 400)}`);
        }
      }
    }
    const texAfter = await b.eval("perfDebug.textures()");
    const ft = await b.eval("window.__ft.slice()");
    const worst = ft.length ? Math.max(...ft) : 0;
    console.log(
      `kill ${k}: ok=${r.ok} killCall=${r.ms.toFixed(1)} ms · programs ${before} → ${after} (+${after - before})` +
        ` · textures ${texBefore} → ${texAfter} · worst frame ${worst.toFixed(0)} ms`,
    );
    // Respawn window: anything compiled / uploaded while the bot comes back.
    const progBeforeRespawn = new Set(await b.eval("perfDebug.programNames()"));
    const texSceneBeforeRespawn = await b.eval("perfDebug.sceneTextures()");
    await b.eval("window.__ft.length = 0; true");
    await sleep(2500); // let the bot respawn
    const respawnFrames = await b.eval("window.__ft.slice()");
    const freshRespawn = (await b.eval("perfDebug.programNames()")).filter((p) => !progBeforeRespawn.has(p));
    for (const p of freshRespawn) console.log(`  RESPAWN NEW PROGRAM: ${p.slice(0, 90)}`);
    if (freshRespawn.length) {
      const ids = freshRespawn.map((p) => Number(/#(\d+)/.exec(p)?.[1]));
      for (const line of await b.eval(`perfDebug.whoUses(${JSON.stringify(ids)})`)) console.log(`    used by ${line}`);
    }
    for (const [uuid, t] of Object.entries(await b.eval("perfDebug.sceneTextures()"))) {
      if (!texSceneBeforeRespawn[uuid]) console.log(`  RESPAWN NEW texture: ${t.name} ${t.size} (${t.owner})`);
    }
    console.log(`  respawn window worst frame ${(respawnFrames.length ? Math.max(...respawnFrames) : 0).toFixed(0)} ms`);
  }
  const errs = b.logs.filter((l) => /EXC/.test(l));
  if (errs.length) console.log("page exceptions:", errs.slice(0, 6));
} finally {
  b.close();
}
process.exit(0);
