// Bean Buddy portrait as stacked SVG layers (src/ui/hudIcons.ts BEAN_BUDDY_LAYERS, hud.css
// « PERF — animations ») against the one-SVG art (BEAN_BUDDY_SVG): the same drawing, in the
// same order where it matters, no SVG-child animation left, and every pivot / offset in hud.css
// equal to what the SVG children used (transform-box: fill-box) — pure text + geometry, no DOM.
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-buddy-layers.mts
import assert from "node:assert/strict";
import fs from "node:fs";

const { BEAN_BUDDY_LAYERS, BEAN_BUDDY_SVG } = await import("../src/ui/hudIcons.ts");
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

/** Drawing elements (shapes), without their class attribute. */
const shapes = (svg: string): string[] =>
  [...svg.matchAll(/<(?:path|circle|ellipse|rect)\b[^>]*\/>/g)].map((m) => m[0].replace(/\s+class="[^"]*"/, "").replace(/\s+/g, " "));
/** The `d` of the path whose markup contains `marker`. */
const pathD = (svg: string, marker: string): string => {
  const m = [...svg.matchAll(/<path\b[^>]*\/>/g)].map((x) => x[0]).find((p) => p.includes(marker));
  assert.ok(m, `no path with ${marker}`);
  return /\sd="([^"]+)"/.exec(m)![1];
};

/** Tight bounds of a path made of M / c / z (the leaves): cubic extrema solved exactly. */
function fillBox(d: string): { x0: number; y0: number; x1: number; y1: number } {
  const tok = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g)!;
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const ext = (p0: number, p1: number, p2: number, p3: number, out: number[]): void => {
    const at = (t: number): number => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const ts = [0, 1];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) ts.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a));
    }
    for (const t of ts) if (t >= 0 && t <= 1) out.push(at(t));
  };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "z" || cmd === "Z") continue;
    const n = (): number => Number(tok[i++]);
    if (cmd === "M") {
      x = n();
      y = n();
      cmd = "L"; // (implicit lineto: unused by the leaves)
    } else if (cmd === "c") {
      const [c1x, c1y, c2x, c2y, ex, ey] = [n(), n(), n(), n(), n(), n()].map((v, k) => v + (k % 2 ? y : x));
      ext(x, c1x, c2x, ex, xs);
      ext(y, c1y, c2y, ey, ys);
      x = ex;
      y = ey;
    } else {
      throw new Error(`path command ${cmd} not handled by this test`);
    }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Declaration value of `prop` in the (first) rule whose selector is exactly `selector`. */
const decl = (selector: string, prop: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no rule ${selector}`);
  const v = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(m[1]);
  assert.ok(v, `no ${prop} in ${selector}`);
  return v[1].trim();
};
const px = (v: string): number[] => v.split(/\s+/).map((s) => Number(s.replace(/px$/, "")));

// The portrait box and the art's viewBox → CSS px per user unit.
const box = Number(decl("#buddy-portrait", "width").replace(/px$/, ""));
assert.equal(Number(decl("#buddy-portrait", "height").replace(/px$/, "")), box);
const view = Number(/viewBox="0 0 (\d+) \1"/.exec(BEAN_BUDDY_SVG)![1]);
const s = box / view;
const close = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) < 1e-4, `${what}: ${a} vs ${b}`);

test("same drawing: every shape of the one-SVG art, once, in the layers", () => {
  assert.deepEqual(shapes(BEAN_BUDDY_LAYERS).sort(), shapes(BEAN_BUDDY_SVG).sort());
});

test("no SVG-child animation left in the layers (bb-leaf / bb-eyes / bb-sweat classes)", () => {
  const tokens = [...BEAN_BUDDY_LAYERS.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  for (const animated of ["bb-leaf", "bb-leaf-l", "bb-eyes", "bb-sweat"]) assert.ok(!tokens.includes(animated), animated);
  // …and the one-SVG art still has them (the avatar / ?diag=hudanim).
  const art = [...BEAN_BUDDY_SVG.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  for (const animated of ["bb-leaf", "bb-leaf-l", "bb-eyes", "bb-sweat"]) assert.ok(art.includes(animated), animated);
});

test("stacking: stem, left leaf, right leaf, body + faces, eyes, drop — the art's order where shapes overlap", () => {
  const order = [
    pathD(BEAN_BUDDY_SVG, 'stroke="#6fb536"'),
    pathD(BEAN_BUDDY_SVG, "bb-leaf-l"),
    pathD(BEAN_BUDDY_SVG, 'class="bb-leaf"'),
    pathD(BEAN_BUDDY_SVG, "bb-body"),
  ].map((d) => BEAN_BUDDY_LAYERS.indexOf(`d="${d}"`));
  assert.ok(order.every((v, k) => v > 0 && (k === 0 || v > order[k - 1])), `order ${order}`);
  const svgs = [...BEAN_BUDDY_LAYERS.matchAll(/<(?:svg|div) class="(bb-layer[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(svgs, [
    "bb-layer",
    "bb-layer bb-leaf-layer bb-leaf-layer-l",
    "bb-layer bb-leaf-layer bb-leaf-layer-r",
    "bb-layer",
    "bb-layer bb-eyes-layer",
    "bb-layer bb-sweat-layer",
  ]);
  // The eyes / the drop keep their face's group (the mood rules show / hide them).
  assert.match(BEAN_BUDDY_LAYERS, /bb-eyes-layer"><svg [^>]*><g transform="translate\(0 6\)" class="bb-face bb-happy">/);
  assert.match(BEAN_BUDDY_LAYERS, /bb-sweat-layer"><svg [^>]*><g transform="translate\(0 6\)" class="bb-face bb-panic">/);
  // The animated layers are boxes (div), each holding its own <svg>.
  for (const layer of ["bb-leaf-layer-l", "bb-leaf-layer-r", "bb-eyes-layer", "bb-sweat-layer"]) {
    assert.match(BEAN_BUDDY_LAYERS, new RegExp(`<div class="bb-layer[^"]*\\b${layer}"><svg viewBox="0 0 80 80"`), layer);
  }
});

