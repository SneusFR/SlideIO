"""Minimal GLB reader/writer helpers (no external deps besides numpy)."""
import json, struct
import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def read_glb(path):
    data = open(path, "rb").read()
    magic, ver, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67
    off = 12
    js, binchunk = None, b""
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf8"))
        elif ctype == 0x004E4942:
            binchunk = chunk
        off += 8 + clen
    return js, binchunk


def accessor(js, binchunk, idx):
    acc = js["accessors"][idx]
    bv = js["bufferViews"][acc["bufferView"]]
    dt = COMP[acc["componentType"]]
    n = NCOMP[acc["type"]]
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride", 0)
    itemsize = np.dtype(dt).itemsize * n
    if stride and stride != itemsize:
        out = np.zeros((acc["count"], n), dtype=dt)
        for i in range(acc["count"]):
            out[i] = np.frombuffer(binchunk, dtype=dt, count=n, offset=start + i * stride)
    else:
        out = np.frombuffer(binchunk, dtype=dt, count=acc["count"] * n, offset=start).reshape(acc["count"], n)
    if acc.get("normalized"):
        if dt == np.uint8: out = out.astype(np.float32) / 255.0
        elif dt == np.uint16: out = out.astype(np.float32) / 65535.0
    return out


class GLBWriter:
    """Accumulates buffer data / accessors and writes a GLB."""

    def __init__(self):
        self.js = {"asset": {"version": "2.0", "generator": "PopcornShotgun procedural builder"},
                   "scenes": [{"nodes": []}], "scene": 0, "nodes": [], "buffers": [], "bufferViews": [], "accessors": []}
        self.bin = bytearray()

    def _view(self, raw, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(raw)}
        if target: bv["target"] = target
        self.bin.extend(raw)
        self.js["bufferViews"].append(bv)
        return len(self.js["bufferViews"]) - 1

    def add_accessor(self, arr, atype, ctype=5126, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        dt = COMP[ctype]
        arr = arr.astype(dt)
        bv = self._view(arr.tobytes(), target)
        count = arr.shape[0]
        acc = {"bufferView": bv, "componentType": ctype, "count": int(count), "type": atype}
        if normalized: acc["normalized"] = True
        if minmax:
            a2 = arr.reshape(count, -1)
            acc["min"] = [float(x) for x in a2.min(axis=0)]
            acc["max"] = [float(x) for x in a2.max(axis=0)]
        self.js["accessors"].append(acc)
        return len(self.js["accessors"]) - 1

    def add_node(self, node, root=False):
        self.js["nodes"].append(node)
        i = len(self.js["nodes"]) - 1
        if root:
            self.js["scenes"][0]["nodes"].append(i)
        return i

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.js["buffers"] = [{"byteLength": len(self.bin)}]
        # drop empty arrays
        for k in list(self.js.keys()):
            if isinstance(self.js[k], list) and len(self.js[k]) == 0:
                del self.js[k]
        jb = json.dumps(self.js, separators=(",", ":")).encode("utf8")
        while len(jb) % 4:
            jb += b" "
        total = 12 + 8 + len(jb) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(jb), 0x4E4F534A))
            f.write(jb)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942))
            f.write(bytes(self.bin))
