// Crops + encodes the raw captures (capture-map-thumbs.mjs) into the light
// WebP thumbnails imported by the end screen (src/endscreen/maps/*.webp).
//   node tools/endscreen/encode-map-thumbs.mjs
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../hud-preview/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../src/endscreen/maps");
const W = 640;
const H = 400;
/** Source crop per map (fractions of the raw capture): x, y, width, height. */
const CROPS = {
  jungle: [0, 0, 1, 1],
  yard: [0, 0, 1, 1],
  // The lower half of the Givre orbit shot is flat snow: frame the buildings.
  givre: [0.06, 0, 0.88, 0.7],
};

const b = await launch({ width: 800, height: 600, url: "about:blank", port: 9334 });
try {
  for (const [name, [cx, cy, cw, ch]] of Object.entries(CROPS)) {
    const src = resolve(dir, "raw", `${name}.png`);
    if (!existsSync(src)) {
      console.log(`skip ${name} (no raw capture)`);
      continue;
    }
    const b64 = readFileSync(src).toString("base64");
    const out = await b.eval(`(async () => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64,${b64}")).blob());
      const sx = img.width * ${cx}, sy = img.height * ${cy}, sw = img.width * ${cw}, sh = img.height * ${ch};
      // cover-fit the crop into ${W}x${H}
      const k = Math.max(${W} / sw, ${H} / sh);
      const dw = ${W} / k, dh = ${H} / k;
      const c = document.createElement("canvas"); c.width = ${W}; c.height = ${H};
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
      g.drawImage(img, sx + (sw - dw) / 2, sy + (sh - dh) / 2, dw, dh, 0, 0, ${W}, ${H});
      return c.toDataURL("image/webp", 0.82).split(",")[1];
    })()`);
    const buf = Buffer.from(out, "base64");
    writeFileSync(resolve(dir, `${name}.webp`), buf);
    console.log(`${name}.webp ${buf.length} bytes`);
  }
  if (process.argv.includes("--clean")) rmSync(resolve(dir, "raw"), { recursive: true, force: true });
} finally {
  b.close();
}
process.exit(0);
