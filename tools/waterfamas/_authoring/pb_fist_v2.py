"""Continuous search of the FP unscrew pose: both arms natural, the gun counter-rolls about the tank axis (s=0.5) so
the left hand only turns half of each 90° stroke; visual terms keep the cap on screen and the gun seen from the side."""
import sys, os, pickle, numpy as np
sys.path.insert(0, '/home/claude/wf'); os.chdir('/home/claude/wf')
import author_fp as A, fp_natural as N, weapon_def as wd
from fp_common import arms, weapon_root_world
from anim_util import normalized
from scipy.optimize import minimize
from scipy.spatial.transform import Rotation as Rot
base = dict(A.REF); base.update({b: N.REF_L[b] for b in ('Shoulder_L', 'UpperArm_L', 'LowerArm_L', 'Hand_L')})
F65 = A._F65
SPLIT = 0.5
STROKES = (-45.0, 0.0, 45.0)
def ndc(p): return np.array([F65 * p[0] / -p[2] / (16 / 9), F65 * p[1] / -p[2]])

def gun_for(v, h=0.0):
    c = v[:3]; yaw, pitch, roll = v[3:6]
    pl = A.place(A.HOLD, dict(yaw=yaw, pitch=pitch, roll=roll))
    G = A.gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    pl["grip"] = pl["grip"] + (np.asarray(c) - wd.world_nodes(G)["Cap"][:3, 3])
    G = A.gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    if h != 0.0:                                             # counter-roll about the tank axis through the cap centre
        Wn = wd.world_nodes(G); ax = normalized(Wn["Tank"])[:3, 0]; cc = Wn["Cap"][:3, 3]
        R = Rot.from_rotvec(ax * np.radians(-SPLIT * h)).as_matrix()
        M = np.eye(4); M[:3, :3] = R; M[:3, 3] = cc - R @ cc
        G = M @ G
    return G, pl

cache = {}
def evaluate(v, verbose=False):
    phi = v[6]
    tot_R, tot_L = [], []
    for h in STROKES:
        G, pl = gun_for(v, h)
        pose, xR, (eR, rR), sR = N.solve_right(base, G, x0=cache.get(("R", h)))
        cache[("R", h)] = xR
        Wn = wd.world_nodes(weapon_root_world(arms.world(pose), A.M_FP))
        pp, xL, (e, r), s = N.solve_left(pose, normalized(A.cap_push(phi + h)(Wn)), x0=cache.get(("L", h)))
        cache[("L", h)] = xL
        tot_R.append(eR * 1000 + rR + N.stress_R(sR) * 0.05)
        tot_L.append(e * 1000 + r + N.stress(s) * 0.05)
        if verbose:
            print(f"  h {h:+.0f}: R {eR*1000:.2f}mm {rR:.2f}d", {k: round(float(x), 2) for k, x in sR.items()})
            print(f"          L {e*1000:.2f}mm {r:.2f}d", {k: round(float(x), 2) for k, x in s.items()})
    G, pl = gun_for(v, 0.0)
    Wn = wd.world_nodes(G)
    cn = ndc(Wn["Cap"][:3, 3])
    vis = max(0.0, -0.35 - cn[0]) + max(0.0, cn[0] - 0.45) + max(0.0, -0.5 - cn[1]) + max(0.0, cn[1] - 0.1)
    fwd = -normalized(G)[:3, 0]                                   # muzzle direction
    along = abs(fwd[2])                                           # gun pointing into / out of the screen
    capn = normalized(Wn["Tank"])[:3, 0]                          # cap face normal (outward)
    facing = max(0.0, -capn[2] - 0.2)                             # cap face turned away from the camera
    visual = vis * 60 + max(0.0, along - 0.6) * 40 + facing * 20
    total = max(tot_R) + max(tot_L) + visual
    if verbose:
        print(f"  ndc {np.round(cn, 2)} along {along:.2f} capn {np.round(capn, 2)} visual {visual:.2f} | pl", {k: (np.round(x, 3).tolist() if hasattr(x, '__len__') else round(float(x), 1)) for k, x in pl.items()}, f"TOTAL {total:.2f}", flush=True)
    return total

if __name__ == "__main__":
    v0 = np.array(eval(sys.argv[1]), float)
    print("start"); evaluate(v0, True)
    sol = minimize(lambda v: evaluate(v), v0, method="Nelder-Mead", options=dict(maxfev=int(sys.argv[2]), xatol=1e-3, fatol=0.05, adaptive=True))
    print("END", np.round(sol.x, 4).tolist(), round(sol.fun, 3)); evaluate(sol.x, True)
    pickle.dump(sol.x, open(sys.argv[3], "wb"))
