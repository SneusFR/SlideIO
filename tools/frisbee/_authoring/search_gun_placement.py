"""Search the gun placement (offsets vs HOLD) at the cycle's contact keys: natural left arm + right arm, hand and
object on screen."""
import sys, os, json
sys.path.insert(0, '/home/claude/fl'); os.chdir('/home/claude/fl')
import numpy as np
from scipy.optimize import minimize
import author_fp as A, weapon_def as wd, fp_natural as N
from fp_common import arms, weapon_root_world, render
from PIL import Image
F = 1 / np.tan(np.radians(65) / 2); ASP = 16 / 9
def ndc(p): return np.array([F / ASP * p[0] / -p[2], F * p[1] / -p[2]])

KEYS = {
    "handle_front": (dict(sled=0.0, deck=None), lambda Wn, st: A.normalized(Wn["SledGrab"]), "SledGrab"),
    "handle_cocked": (dict(sled=1.0, deck=None), lambda Wn, st: A.normalized(Wn["SledGrab"]), "SledGrab"),
    "disc_take": (dict(sled=1.0, deck=None, hand=A.disc_in_hand(A.CY["take"]), cage_top=False), lambda Wn, st: A.disc_grip_target(Wn["Root"] @ A.disc_in_hand(A.CY["take"])), None),
    "disc_out": (dict(sled=1.0, deck=None, hand=A.disc_in_hand(0.86), cage_top=False), lambda Wn, st: A.disc_grip_target(Wn["Root"] @ A.disc_in_hand(0.86)), None),
    "disc_up": (dict(sled=1.0, deck=None, hand=A.disc_in_hand(0.95), cage_top=False), lambda Wn, st: A.disc_grip_target(Wn["Root"] @ A.disc_in_hand(0.95)), None),
    "disc_seat": (dict(sled=1.0, deck=None, hand=A.disc_in_hand(A.CY["seat"] - 1e-3), cage_top=False), lambda Wn, st: A.disc_grip_target(Wn["Root"] @ A.disc_in_hand(A.CY["seat"])), None),
    "cage_grab": (dict(sled=1.0), lambda Wn, st: A.cage_grip_target(Wn["Root"] @ A.trs(A.wd.CAGE_C)), None),
    "cage_down": (dict(sled=1.0, cage=A.cage_local_at(A.RL["down"]), cage_n=0),
                  lambda Wn, st: A.cage_grip_target(Wn["Root"] @ A.cage_local_at(A.RL["down"])), None),
    "cage_align": (dict(sled=1.0, cage=A.cage_local_at(A.RL["align"])),
                   lambda Wn, st: A.cage_grip_target(Wn["Root"] @ A.cage_local_at(A.RL["align"])), None),
}


def evaluate(v, key, want_pose=False):
    st, tgt_fn, _ = KEYS[key]
    pl = A.place(A.HOLD, A.vec_place(v))
    pose, xR, eR, rR = A.solve_right(dict(A.REF), pl, A.REF)
    W = arms.world(pose)
    G = weapon_root_world(W, A.M_FP)
    Wn = wd.world_nodes(G, st)
    tgt = tgt_fn(Wn, st)
    p2, x, (e, r), s = N.solve_left(pose, tgt)
    sR = N.stats(arms.world(pose), "R")
    hp = tgt[:3, 3]
    n = ndc(hp)
    vis = max(0, abs(n[0]) - 0.8) * 40 + max(0, -0.5 - n[1]) * 40 + max(0, n[1] - 0.4) * 40
    deck = (G @ np.r_[wd.DISC_LOADED, 1])[:3]; nd = ndc(deck)
    vis += max(0, nd[1] - 0.15) * 30 + max(0, abs(nd[0]) - 0.7) * 30 + max(0, -0.75 - nd[1]) * 30
    cost = N.stress(s) + 0.5 * N.stress_R(sR) + (e * 1000) ** 2 * 4 + r ** 2 * 0.6 + vis ** 2 \
        + (np.linalg.norm(v[:3]) * 100) ** 2 * 0.02 + float(np.sum(np.asarray(v[3:]) ** 2)) * 0.004
    if want_pose:
        return cost, p2, st, dict(e=e * 1000, r=r, stress=N.stress(s), sR=N.stress_R(sR), ndc=n.round(2), s={k: round(float(q), 1) for k, q in s.items()})
    return cost


if __name__ == "__main__":
    keys = sys.argv[1].split(",")
    x0s = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    out = {}
    ims = []
    for k in keys:
        best = None
        for x0 in x0s.get(k, [[-0.03, 0.02, 0.03, 18, 5, -15]]):
            x0 = np.array(x0, float)
            simplex = np.array([x0] + [x0 + np.eye(6)[i] * d for i, d in enumerate([0.03, 0.03, 0.03, 12, 10, 12])])
            r = minimize(lambda v: evaluate(v, k), x0, method="Nelder-Mead",
                         options=dict(maxfev=170, xatol=1e-3, fatol=0.05, initial_simplex=simplex))
            if best is None or r.fun < best.fun: best = r
        c, pose, st, info = evaluate(best.x, k, True)
        out[k] = [round(float(q), 4) for q in best.x]
        print(k, out[k], round(c, 2), info, flush=True)
        im, _, _ = render(pose, A.M_FP, st, size=(480, 270), label=f"{k} {info['e']:.1f}mm {info['r']:.1f}d st {info['stress']:.0f}", markers=False)
        ims.append(im)
    json.dump(out, open("opt/keys_" + "_".join(keys) + ".json", "w"))
    S = Image.new("RGB", (960, 270 * ((len(ims) + 1) // 2)))
    for i, im in enumerate(ims): S.paste(im, ((i % 2) * 480, (i // 2) * 270))
    S.save("shots/keys_" + "_".join(keys) + ".png")
