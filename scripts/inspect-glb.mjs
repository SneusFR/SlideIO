// Quick GLB inspector: prints animations, bones/nodes, meshes for given GLB files.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);

for (const file of files) {
  const buf = readFileSync(file);
  // GLB header: magic(4) version(4) length(4), then chunks
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.toString("ascii", 16, 20);
  if (jsonType !== "JSON") {
    console.log(`${file}: unexpected chunk type ${jsonType}`);
    continue;
  }
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  console.log(`\n=== ${file} (${buf.length} bytes) ===`);
  console.log("animations:", (json.animations || []).map((a) => a.name));
  console.log("meshes:", (json.meshes || []).map((m) => m.name));
  console.log("skins:", (json.skins || []).length);
  const nodeNames = (json.nodes || []).map((n) => n.name).filter(Boolean);
  console.log("node count:", (json.nodes || []).length);
  const handLike = nodeNames.filter((n) => /hand|arm|wrist/i.test(n));
  console.log("hand-like nodes:", handLike);
  console.log("all node names:", nodeNames.join(", "));
  console.log("images:", (json.images || []).map((i) => i.mimeType));
}