"""Check a foregrip fit with the real FP IK: hand rotation error, wrist / forearm swing-twist, and views.
FORE_GRIP=<json> python3 check_grip.py out.png"""
import sys, numpy as np
import author_fp as A
from fp_common import arms
from twist import swing_twist
import grip_views


def arm_report(spec=None):
    spec = spec or dict(place=A.HOLD, lh=A.fore_hand)
    pose, ws, xR, xL, err = A.solve_pose(spec)
    W = arms.world(pose)
    out = dict(pos_mm=err[2] * 1000, rot_deg=err[3])
    for par, ch in (("LowerArm_L", "Hand_L"), ("UpperArm_L", "LowerArm_L")):
        sw, tw = swing_twist(A._local_q(W, par, ch))
        out[ch] = (round(sw, 1), round(tw, 1))
    return out


if __name__ == "__main__":
    rep = {"hold": arm_report(), "aim": arm_report(dict(place=A.AIM, lh=A.fore_hand))}
    for k, v in rep.items(): print(k, {a: (np.round(b, 2) if not isinstance(b, tuple) else b) for a, b in v.items()})
    if len(sys.argv) > 1:
        grip_views.views(sys.argv[1])
