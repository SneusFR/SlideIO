"""TP reload: the hopper carried by the left hand follows the SOLVED hand (not the IK target).

The TP left arm is short: while it holds the hopper the solver misses the HopperGrabSocketTP target by up to ~10 mm / 50°.
Instead of re-solving, the hopper is re-attached to the actual hand (Weapon_L) during the carry phases:
  unclip → release (old hopper) and pick → seat (new hopper), blended in/out over 0.06 s at unclip and seat,
so the hand never floats off the hopper. Seated phases keep the keyed hopper (seated on the gun).
Usage: python3 tp_hopper_follow.py tp_c.pkl   (in place, idempotent: keeps the original hoppers in 'weapon_keyed')
"""
import sys, pickle, numpy as np
from scipy.spatial.transform import Rotation as Rot, Slerp

sys.argv, _argv = ["x", "key"], sys.argv
import author_tp as T
import author_fp as A
sys.argv = _argv

NAME = "TP_Reload_PaintballRifle"
RL = A.RL
BLEND = 0.06


def ease(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


def follow_weight(t):
    if t < RL["unclip"]: return 0.0
    if t < RL["unclip"] + BLEND: return ease((t - RL["unclip"]) / BLEND)
    if t < RL["seat"] - BLEND: return 1.0
    if t < RL["seat"]: return 1.0 - ease((t - (RL["seat"] - BLEND)) / BLEND)
    return 0.0


def rigid(M):
    R = M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0)
    U, _, Vt = np.linalg.svd(R); R = U @ Vt
    X = np.eye(4); X[:3, :3] = R; X[:3, 3] = M[:3, 3]
    return X


def blend(Ma, Mb, w):
    """Blend two rigid(+uniform scale) matrices: lerp position, slerp rotation."""
    sa = np.linalg.norm(Ma[:3, 0]); sb = np.linalg.norm(Mb[:3, 0])
    Ra = Ma[:3, :3] / sa; Rb = Mb[:3, :3] / sb
    R = Slerp([0, 1], Rot.from_matrix([Ra, Rb]))(w).as_matrix()
    X = np.eye(4); X[:3, :3] = R * ((1 - w) * sa + w * sb); X[:3, 3] = (1 - w) * Ma[:3, 3] + w * Mb[:3, 3]
    return X


def main(path):
    T.P0, T.SPINE = T.load_key()
    d = pickle.load(open(path, "rb"))
    c = d[NAME]
    keyed = c.setdefault("weapon_keyed", [tuple(w) for w in c["weapon"]])
    base = T.body("TP_Aim_HexSniper", 0.0)
    out, rep = [], []
    for i, (f, w) in enumerate(zip(c["frames"], keyed)):
        t = min(i / c["fps"], c["duration"])
        trig, charge, H, vis = w
        wf = follow_weight(t)
        if H is None or wf <= 0.0:
            out.append(tuple(w)); continue
        pose = dict(base); pose.update(f)
        W = T.ch.world(pose)
        G = rigid(W["Weapon_R"]) @ T.M_TP @ T.S_ROOT                        # the gun as the game mounts it
        X = G @ np.asarray(H) @ T.GRAB_TP                                   # keyed grab socket (world)
        s = np.linalg.norm(X[:3, 0])
        EL = rigid(W["Weapon_L"]); Xe = EL.copy(); Xe[:3, :3] *= s          # actual hand with the socket's scale
        Hf = np.linalg.inv(G) @ Xe @ np.linalg.inv(T.GRAB_TP)               # hopper that puts its socket on the hand
        Hn = blend(np.asarray(H), Hf, wf)
        err = np.linalg.norm(X[:3, 3] - EL[:3, 3]) * 1000
        rep.append((t, wf, err))
        out.append((trig, charge, Hn, vis))
    c["weapon"] = out
    pickle.dump(d, open(path, "wb"))
    for t, wf, e in rep[::6]:
        print(f"t={t:4.2f} w={wf:4.2f} hand→socket before {e:5.2f} mm")
    print("frames re-attached:", len(rep))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tp_c.pkl")
