// Medal ribbon tails' hard shadow (src/ui/hudIcons.ts ribbonTailSvg, hud.css .md-tail-shadow):
// a copy of each tail, filled with the shadow's colour, 3 px lower, at 85 % opacity — the
// `filter: drop-shadow(0 3px 0 rgba(40, 27, 12, 0.85))` it replaces (kept under ?diag=hudanim)
// had the whole ribbon repainted at every frame of a medal's pop. Pure text, no DOM.
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-medal-tails.mts
import assert from "node:assert/strict";
import fs from "node:fs";

const { ribbonTailSvg } = await import("../src/ui/hudIcons.ts");
const css = fs.readFileSync(new URL("../src/hud.css", import.meta.url), "utf8");

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

/** Declarations of the (first) rule whose selector is exactly `selector`. */
const rule = (selector: string): Record<string, string> => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no rule ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
};
const px = (v: string): number => Number(/^(-?[\d.]+)px$/.exec(v)?.[1] ?? NaN);

for (const side of ["l", "r"] as const) {
  const svgs = [...ribbonTailSvg(side).matchAll(/<svg class="([^"]+)"([^>]*)>([\s\S]*?)<\/svg>/g)];

  test(`${side}: the shadow first (painted under the tail), then the tail`, () => {
    assert.deepEqual(
      svgs.map((m) => m[1]),
      [`md-tail-shadow md-tail-shadow-${side}`, `md-tail md-tail-${side}`],
    );
  });

  test(`${side}: the same drawing (viewBox, scaling, path, stroke) — only the class differs`, () => {
    assert.equal(svgs[0][2], svgs[1][2]);
    assert.equal(svgs[0][3], svgs[1][3]);
  });

  test(`${side}: the same box, 3 px lower`, () => {
    const tail = rule(".md-tail");
    const shadow = rule(".md-tail-shadow");
    for (const k of ["position", "width", "height", "z-index", "overflow"]) assert.equal(shadow[k], tail[k], k);
    assert.equal(px(shadow.top), px(tail.top) + 3);
    const edge = side === "l" ? "left" : "right";
    assert.equal(rule(`.md-tail-shadow-${side}`)[edge], rule(`.md-tail-${side}`)[edge]);
  });
}

test("the drop-shadow it replaces: offset 0 3px, no blur, rgba(40, 27, 12, 0.85)", () => {
  assert.equal(rule(".md-tail").filter, "drop-shadow(0 3px 0 rgba(40, 27, 12, 0.85))");
  assert.equal(rule(".md-tail-shadow").opacity, "0.85");
  const paint = rule(".md-tail-shadow path");
  assert.equal(paint.fill, "rgb(40, 27, 12)");
  assert.equal(paint.stroke, "rgb(40, 27, 12)");
  // The filter is off and the copy shown, except under ?diag=hudanim.
  assert.match(css, /html:not\(\.diag-hudanim\) \.md-tail \{ filter: none; \}/);
  assert.match(css, /html\.diag-hudanim \.md-tail-shadow \{ display: none; \}/);
});

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
