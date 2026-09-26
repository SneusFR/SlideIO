"""Skeleton FK / clip sampling / skinning helpers matching three.js semantics."""
import numpy as np
from glb import read_glb, accessor

# ---------------- quaternion / matrix math (x, y, z, w) ----------------

def qnorm(q):
    q = np.asarray(q, dtype=np.float64)
    return q / np.linalg.norm(q)


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def qconj(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def qaxis(axis, ang):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    s = np.sin(ang / 2)
    return np.array([axis[0] * s, axis[1] * s, axis[2] * s, np.cos(ang / 2)])


def qrotate(q, v):
    return quat_to_mat3(q) @ np.asarray(v)


def quat_to_mat3(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mat3_to_quat(m):
    m = np.asarray(m, dtype=np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = 0.5 / np.sqrt(tr + 1.0)
        w = 0.25 / s
        x = (m[2, 1] - m[1, 2]) * s
        y = (m[0, 2] - m[2, 0]) * s
        z = (m[1, 0] - m[0, 1]) * s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    return q / np.linalg.norm(q)


def slerp(a, b, t):
    a = np.asarray(a, float); b = np.asarray(b, float)
    d = float(np.dot(a, b))
    if d < 0:
        b = -b; d = -d
    if d > 0.9995:
        r = a + (b - a) * t
        return r / np.linalg.norm(r)
    th = np.arccos(np.clip(d, -1, 1))
    s = np.sin(th)
    return (np.sin((1 - t) * th) * a + np.sin(t * th) * b) / s


def trs(t=(0, 0, 0), r=(0, 0, 0, 1), s=(1, 1, 1)):
    m = np.eye(4)
    m[:3, :3] = quat_to_mat3(r) * np.asarray(s)[None, :]
    m[:3, 3] = t
    return m


def decompose(m):
    t = m[:3, 3].copy()
    sx = np.linalg.norm(m[:3, 0]); sy = np.linalg.norm(m[:3, 1]); sz = np.linalg.norm(m[:3, 2])
    if np.linalg.det(m[:3, :3]) < 0:
        sx = -sx
    r = mat3_to_quat(m[:3, :3] / np.array([sx, sy, sz])[None, :])
    return t, r, np.array([sx, sy, sz])


def quat_from_to(a, b):
    a = np.asarray(a, float) / np.linalg.norm(a)
    b = np.asarray(b, float) / np.linalg.norm(b)
    c = np.cross(a, b)
    d = float(np.dot(a, b))
    if d < -0.999999:
        axis = np.cross([1, 0, 0], a)
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross([0, 1, 0], a)
        return qaxis(axis, np.pi)
    q = np.array([c[0], c[1], c[2], 1 + d])
    return q / np.linalg.norm(q)


# ---------------- Rig ----------------

class Rig:
    def __init__(self, path):
        self.js, self.bin = read_glb(path)
        js = self.js
        self.nodes = js["nodes"]
        self.names = [n.get("name", f"n{i}") for i, n in enumerate(self.nodes)]
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.parent = [-1] * len(self.nodes)
        for i, n in enumerate(self.nodes):
            for c in n.get("children", []):
                self.parent[c] = i
        self.rest_t = [np.array(n.get("translation", [0, 0, 0]), float) for n in self.nodes]
        self.rest_r = [np.array(n.get("rotation", [0, 0, 0, 1]), float) for n in self.nodes]
        self.rest_s = [np.array(n.get("scale", [1, 1, 1]), float) for n in self.nodes]
        # topological order
        self.order = []
        seen = set()

        def visit(i):
            if i in seen: return
            if self.parent[i] >= 0: visit(self.parent[i])
            seen.add(i); self.order.append(i)
        for i in range(len(self.nodes)): visit(i)
        self.clips = {}
        for a in js.get("animations", []):
            self.clips[a["name"]] = self._load_clip(a)

    def _load_clip(self, a):
        chans = {}
        dur = 0
        for c in a["channels"]:
            s = a["samplers"][c["sampler"]]
            t = accessor(self.js, self.bin, s["input"])[:, 0].astype(float)
            v = accessor(self.js, self.bin, s["output"]).astype(float)
            name = self.names[c["target"]["node"]]
            chans[(name, c["target"]["path"])] = (t, v)
            dur = max(dur, t[-1])
        return {"channels": chans, "duration": dur}

    def pose_from_clip(self, clip, time, base=None):
        """Return dict name -> (t, r, s) local, starting from rest (or base)."""
        pose = base.copy() if base is not None else self.rest_pose()
        cl = self.clips[clip] if isinstance(clip, str) else clip
        for (name, path), (t, v) in cl["channels"].items():
            if name not in pose: continue
            val = sample_track(t, v, time, path == "rotation")
            T, R, S = pose[name]
            if path == "translation": T = val
            elif path == "rotation": R = val
            elif path == "scale": S = val
            pose[name] = (T, R, S)
        return pose

    def rest_pose(self):
        return {self.names[i]: (self.rest_t[i].copy(), self.rest_r[i].copy(), self.rest_s[i].copy()) for i in range(len(self.nodes))}

    def world(self, pose, root_matrix=None):
        W = {}
        for i in self.order:
            n = self.names[i]
            T, R, S = pose[n]
            L = trs(T, R, S)
            p = self.parent[i]
            if p >= 0:
                W[n] = W[self.names[p]] @ L
            else:
                W[n] = (root_matrix if root_matrix is not None else np.eye(4)) @ L
        return W

    def mesh_data(self, mesh_index):
        m = self.js["meshes"][mesh_index]
        out = []
        for p in m["primitives"]:
            at = p["attributes"]
            pos = accessor(self.js, self.bin, at["POSITION"]).astype(float)
            idx = accessor(self.js, self.bin, p["indices"])[:, 0].astype(np.int64) if "indices" in p else np.arange(len(pos))
            d = {"pos": pos, "idx": idx.reshape(-1, 3), "material": p.get("material")}
            if "COLOR_0" in at:
                c = accessor(self.js, self.bin, at["COLOR_0"]).astype(float)
                if c.max() > 1.5: c = c / (65535 if c.max() > 256 else 255)
                d["color"] = c[:, :3]
            if "JOINTS_0" in at:
                d["joints"] = accessor(self.js, self.bin, at["JOINTS_0"]).astype(np.int64)
                w = accessor(self.js, self.bin, at["WEIGHTS_0"]).astype(float)
                if w.max() > 1.5: w = w / (65535 if w.max() > 256 else 255)
                d["weights"] = w
            out.append(d)
        return out

    def skin_matrices(self, W, skin_index=0):
        sk = self.js["skins"][skin_index]
        ibm = accessor(self.js, self.bin, sk["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
        mats = np.stack([W[self.names[j]] @ ibm[k] for k, j in enumerate(sk["joints"])])
        return mats


def sample_track(t, v, time, is_quat):
    if time <= t[0]: return v[0].copy()
    if time >= t[-1]: return v[-1].copy()
    i = int(np.searchsorted(t, time) - 1)
    i = max(0, min(i, len(t) - 2))
    a = (time - t[i]) / (t[i + 1] - t[i])
    if is_quat:
        return slerp(v[i], v[i + 1], a)
    return v[i] * (1 - a) + v[i + 1] * a


def skin_vertices(pos, joints, weights, mats):
    P = np.concatenate([pos, np.ones((len(pos), 1))], axis=1)
    out = np.zeros((len(pos), 3))
    for k in range(4):
        M = mats[joints[:, k]]  # (n,4,4)
        out += weights[:, k:k + 1] * np.einsum("nij,nj->ni", M, P)[:, :3]
    return out