test("leaf pivots = the SVG leaves' fill-box corners, in the layer's px", () => {
  const l = fillBox(pathD(BEAN_BUDDY_SVG, "bb-leaf-l"));
  const r = fillBox(pathD(BEAN_BUDDY_SVG, 'class="bb-leaf"'));
  // .bb-leaf: transform-origin 0% 100% (bottom left); .bb-leaf-l: 100% 100% (bottom right).
  const [lx, ly] = px(decl("#buddy-portrait .bb-leaf-layer-l", "transform-origin"));
  const [rx, ry] = px(decl("#buddy-portrait .bb-leaf-layer-r", "transform-origin"));
  close(lx, l.x1 * s, "left leaf x");
  close(ly, l.y1 * s, "left leaf y");
  close(rx, r.x0 * s, "right leaf x");
  close(ry, r.y1 * s, "right leaf y");
  assert.equal(decl(".bb-leaf", "transform-origin"), "0% 100%");
  assert.equal(decl(".bb-leaf-l", "transform-origin"), "100% 100%");
});

test("eyes pivot = the eyes group's fill-box centre (in its face's translate(0 6))", () => {
  const circles = [...BEAN_BUDDY_SVG.slice(BEAN_BUDDY_SVG.indexOf('class="bb-eyes"')).split("</g>")[0].matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(
    (m) => m.slice(1).map(Number),
  );
  const x0 = Math.min(...circles.map(([cx, , r]) => cx - r));
  const x1 = Math.max(...circles.map(([cx, , r]) => cx + r));
  const y0 = Math.min(...circles.map(([, cy, r]) => cy - r));
  const y1 = Math.max(...circles.map(([, cy, r]) => cy + r));
  const [ex, ey] = px(decl("#buddy-portrait .bb-eyes-layer", "transform-origin"));
  close(ex, ((x0 + x1) / 2) * s, "eyes x");
  close(ey, ((y0 + y1) / 2 + 6) * s, "eyes y");
  assert.equal(decl(".bb-eyes", "transform-origin"), "center");
});

test("the drop's fall and fade = buddy-sweat's, user units → px", () => {
  const kf = (name: string): string => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)![1];
  const moves = (k: string): number[] => [...k.matchAll(/translateY\((-?[\d.]+)px\)/g)].map((m) => Number(m[1]));
  const fades = (k: string): string[] => [...k.matchAll(/(\d+%)\s*\{[^}]*opacity:\s*([\d.]+)/g)].map((m) => `${m[1]}:${m[2]}`);
  const old = kf("buddy-sweat");
  const neu = kf("bb-sweat-layer");
  assert.deepEqual(moves(neu), moves(old).map((v) => +(v * s).toFixed(4)));
  assert.deepEqual(fades(neu), fades(old));
  assert.equal(decl(".bb-sweat", "animation"), "buddy-sweat 1s ease-in infinite");
  assert.equal(decl("#buddy-portrait .bb-sweat-layer", "animation"), "bb-sweat-layer 1s ease-in infinite");
});

test("same timings as the SVG children's animations", () => {
  assert.equal(decl(".bb-leaf", "animation"), "leaf-sway 2.6s ease-in-out infinite");
  assert.equal(decl("#buddy-portrait .bb-leaf-layer", "animation"), "leaf-sway 2.6s ease-in-out infinite");
  assert.equal(decl(".bb-eyes", "animation"), "buddy-blink 4.6s infinite");
  assert.equal(decl("#buddy-portrait .bb-eyes-layer", "animation"), "buddy-blink 4.6s infinite");
  assert.equal(decl(".bb-leaf-l", "animation-direction"), "reverse");
  assert.equal(decl("#buddy-portrait .bb-leaf-layer-l", "animation-direction"), "reverse");
});

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
