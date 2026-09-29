import sys, os, json
sys.path.insert(0, '/home/claude/fl'); os.chdir('/home/claude/fl')
import numpy as np
from scipy.optimize import least_squares
import author_fp as A, weapon_def as wd
F = 1 / np.tan(np.radians(65) / 2); ASP = 16 / 9
def ndc(p): return np.array([F / ASP * p[0] / -p[2], F * p[1] / -p[2]])
tgt = dict(json.loads(sys.argv[1])) if len(sys.argv) > 1 else {}
DISC = tgt.get("disc", [0.12, -0.36]); GRIPN = tgt.get("grip", [0.55, -0.85]); ELEV = tgt.get("elev", 0.5); FIX = tgt.get("fix", {})
def G_of(x):
    return A.gun_matrix(x[:3], x[3], x[4], x[5])
def res(x):
    G = G_of(x)
    dc = (G @ np.r_[wd.DISC_LOADED, 1])[:3]
    tl = (G @ np.r_[wd.limb_tip(1, 1), 1])[:3]; tr = (G @ np.r_[wd.limb_tip(-1, 1), 1])[:3]
    gp = (G @ np.r_[wd.GRIP, 1])[:3]
    n = G[:3, 1] / np.linalg.norm(G[:3, 1]); v = -dc / np.linalg.norm(dc)
    r = list((ndc(dc) - DISC) * 10) + list((ndc(gp) - GRIPN) * 4)
    r += [max(0, -0.8 - ndc(tl)[0]) * 10, max(0, ndc(tr)[0] - 0.92) * 10, max(0, ELEV - n @ v) * 20]
    r += [max(0, x[3] - 20) * 0.5, max(0, -x[3]) * 0.5, max(0, x[4] - 5) * 0.5, max(0, -22 - x[4]) * 0.5, x[5] * 0.05]
    r += [(x[2] + 0.42) * 2]
    for k, v in FIX.items(): r.append((x[int(k)] - v) * 10)
    return np.array(r)
x0 = np.array([0.2, -0.25, -0.4, 10, -6, 0])
s = least_squares(res, x0)
x = s.x; G = G_of(x)
dc = (G @ np.r_[wd.DISC_LOADED, 1])[:3]; n = G[:3, 1] / np.linalg.norm(G[:3, 1])
print(json.dumps([round(float(v), 4) for v in x]), "disc", np.round(ndc(dc), 2), "elev", round(float(n @ (-dc / np.linalg.norm(dc))), 2),
      "tipL", np.round(ndc((G @ np.r_[wd.limb_tip(1, 1), 1])[:3]), 2), "tipR", np.round(ndc((G @ np.r_[wd.limb_tip(-1, 1), 1])[:3]), 2),
      "grip", np.round(ndc((G @ np.r_[wd.GRIP, 1])[:3]), 2))
