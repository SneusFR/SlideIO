"""FP idle LEFT arm: hanging along the body (like the TP stance), completely out of the FP view.

The FP arms mesh has long sleeves: the upper-arm tube continues ~0.45 m past the shoulder. An arm hanging straight
down from its REST place (in front of the camera) would push that sleeve UP through the screen, so the shoulder is
slid back to where a shoulder really is, beside and just behind the eye (camera plane): the arm then hangs
vertically along the (virtual) body and nothing of it — arm, hand or sleeve — can enter the viewmodel frustum.
Solved once (position + a loose palm-in / fingers-down orientation) under natural limits measured from the REST pose:
  - arm hanging straight down, a little outward, elbow slightly bent with the elbow pointing BACK;
  - wrist / forearm twist inside the natural limits, relaxed wrist;
  - every sampled point of the arm + sleeve outside the 65 deg viewmodel frustum (with margin for the sway).
Writes fp_left_idle.json (locals of Shoulder_L, UpperArm_L, LowerArm_L, Hand_L + finger curl), read by author_fp.py.

python3 fp_idle_left.py [sheet.png]
"""
import sys, json
import numpy as np
import author_fp as A
import fp_natural as N
from fp_common import arms, render
from anim_util import normalized
from raster import look_at

L_BONES = ("Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L")
ROOT = np.array([-0.250, -0.240, 0.050])         # upper-arm root (camera space): beside / just behind the eye
HANG = np.array([-0.10, -1.0, 0.0]); HANG /= np.linalg.norm(HANG)    # straight down, a little outward
NDC_OUT = 1.25                                    # sampled points must stay this far outside the frustum (sway margin)
ASPECT = 16 / 9
CURL = 0.35                                       # relaxed fingers

_P = dict(A.REST, **A.REF)
_P["FP_Viewmodel"] = A.V0
_W = arms.world(dict(A.REST, FP_Viewmodel=A.V0, Hips=A.HEX["Hips"]))
L_UA = float(np.linalg.norm(_W["LowerArm_L"][:3, 3] - _W["UpperArm_L"][:3, 3]))
L_FA = float(np.linalg.norm(_W["Hand_L"][:3, 3] - _W["LowerArm_L"][:3, 3]))


def ndc_y(p):
    return A._F65 * p[1] / max(1e-3, -p[2])


def arm_points(wl):
    """Arm + sleeve samples (camera space): sleeve end / middle, shoulder, elbow, wrist, fingertips."""
    ua = wl["UpperArm_L"][:3, 3]; el = wl["LowerArm_L"][:3, 3]; wr = wl["Hand_L"][:3, 3]
    d = (el - ua) / np.linalg.norm(el - ua)
    tip = wr + (wr - el) / np.linalg.norm(wr - el) * 0.09
    return [ua - d * A.SLEEVE_LEN, ua - d * A.SLEEVE_LEN * 0.5, ua, 0.5 * (ua + el), el, wr, tip]


def visibility(p):
    """> 0 when p is inside the (margin-grown) viewmodel frustum: how far inside."""
    if p[2] > -0.012: return 0.0
    nx = A._F65 / ASPECT * p[0] / -p[2]; ny = A._F65 * p[1] / -p[2]
    return max(0.0, NDC_OUT - max(abs(nx), abs(ny)))


def residual(wl):
    ua = wl["UpperArm_L"][:3, 3]; el = wl["LowerArm_L"][:3, 3]; wr = wl["Hand_L"][:3, 3]
    r = [(ua - ROOT) * 400.0]
    s = N.stats(wl)
    r.append(np.array([max(0.0, abs(s["hand_tw"]) - 10.0) * 8.0, max(0.0, s["hand_sw"] - 30.0) * 3.0,
                       max(0.0, abs(s["fore_tw"]) - 20.0) * 6.0,
                       max(0.0, 6.0 - s["elbow"]) * 3.0, max(0.0, s["elbow"] - 28.0) * 3.0]))
    e, n = N.elbow_dir(wl, "L")                           # elbow points back (the forearm swings a bit forward)
    r.append(np.array([max(0.0, 0.35 - e[2]) * 60.0 * min(1.0, n / 0.01)]))
    r.append(np.array([visibility(p) * 80.0 for p in arm_points(wl)]))
    return np.concatenate(r)


def target():
    palm = ROOT + HANG * (L_UA + L_FA + 0.045) + np.array([0.0, 0.0, -0.03])
    return N.hand_frame(palm, (1.0, 0.0, 0.25), 90.0)     # palm toward the body, fingers down


def solve():
    ref = dict(_P)
    for b in L_BONES: ref[b] = A.REST[b]                  # regularise toward the REST arm (natural twist)
    pose = dict(ref)
    W = arms.world(pose)
    best = None
    for x0 in (None,):
        p2, x, e, r = N.ikL.solve(pose, W, normalized(target()), ref, w_rot=0.25, reg_rot=[0.05, 0.02, 0.05],
                                  reg_trans=0.01, x0=x0, extra=residual)
        if best is None or e < best[2]: best = (p2, x, e, r)
    p2, x, e, r = best
    wl = arms.world(p2)
    s = N.stats(wl)
    info = dict(err_mm=e * 1000, err_deg=r, root=wl["UpperArm_L"][:3, 3].round(3).tolist(),
                visible=round(max(visibility(p) for p in arm_points(wl)), 3),
                hand_tw=round(s["hand_tw"], 1), hand_sw=round(s["hand_sw"], 1), fore_tw=round(s["fore_tw"], 1),
                elbow=round(s["elbow"], 1), elbow_dir=np.round(N.elbow_dir(wl, "L")[0], 2).tolist())
    return {b: p2[b] for b in L_BONES}, info


def save(locs, path="fp_left_idle.json"):
    js = {b: dict(t=np.asarray(locs[b][0], float).tolist(), q=np.asarray(locs[b][1], float).tolist(),
                  s=np.asarray(locs[b][2], float).tolist()) for b in L_BONES}
    js["curl"] = CURL
    json.dump(js, open(path, "w"), indent=1)


def sheet(locs, out):
    from PIL import Image
    P = dict(_P); P.update(locs)
    for n in A.FINGERS_L: P[n] = (A.REST[n][0], A.finger_q(n, CURL), A.REST[n][2])
    ims = []
    tgt = np.array([0.02, -0.30, -0.22])
    for cam, fov, lab in ((None, 65, "FP 65 (rien du bras gauche)"),
                          (look_at(np.array([-1.5, -0.1, -0.1]), tgt), 42, "cote gauche"),
                          (look_at(np.array([0.1, -0.1, -1.9]), tgt), 42, "face")):
        im, _, _ = render(P, A.M_FP, None, size=(420, 320), cam=cam, fov=fov, label=lab)
        ims.append(im)
    o = Image.new("RGB", (1260, 320))
    for k, im in enumerate(ims): o.paste(im, (k * 420, 0))
    o.save(out)


if __name__ == "__main__":
    locs, info = solve()
    print(info)
    save(locs)
    if len(sys.argv) > 1: sheet(locs, sys.argv[1])
