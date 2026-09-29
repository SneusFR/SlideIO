"""Natural-arm constraints for the FP LEFT arm off the foregrip (re-cocking, magazine swap): joint deltas measured
from the REST pose (what the skin sees), tight twists (no candy-wrapper wrist / elbow), shoulder slide kept near the
foregrip hold, the upper arm entering from the bottom of the screen. (Ported from the Water FAMAS reload v2.)"""
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from twist import swing_twist
import author_fp as A
from fp_common import arms
from ik import ChainIK

REST = A.REST
_RQ = {b: Rot.from_quat(REST[b][1]) for b in ("UpperArm_L", "LowerArm_L", "Hand_L")}
_HEXP = dict(REST, **A.HEX)
_REFP = dict(REST, **A.REF); _REFP["FP_Viewmodel"] = A.V0; _REFP["Hips"] = A.HEX["Hips"]
SH0 = arms.world(_REFP)["Shoulder_L"][:3, 3].copy()          # reference shoulder slide = our foregrip hold
REF_L = dict(A.REF)                                          # left arm on the foregrip
ikL = ChainIK(arms, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["UpperArm_L", "LowerArm_L", "Hand_L"], trans_bones=["Shoulder_L"])

LIM = dict(hand_tw=12.0, hand_sw=75.0, fore_tw=25.0, elbow_min=25.0, elbow_max=128.0, shoulder_slide=0.13)


def delta_st(wl, parent, child):
    q = A._local_q(wl, parent, child)
    d = _RQ[child].inv() * Rot.from_quat(q)
    return swing_twist(d.as_quat())


_RQ.update({b: Rot.from_quat(REST[b][1]) for b in ("UpperArm_R", "LowerArm_R", "Hand_R")})
SH0_R = arms.world(_REFP)["Shoulder_R"][:3, 3].copy()


def stats(wl, side="L"):
    hs, ht = delta_st(wl, f"LowerArm_{side}", f"Hand_{side}")
    es, et = delta_st(wl, f"UpperArm_{side}", f"LowerArm_{side}")
    sh = float(np.linalg.norm(wl[f"Shoulder_{side}"][:3, 3] - (SH0 if side == "L" else SH0_R)))
    ed, _ = elbow_dir(wl, side)
    return dict(hand_sw=hs, hand_tw=ht, elbow=es, fore_tw=et, shoulder=sh, el_up=float(ed[1]), el_in=float(ed[0] if side == "L" else -ed[0]))


def elbow_dir(wl, side="L"):
    """Unit direction the elbow points to (perpendicular to the shoulder->wrist line), camera space."""
    ua = wl[f"UpperArm_{side}"][:3, 3]; el = wl[f"LowerArm_{side}"][:3, 3]; wr = wl[f"Hand_{side}"][:3, 3]
    d = wr - ua; d /= np.linalg.norm(d)
    e = (el - ua) - d * float(np.dot(el - ua, d))
    n = np.linalg.norm(e)
    return e / n if n > 1e-6 else np.zeros(3), n


EL_UP = {"L": 0.25, "R": 0.45}


def elbow_residual(wl, side="L"):
    """Anatomy: the elbow hangs DOWN / points outward — never up, never across toward the other arm."""
    e, n = elbow_dir(wl, side)
    w = min(1.0, n / 0.02)                          # nearly straight arm: direction meaningless
    out_x = -e[0] if side == "L" else e[0]          # outward = screen-left for the left arm
    return np.array([max(0.0, e[1] - EL_UP[side]) * 120.0 * w, max(0.0, -out_x - 0.45) * 120.0 * w])


def natural_residual(wl, w=1.0):
    s = stats(wl)
    r = [max(0.0, abs(s["hand_tw"]) - LIM["hand_tw"]) * 8.0, max(0.0, s["hand_sw"] - LIM["hand_sw"]) * 4.0,
         max(0.0, abs(s["fore_tw"]) - LIM["fore_tw"]) * 6.0,
         max(0.0, LIM["elbow_min"] - s["elbow"]) * 3.0, max(0.0, s["elbow"] - LIM["elbow_max"]) * 4.0,
         max(0.0, s["shoulder"] - LIM["shoulder_slide"]) * 1500.0]
    return np.concatenate([np.array(r) * w, sleeve_low(wl), elbow_residual(wl, "L")])


def sleeve_low(wl, ndc=-0.58):
    """The upper arm enters from the BOTTOM edge (the sleeve never climbs into the middle of the screen)."""
    ua = wl["UpperArm_L"][:3, 3]; el = wl["LowerArm_L"][:3, 3]
    d = (el - ua) / np.linalg.norm(el - ua)
    out = []
    for p in (ua, ua - d * A.SLEEVE_LEN * 0.5):
        if p[2] > -0.03: out.append(0.0); continue
        out.append(max(0.0, A._F65 * p[1] / -p[2] - ndc) * 60.0)
    return np.array(out)


