// Rebuilds src/assets/revolver.glb into src/assets/revolver_opt.glb with all
// embedded JPEG/PNG textures resized to <=1024px and re-encoded (JPEG q85).
// Pure-JS (jimp) — same optimization pipeline goal as the other *_opt.glb.
import fs from "node:fs";
import Jimp from "jimp";

const SRC = "src/assets/revolver.glb";
const DST = "src/assets/revolver_opt.glb";
const MAX = 1024;

const buf = fs.readFileSync(SRC);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a glb");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));

const bvs = json.bufferViews;
const imageBv = new Map(); // bufferView index -> image index
(json.images ?? []).forEach((img, i) => {
  if (img.bufferView !== undefined) imageBv.set(img.bufferView, i);
});

// Resize every image bufferView.
const newSlices = [];
for (let i = 0; i < bvs.length; i++) {
  const bv = bvs[i];
  const slice = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  if (!imageBv.has(i)) {
    newSlices.push(Buffer.from(slice));
    continue;
  }
  const img = await Jimp.read(Buffer.from(slice));
  const w = img.getWidth();
  const h = img.getHeight();
  if (Math.max(w, h) > MAX) {
    const s = MAX / Math.max(w, h);
    img.resize(Math.round(w * s), Math.round(h * s));
  }
  img.quality(85);
  const out = await img.getBufferAsync(Jimp.MIME_JPEG);
  json.images[imageBv.get(i)].mimeType = "image/jpeg";
  console.log(`image bv${i}: ${w}x${h} ${slice.length}B -> ${img.getWidth()}x${img.getHeight()} ${out.length}B`);
  newSlices.push(out);
}

// Rebuild the binary chunk with 4-byte alignment.
let offset = 0;
const parts = [];
for (let i = 0; i < bvs.length; i++) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    parts.push(Buffer.alloc(pad));
    offset += pad;
  }
  bvs[i].byteOffset = offset;
  bvs[i].byteLength = newSlices[i].length;
  parts.push(newSlices[i]);
  offset += newSlices[i].length;
}
const binPad = (4 - (offset % 4)) % 4;
if (binPad) {
  parts.push(Buffer.alloc(binPad));
  offset += binPad;
}
const newBin = Buffer.concat(parts, offset);
json.buffers[0].byteLength = newBin.length;

let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonBuf.length, 0);
jsonHdr.writeUInt32LE(0x4e4f534a, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(newBin.length, 0);
binHdr.writeUInt32LE(0x004e4942, 4);

fs.writeFileSync(DST, Buffer.concat([header, jsonHdr, jsonBuf, binHdr, newBin]));
console.log(`wrote ${DST}: ${fs.statSync(DST).size} bytes (src ${fs.statSync(SRC).size})`);