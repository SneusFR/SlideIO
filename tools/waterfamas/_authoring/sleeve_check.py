"""Continuous search of the FP pour: gun nose-down (opening up), the left hand holds the bottle (fist on the band) and
tips it into the opening; both arms natural; visual terms."""
import sys, os, pickle, numpy as np
sys.path.insert(0, '/home/claude/wf'); os.chdir('/home/claude/wf')
import author_fp as A, fp_natural as N, weapon_def as wd
from fp_common import arms, weapon_root_world
from anim_util import normalized
from scipy.optimize import minimize
from scipy.spatial.transform import Rotation as Rot
base = dict(A.REF); base.update({b: N.REF_L[b] for b in ('Shoulder_L', 'UpperArm_L', 'LowerArm_L', 'Hand_L')})
F65 = A._F65
ALONG = float(os.environ.get('ALONG', '0.7'))
def ndc(p): return np.array([F65 * p[0] / -p[2] / (16 / 9), F65 * p[1] / -p[2]])

def gun_for(v):
    c = v[:3]; yaw, pitch, roll = v[3:6]
    pl = A.place(A.HOLD, dict(yaw=yaw, pitch=pitch, roll=roll))
    G = A.gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    pl["grip"] = pl["grip"] + (np.asarray(c) - wd.world_nodes(G, 0.0, 0.5, 1.0)["Opening"][:3, 3])
    return A.gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"]), pl

def axis_of(az, el):
    az, el = np.radians(az), np.radians(el)
    return np.array([np.cos(el) * np.cos(az), np.sin(el), np.cos(el) * np.sin(az)])

def bottle_frame(nozzle, axis, roll):
    y = np.asarray(axis, float); y /= np.linalg.norm(y)
    x = np.cross(y, [0.0, 0.0, 1.0]); x /= np.linalg.norm(x); z = np.cross(x, y)
    R = np.stack([x, y, z], 1) @ Rot.from_euler("Y", roll, degrees=True).as_matrix()
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = np.asarray(nozzle) - R[:, 1] * wd.BOTTLE_NOZZLE[1] * A.GUN_SCALE
    return M

def hand_on(B):
    Bs = B.copy(); Bs[:3, :3] *= A.GUN_SCALE
    return normalized(Bs @ wd.BOTTLE_GRAB_LOCAL)

def bottle_keys(v, Wn):
    """pour0 / pour1 bottle frames for parameter vector v (world, camera space)."""
    op = Wn["Opening"][:3, 3]; n = normalized(Wn["Opening"])[:3, 0]
    a0 = axis_of(v[6], v[7]); a1 = axis_of(v[6], v[7] - 18.0)
    return [bottle_frame(op + n * 0.035, a0, v[8]), bottle_frame(op + n * 0.028, a1, v[8])], op, n, a0, a1

cache = {}
def evaluate(v, verbose=False):
    G, pl = gun_for(v)
    pose, xR, (eR, rR), sR = N.solve_right(base, G, x0=cache.get("R"))
    cache["R"] = xR
    Wn = wd.world_nodes(weapon_root_world(arms.world(pose), A.M_FP), 0.0, 0.5, 1.0)
    Bs, op, n, a0, a1 = bottle_keys(v, Wn)
    lc = []
    for k, B in enumerate(Bs):
        pp, xL, (e, r), s = N.solve_left(pose, hand_on(B), x0=cache.get(("L", k)))
        cache[("L", k)] = xL
        lc.append(e * 1000 + r + N.stress(s) * 0.05)
        if verbose: print(f"  pour{k}: L {e*1000:.2f}mm {r:.2f}d", {kk: round(float(x), 2) for kk, x in s.items()})
    rc = eR * 1000 + rR + N.stress_R(sR) * 0.05
    cn = ndc(op)
    vis = max(0.0, -0.35 - cn[0]) + max(0.0, cn[0] - 0.45) + max(0.0, -0.45 - cn[1]) + max(0.0, cn[1] - 0.15)
    phys = max(0.0, n[1] - 1.0) + max(0.0, 0.55 - n[1]) * 3            # the opening faces up
    phys += max(0.0, a0[1] + 0.45) * 3 + max(0.0, 0.5 - float(np.dot(a0, -n))) * 3   # the bottle points down, into the hole
    fwd = -normalized(G)[:3, 0]; along = abs(fwd[2])
    bc = ndc(Bs[0][:3, 3])
    bvis = max(0.0, -0.5 - bc[0]) + max(0.0, bc[0] - 0.6) + max(0.0, -0.55 - bc[1]) + max(0.0, bc[1] - 0.3)
    visual = vis * 60 + phys * 40 + max(0.0, along - ALONG) * 40 + bvis * 40
    total = rc + max(lc) + visual
    if verbose:
        print(f"  R {eR*1000:.2f}mm {rR:.2f}d", {k: round(float(x), 2) for k, x in sR.items()})
        print(f"  opening ndc {np.round(cn, 2)} n {np.round(n, 2)} a0 {np.round(a0, 2)} along {along:.2f} visual {visual:.2f} | pl",
              {k: (np.round(x, 3).tolist() if hasattr(x, '__len__') else round(float(x), 1)) for k, x in pl.items()}, f"TOTAL {total:.2f}", flush=True)
    return total

if __name__ == "__main__":
    v0 = np.array(eval(sys.argv[1]), float)
    print("start"); evaluate(v0, True)
    sol = minimize(lambda v: evaluate(v), v0, method="Nelder-Mead", options=dict(maxfev=int(sys.argv[2]), xatol=1e-3, fatol=0.05, adaptive=True))
    print("END", np.round(sol.x, 4).tolist(), round(sol.fun, 3)); evaluate(sol.x, True)
    pickle.dump(sol.x, open(sys.argv[3], "wb"))
