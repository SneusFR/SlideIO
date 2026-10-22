// HUD effects one by one, in the REAL HUD (its isolated iframe), without a kill (page realm,
// after killwatch.js). The game page talks to the HUD through one MessagePort (src/hud/protocol.ts:
// { t: "batch", cmds }); this keeps that port, captures real commands (with their arguments) while
// the game plays, and posts chosen ones again, alone, so that each effect's cost shows on its own.
//   __hi.capture(true)             record non-routine commands of every batch → __hi.caps
//   __hi.pick(name)                last captured command of that name (deep copy)
//   __hi.send(cmds, label)         post one extra batch to the HUD now → logged in __hi.log
//   await __hi.plan(groups)        groups: [{ label, cmds, after: [[ms, cmds]…], count, gapMs }]
//   __hi.effect(label, frames)     per injection: worst interval / lost refreshes after it (needs __kw)
// The extra batches bypass the other taps (realplay.js does not count them as kills).
(() => {
  if (window.__hi) return "hi already";
  const QUIET = /^(combat\.update|dash\.update|damage\.update|damage\.follow|crosshair\.flush|hitmarker\.flush|combo\.update|clock\.set|plate\.visible|spear\.update)$/;
  const HI = (window.__hi = { port: null, caps: [], capOn: false, log: [] });
  const prev = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    if (msg && msg.t === "batch" && Array.isArray(msg.cmds)) {
      HI.port = this;
      if (HI.capOn) {
        const keep = msg.cmds.filter((c) => c && typeof c[0] === "string" && !QUIET.test(c[0]));
        if (keep.length) {
          try { HI.caps.push({ t: performance.now(), f: window.__kw ? window.__kw.frames.length : 0, cmds: JSON.parse(JSON.stringify(keep)) }); } catch (e) { HI.err = String(e); }
          if (HI.caps.length > 5000) HI.caps.splice(0, 1000);
        }
      }
    }
    return prev.call(this, msg, ...rest);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  HI.capture = (on) => { HI.capOn = on; return `capture ${on ? "on" : "off"} (${HI.caps.length})`; };
  HI.pick = (name, pred) => {
    for (let k = HI.caps.length - 1; k >= 0; k--) for (const c of HI.caps[k].cmds) if (c[0] === name && (!pred || pred(c))) return JSON.parse(JSON.stringify(c));
    return null;
  };
  HI.send = (cmds, label) => {
    if (!HI.port) return false;
    prev.call(HI.port, { t: "batch", cmds });
    HI.log.push({ t: performance.now(), f: window.__kw ? window.__kw.frames.length : 0, label: label || cmds.map((c) => c[0]).join(",") });
    return true;
  };
  HI.plan = async (groups) => {
    for (const g of groups) {
      for (let k = 0; k < (g.count || 1); k++) {
        HI.send(g.cmds, g.label);
        for (const [d, c] of g.after || []) setTimeout(() => HI.send(c, g.label + "+"), d);
        await sleep(g.gapMs || 1500);
      }
      if (g.restMs) await sleep(g.restMs);
    }
    return "plan done";
  };
  HI.effect = (frames = 120, budget = 1000 / 240) => {
    const kw = window.__kw;
    const fr = kw.frames;
    const byLabel = new Map();
    for (const e of HI.log) {
      if (e.label.endsWith("+")) continue;
      const i = e.f;
      let worst = 0, lost = 0, att = 0;
      for (let k = Math.max(1, i); k < Math.min(fr.length, i + frames); k++) {
        const d = fr[k].t - fr[k - 1].t;
        lost += Math.max(0, Math.round(d / budget) - 1);
        if (d > worst) {
          worst = d;
          const a = fr[k - 1];
          att = d - (a.cb0 - a.t) - a.cpu - (a.post || 0);
        }
      }
      // events of the game itself in the window (they would blur the picture)
      const s0 = fr[Math.max(0, i - 1)], s1 = fr[Math.min(fr.length - 1, i + frames)];
      const noise = s0 && s1 ? (s1.st[1] - s0.st[1] ? "dégâts " : "") + (s1.st[3] - s0.st[3] ? "MORT " : "") + (s1.st[2] - s0.st[2] ? "KILL" : "") : "";
      const a = byLabel.get(e.label) || [];
      a.push(`${Math.round(worst)}${att > 2 ? "(att " + Math.round(att) + ")" : ""}/${lost}${noise ? "!" + noise.trim() : ""}`);
      byLabel.set(e.label, a);
    }
    return [...byLabel.entries()].map(([k, v]) => `${k}: ${v.join("  ")}`).join("\n");
  };
  return "hi ready";
})();
