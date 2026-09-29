"""Frames of an FP clip where the LEFT arm mesh (skinned vertices mostly weighted to *_L bones) is inside the view.
python3 opt/arm_visible.py fp_clips.pkl <clip> [t0 t1]"""
import sys, pickle, numpy as np
sys.path.insert(0, "/home/claude/fl")
import author_fp as A
from fp_common import arms
from rig import skin_vertices
TV = np.tan(np.radians(65) / 2); TH = TV * 16 / 9
_LEFT = {}


def _left_mask():
    if not _LEFT:
        for i, n in enumerate(arms.nodes):
            if "mesh" in n and "skin" in n:
                sk = arms.js["skins"][n["skin"]]
                jn = [arms.names[j] for j in sk["joints"]]
                left = np.array([nm.endswith("_L") for nm in jn])
                for prim in arms.mesh_data(n["mesh"]):
                    if "joints" not in prim: continue
                    wl = (prim["weights"] * left[prim["joints"]]).sum(1)
                    _LEFT.setdefault("items", []).append((n, prim, wl > 0.5))
    return _LEFT["items"]


NEAR = 0.01


def _clip_near(tri):
    """Sutherland-Hodgman against z <= -NEAR (camera space)."""
    out = []
    for i in range(3):
        a, b = tri[i], tri[(i + 1) % 3]
        ina, inb = a[2] <= -NEAR, b[2] <= -NEAR
        if ina: out.append(a)
        if ina != inb:
            u = (-NEAR - a[2]) / (b[2] - a[2]); out.append(a + (b - a) * u)
    return out


def _overlaps_screen(poly):
    q = np.array([[p[0] / (-p[2]) / TH, p[1] / (-p[2]) / TV] for p in poly])
    if q[:, 0].max() < -1 or q[:, 0].min() > 1 or q[:, 1].max() < -1 or q[:, 1].min() > 1: return False
    rect = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    for i in range(len(q)):                                    # separating axes of the polygon edges
        e = q[(i + 1) % len(q)] - q[i]; nrm = np.array([-e[1], e[0]])
        a = q @ nrm; b = rect @ nrm
        if a.max() < b.min() or b.max() < a.min(): return False
    return True


def visible_fraction(P):
    W = arms.world(P); cam = np.eye(4)                      # the FP camera is the world origin (looking -Z)
    n_in = 0; n_all = 0
    for n, prim, m in _left_mask():
        mats = arms.skin_matrices(W, n["skin"])
        v = skin_vertices(prim["pos"], prim["joints"], prim["weights"], mats)
        v = (cam[:3, :3] @ v.T).T + cam[:3, 3]
        idx = prim["idx"].reshape(-1, 3)
        tris = idx[m[idx].sum(1) >= 2]                        # left-arm triangles
        for t in tris:
            poly = _clip_near(v[t])
            n_all += 1
            if len(poly) >= 3 and _overlaps_screen(poly): n_in += 1
    return n_in, n_all


if __name__ == "__main__":
    c = pickle.load(open(sys.argv[1], "rb"))[sys.argv[2]]
    t0 = float(sys.argv[3]) if len(sys.argv) > 3 else 0; t1 = float(sys.argv[4]) if len(sys.argv) > 4 else 99
    for i, f in enumerate(c["frames"]):
        t = i / c["fps"]
        if not t0 <= t <= t1: continue
        P = dict(A.REST); P.update(f)
        k, nall = visible_fraction(P)
        print(f"{t:.3f} {'VISIBLE' if k else '-'} {k}/{nall}")
