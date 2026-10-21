// The HUD document's address (src/hud/host/HudHost.ts hudDocumentUrl): the game page's own
// diagnostics — `?gpu` and `?diag=` — reach the HUD iframe, whose document reads its switches
// (ui/perfDiag.ts: `?diag=hudanim`, `nohudidle`, `paintssNN`, the paint's `?gpu` timer) from its
// own address; nothing else of the page's query does. Pure, no DOM and no Vite (unlike
// test-hud-host.mts, which needs Vite's dev server).
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-document-url.mts
import assert from "node:assert/strict";

const { hudDocumentUrl } = await import("../src/hud/host/HudHost.ts");
const { perfExperiments, experimentValue } = await import("../src/ui/perfDiag.ts");

let failures = 0;
const test = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};

test("no diagnostics: the frame URL unchanged", () => {
  assert.equal(hudDocumentUrl("/hud.html", ""), "/hud.html");
  assert.equal(hudDocumentUrl("https://hud.example/hud.html", "?join=1&map=GIVRE"), "https://hud.example/hud.html");
});

test("?gpu and ?diag= pass on (gpu first), the rest of the query does not", () => {
  assert.equal(hudDocumentUrl("/hud.html", "?gpu"), "/hud.html?gpu=");
  assert.equal(hudDocumentUrl("/hud.html", "?gpu=draws"), "/hud.html?gpu=draws");
  assert.equal(hudDocumentUrl("/hud.html", "?join=1&diag=hudanim&gpu=draws"), "/hud.html?gpu=draws&diag=hudanim");
  assert.equal(hudDocumentUrl("/hud.html", "?diag=hudanim,nohudidle,paintss100"), "/hud.html?diag=hudanim%2Cnohudidle%2Cpaintss100");
});

test("what the HUD document reads back from that address", () => {
  const url = new URL(hudDocumentUrl("https://hud.example/hud.html", "?map=YARD&diag=HudAnim, paintss150 ,nohudidle"));
  const set = perfExperiments(url.search);
  assert.ok(set.has("hudanim") && set.has("nohudidle"), [...set].join(","));
  assert.equal(experimentValue(set, "paintss"), 150);
  assert.equal(experimentValue(perfExperiments(""), "paintss"), null);
});

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
