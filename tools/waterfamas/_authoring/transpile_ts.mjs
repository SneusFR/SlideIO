import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ts = require("/home/claude/.npm-global/lib/node_modules/typescript");
const jobs = ["WaterTank", "WaterJets", "WetMarks", "WaterFamasController", "WaterFamasGameplay"];
for (const n of jobs) {
  const out = ts.transpileModule(readFileSync(`ts/${n}.ts`, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true }, fileName: n + ".ts",
  }).outputText;
  const fixed = out.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, a, p, b) => (p.endsWith(".js") ? m : a + p + ".js" + b));
  writeFileSync(`preview/js/weapons/waterfamas/${n}.js`, fixed);
  console.log(n, fixed.length);
}