def stress(s):
    """Scalar 'how unnatural' (0 = inside every limit)."""
    return (max(0.0, s.get("el_up", 0) - 0.25) ** 2 * 400 + max(0.0, s.get("el_in", 0) - 0.45) ** 2 * 400 + max(0.0, abs(s["hand_tw"]) - LIM["hand_tw"]) ** 2 * 4 + max(0.0, s["hand_sw"] - LIM["hand_sw"]) ** 2
            + max(0.0, abs(s["fore_tw"]) - LIM["fore_tw"]) ** 2 * 2 + max(0.0, LIM["elbow_min"] - s["elbow"]) ** 2
            + max(0.0, s["elbow"] - LIM["elbow_max"]) ** 2 + (max(0.0, s["shoulder"] - LIM["shoulder_slide"]) * 1000) ** 2)


def solve_left(pose, target, x0=None, w_rot=1.0, reg=(0.10, 0.02, 0.02), ref=None):
    """Left arm on `target` (Weapon_L world, camera space) under the natural constraints. Returns pose, x, errs, stats."""
    ref = ref if ref is not None else REF_L
    W = arms.world(pose)
    p2, x, e, r = ikL.solve(pose, W, target, ref, w_rot=w_rot, reg_rot=list(reg), reg_trans=0.05, x0=x0, extra=natural_residual)
    wl = arms.world(p2)
    return p2, x, (e, r), stats(wl)


def hand_frame(p, n, phi_deg, lift=0.0):
    """Weapon_L target (camera space) for a palm facing direction n (unit), fingers at angle phi about n,
    palm-surface point at p (+ lift back along -n)."""
    n = np.asarray(n, float); n = n / np.linalg.norm(n)
    a = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(n, a); u /= np.linalg.norm(u); v = np.cross(n, u)
    ph = np.radians(phi_deg)
    y = np.cos(ph) * u + np.sin(ph) * v
    z = np.cross(n, y)
    R = np.stack([n, y, z], 1)
    H = np.eye(4); H[:3, :3] = R
    H[:3, 3] = np.asarray(p, float) - n * lift - R @ A.PALM_PT
    return H @ A.WL_IN_HAND


# ---------------------------------------------------------------- right arm (holds the grip) under the same kind of limits
LIM_R = dict(hand_tw=12.0, hand_sw=75.0, fore_tw=25.0, elbow_min=8.0, elbow_max=128.0, shoulder_slide=0.10)


def natural_residual_R(wl, w=1.0):
    s = stats(wl, "R")
    r = [max(0.0, abs(s["hand_tw"]) - LIM_R["hand_tw"]) * 8.0, max(0.0, s["hand_sw"] - LIM_R["hand_sw"]) * 4.0,
         max(0.0, abs(s["fore_tw"]) - LIM_R["fore_tw"]) * 6.0,
         max(0.0, LIM_R["elbow_min"] - s["elbow"]) * 3.0, max(0.0, s["elbow"] - LIM_R["elbow_max"]) * 4.0,
         max(0.0, s["shoulder"] - LIM_R["shoulder_slide"]) * 1500.0]
    return np.concatenate([np.array(r) * w, A.keep_right(wl), elbow_residual(wl, "R")])


def stress_R(s):
    return (max(0.0, s.get("el_up", 0) - 0.45) ** 2 * 400 + max(0.0, s.get("el_in", 0) - 0.45) ** 2 * 400 + max(0.0, abs(s["hand_tw"]) - LIM_R["hand_tw"]) ** 2 * 4 + max(0.0, s["hand_sw"] - LIM_R["hand_sw"]) ** 2
            + max(0.0, abs(s["fore_tw"]) - LIM_R["fore_tw"]) ** 2 * 2 + max(0.0, LIM_R["elbow_min"] - s["elbow"]) ** 2
            + max(0.0, s["elbow"] - LIM_R["elbow_max"]) ** 2 + (max(0.0, s["shoulder"] - LIM_R["shoulder_slide"]) * 1000) ** 2)


def solve_right(pose, G, x0=None, ref=None):
    """Right arm carrying the weapon root G (camera space). Returns pose, x, (err m, err deg), stats."""
    from fp_common import S_ROOT
    from anim_util import normalized
    ref = ref if ref is not None else A.REF
    pose = dict(pose); pose["FP_Viewmodel"] = A.V0; pose["Hips"] = A.HEX["Hips"]
    W = arms.world(pose)
    tgt = normalized(G @ np.linalg.inv(S_ROOT) @ np.linalg.inv(A.M_FP))
    p2, x, e, r = A.ikR.solve(pose, W, tgt, ref, w_rot=1.0, reg_rot=[0.10, 0.02, 0.02], reg_trans=0.05, x0=x0, extra=natural_residual_R)
    return p2, x, (e, r), stats(arms.world(p2), "R")
