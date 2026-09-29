"""TP pose library for the Frisbee Launcher on Potato_TP_Character (v5 skin: repaired flanks / armpits).

'Always aiming' stance (the Paintball Rifle / Popcorn Shotgun v5 solver): in every clip the launcher points STRAIGHT
ahead (character +Z, level, no roll); the upper body is bladed a little (Spine_1 yaw / lean, solved) so the Potato's
short left arm reaches the vertical foregrip; both arms are solved every frame under natural-range limits, with the
belly-dent metric (no fold), the weapon kept out of the body and the rear sight under the eyes.
Re-cocking / magazine swap: the same timeline and the same weapon-space paths as the FP clips (sled handle, disc
path, cage path), the launcher turned toward the left hand (TP_CY_GUN / TP_RL_GUN).
"""
import sys, json, pickle, os
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
from rig import Rig, trs, qaxis, qmul, qnorm, quat_to_mat3, mat3_to_quat, slerp
import weapon_def as wd
import author_fp as A
from anim_util import Track, ease, normalized, blend_frames, frame_from, noise1
from ik import ChainIK
from twist import swing_twist

from tp_rig import ch, hexp
prof = json.load(open("WeaponProfile_HexSniper.json"))
M_HEX_TP = np.array(prof["mounts"]["tp"]["matrixColumnMajor"]).reshape(4, 4).T
S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)
HEX_GRIP = np.array([1.47, -0.17, 0.0])
M_TP = M_HEX_TP @ trs(wd.ROOT_SCALE * (HEX_GRIP - wd.GRIP + np.array(A.MOUNT_OFFSET)))
REST = ch.rest_pose()
S_TP = wd.ROOT_SCALE * float(np.linalg.norm(M_TP[:3, 0]))          # metres per weapon unit in TP
S_FP = A.GUN_SCALE

ikR = ChainIK(ch, ["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"], "Weapon_R",
              rot_bones=["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"])
ikL = ChainIK(ch, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"])
FINGERS_L = A.FINGERS_L
FINGERS_R = A.FINGERS_R


def channel_set(hex_clip):
    return sorted(hexp.clips[hex_clip]["channels"].keys())


HOLD_CH = channel_set("TP_Hold_HexSniper")
RUN_CH = channel_set("TP_Run_HexSniper")
RAISE_CH = sorted(set(channel_set("TP_Raise_HexSniper")) | {("Spine_1", "rotation"), ("Plant_Root", "rotation")})
HEX_HOLD0 = ch.pose_from_clip(hexp.clips["TP_Hold_HexSniper"], 0.0)


def hex_pose(clip, t):
    return ch.pose_from_clip(hexp.clips[clip], t)


def finger_q_R(name, s):
    rq = REST[name][1]; hq = HEX_HOLD0[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


# ---- hand sockets, same METRES relative to the part as in FP (the TP hand has the same size)
_FC = np.array([wd.FOREGRIP_X, 0.5 * (wd.FOREGRIP_Y0 + wd.FOREGRIP_Y1), 0.0])


def _to_tp(F, centre):
    G = F.copy(); G[:3, 3] = centre + (F[:3, 3] - centre) * (S_FP / S_TP); return G


OFF_TP = _to_tp(A.OFFHAND_FIT_V1, _FC)                 # TP keeps the v1 foregrip fist
SLED_GRAB_TP = _to_tp(A.SLED_GRAB_LOCAL, wd.SLED_HANDLE)


def tp_offhand(yaw_deg, slide):
    """TP foregrip socket turned about the vertical foregrip axis (+ = hand toward the back) and slid along it."""
    c = np.array([wd.FOREGRIP_X, 0.0, 0.0])
    R = np.eye(4); R[:3, :3] = Rot.from_euler("Y", yaw_deg, degrees=True).as_matrix()
    return trs(c) @ R @ trs(-c) @ trs([0.0, -slide, 0.0]) @ OFF_TP


TP_GRIP = dict(yaw=0.0, slide=0.0)          # solved on the key pose (tp_key.pkl)


def tp_nodes(Wn):
    """Swap the FP hand sockets for the TP ones (same metric relation)."""
    W2 = dict(Wn)
    W2["Offhand"] = Wn["Root"] @ tp_offhand(TP_GRIP["yaw"], TP_GRIP["slide"])
    W2["SledGrab"] = Wn["Sled"] @ SLED_GRAB_TP
    return W2


def tp_palm(node_world, p_units, n, phi):
    """TP twin of author_fp.palm_target (node-local point in weapon units -> metres with the TP scale)."""
    return normalized(node_world) @ A.N.hand_frame(np.asarray(p_units, float) * S_TP, n, phi)


def tp_disc_target(Gd):
    return tp_palm(Gd, A.DISC_GRIP["p"], A.DISC_GRIP["n"], A.DISC_GRIP["phi"])


def tp_cage_target(Gc):
    return tp_palm(Gc, A.CAGE_GRIP["p"], A.CAGE_GRIP["n"], A.CAGE_GRIP["phi"])


# ---------------------------------------------------------------- straight-stance solver (ported from the v5 popcorn)
import belly
REF_BODY = belly.rest_arms(dict(REST, **hex_pose("TP_Aim_HexSniper", 0.0)))
DENT_TOL = 0.006
HEX_AIM = hex_pose("TP_Aim_HexSniper", 0.0)
R_STRAIGHT = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])   # weapon X->-Z(char fwd is +Z), Y->Y
ARM_BONES = {s: [f"Shoulder_{s}", f"UpperArm_{s}", f"LowerArm_{s}", f"Hand_{s}"] for s in "LR"}

_body = np.load("tp_body_aim.npy")
GX = np.arange(-0.20, 0.2001, 0.01); GY = np.arange(0.25, 0.7501, 0.01)
ZF = np.full((len(GY), len(GX)), -1.0)
for _k, _y in enumerate(GY):
    for _j, _x in enumerate(GX):
        _m = (np.abs(_body[:, 1] - _y) < 0.012) & (np.abs(_body[:, 0] - _x) < 0.012)
        if _m.any(): ZF[_k, _j] = _body[_m, 2].max()


def zfront(x, y):
    fx = np.clip((x - GX[0]) / 0.01, 0, len(GX) - 1.001); fy = np.clip((y - GY[0]) / 0.01, 0, len(GY) - 1.001)
    i0, j0 = int(fy), int(fx); ty, tx = fy - i0, fx - j0
    z = (ZF[i0, j0] * (1 - tx) * (1 - ty) + ZF[i0, j0 + 1] * tx * (1 - ty) + ZF[i0 + 1, j0] * (1 - tx) * ty + ZF[i0 + 1, j0 + 1] * tx * ty)
    inside = (GX[0] <= x <= GX[-1]) and (GY[0] <= y <= GY[-1])
    return z if inside else -1.0


_pts = np.concatenate([np.array(wd.parts()[n].pos) for n in ("Body",)] + [np.array(wd.parts()["Cage"].pos) + wd.CAGE_C])
STOCK_X = 1.30                                        # the stock may sink into the soft chest (shouldered gun)
WPTS = _pts[(_pts[:, 0] > -1.2) & (_pts[:, 0] < STOCK_X)]
WPTS = WPTS[np.random.default_rng(0).choice(len(WPTS), min(500, len(WPTS)), replace=False)]
EYE_BOTTOM = 0.618
GUN_TOP = np.array([1.0, 0.74, 0.0])                  # rear sight top: stays under the eyes


def gun_matrix(p, yaw=0.0, pitch=0.0, roll=0.0):
    R = Rot.from_euler("YXZ", [yaw, -pitch, -roll], degrees=True).as_matrix() @ R_STRAIGHT
    G = np.eye(4); G[:3, :3] = R * S_TP; G[:3, 3] = np.asarray(p) - R * S_TP @ wd.GRIP
    return G


def delta_st(pose, b):
    d = Rot.from_quat(REST[b][1]).inv() * Rot.from_quat(pose[b][1])
    return swing_twist(d.as_quat())


HEX_HOLD = hex_pose("TP_Hold_HexSniper", 0.0)
REF_ST = {b: delta_st(HEX_HOLD, b) for s in "LR" for b in ARM_BONES[s]}


def natural(pose, w=1.0):
    r = []
    for s in "LR":
        for b in ARM_BONES[s]:
            sw, tw = delta_st(pose, b); sw0, tw0 = REF_ST[b]
            dead = {"Shoulder": 6, "UpperArm": 30, "LowerArm": 14, "Hand": 8}[b[:-2]]
            r.append(max(0.0, abs(tw - tw0) - dead) * 0.6 * w)
            if b.startswith("Shoulder"): r.append(max(0.0, sw - 32.0) * 1.0 * w)
            if b.startswith("Hand"): r.append(max(0.0, sw - 45.0) * 0.6 * w)
            if b.startswith("LowerArm"): r.append(max(0.0, 12.0 - sw) * 0.5 * w)
    return np.array(r)


SPINE_MAX = dict(yaw=14.0, lean=8.0)


def spine_pose(base, yaw, lean):
    p = dict(base)
    T_, R_, S_ = base["Spine_1"]
    q = (Rot.from_quat(R_) * Rot.from_euler("YX", [yaw, lean], degrees=True)).as_quat()
    p["Spine_1"] = (T_, q, S_)
    return p


def solve_straight(p0=(-0.04, 0.46, 0.20), base=None, x0=None, st=None, fix_p=None, gun_off=None,
                   lh=None, w_nat=1.0, verbose=True, max_nfev=300, spine0=(0.0, 0.0), free_spine=True, w_eye=250.0, w_dent=600.0,
                   wrot_l=0.6, free_grip=False, grip0=(20.0, 0.0)):
    base0 = dict(base if base is not None else HEX_AIM)
    base0["Weapon_R"] = REST["Weapon_R"]
    SP0 = ch.world(base0)["Spine_1"]
    nR, nL = ikR.nx, ikL.nx
    nS = 2 if free_spine else 0
    go = gun_off or {}
    lh0 = lh or (lambda Wn: Wn["Offhand"])
    nG = 2 if free_grip else 0

    def unpack(x):
        k = 0
        if fix_p is None: p = x[0:3]; k = 3
        else: p = np.asarray(fix_p)
        xR, xL = x[k:k + nR], x[k + nR:k + nR + nL]
        sp = x[k + nR + nL:k + nR + nL + nS] if free_spine else np.asarray(spine0)
        gr = x[k + nR + nL + nS:k + nR + nL + nS + nG] if free_grip else None
        return p, xR, xL, sp, gr

    def build(x):
        p, xR, xL, sp, gr = unpack(x)
        lh = (lambda Wn: Wn["Root"] @ tp_offhand(gr[0], gr[1])) if free_grip else lh0
        base = spine_pose(base0, sp[0], sp[1])
        Wb = ch.world(base)
        WpR, WpL = Wb[ikR.parent_of_root], Wb[ikL.parent_of_root]
        G = gun_matrix(p, go.get("yaw", 0.0), go.get("pitch", 0.0), go.get("roll", 0.0))
        tR = normalized(G @ np.linalg.inv(S_ROOT) @ np.linalg.inv(M_TP))
        wR, wL = {}, {}
        ER, locR = ikR.fk(base, WpR, xR, base, wR)
        Wn = tp_nodes(wd.world_nodes(G, st))
        tL = normalized(lh(Wn))
        EL, locL = ikL.fk(base, WpL, xL, base, wL)
        pose = dict(base); pose.update(locR); pose.update(locL)
        Md = np.linalg.inv(Wb["Spine_1"] @ np.linalg.inv(SP0))
        return p, G, tR, tL, ER, EL, pose, Md, sp, wR, wL, gr

    def res(x):
        p, G, tR, tL, ER, EL, pose, Md, sp, wR, wL, gr = build(x)
        r = [(ER[:3, 3] - tR[:3, 3]) * 1000, Rot.from_matrix(tR[:3, :3].T @ normalized(ER)[:3, :3]).as_rotvec() * 57.3 * 0.8,
             (EL[:3, 3] - tL[:3, 3]) * 1000, Rot.from_matrix(tL[:3, :3].T @ normalized(EL)[:3, :3]).as_rotvec() * 57.3 * wrot_l]
        r.append(natural(pose, w_nat))
        if w_dent > 0:
            d, _ = belly.dent(pose, REF_BODY)
            r.append(np.maximum(0.0, d - DENT_TOL) * w_dent)
        if fix_p is None or free_spine:
            P = (G[:3, :3] @ WPTS.T).T + G[:3, 3]
            P = (Md[:3, :3] @ P.T).T + Md[:3, 3]
            r.append([max(0.0, zfront(q[0], q[1]) + 0.005 - q[2]) * 800 for q in P])
        wr_ = Md[:3, :3] @ ER[:3, 3] + Md[:3, 3]; r.append([max(0.0, zfront(wr_[0], wr_[1]) + 0.035 - wr_[2]) * 800])
        for sd, ww in (("R", wR), ("L", wL)):
            r.append([max(0.0, ww[f"LowerArm_{sd}"][1, 3] - ww[f"Hand_{sd}"][1, 3] + 0.01) * 400])
        if free_spine:
            r.append([max(0.0, abs(sp[0]) - SPINE_MAX["yaw"]) * 3, max(0.0, abs(sp[1]) - SPINE_MAX["lean"]) * 3, sp[0] * 0.05, sp[1] * 0.08])
        if free_grip:
            r.append([max(0.0, gr[0] - 60.0) * 5, max(0.0, -15.0 - gr[0]) * 5, max(0.0, gr[1] - 0.25) * 300,
                      max(0.0, -0.12 - gr[1]) * 300, gr[0] * 0.02])
        if fix_p is None:
            top = (G @ np.r_[GUN_TOP, 1.0])[1]
            r.append([max(0.0, top - (EYE_BOTTOM + 0.005)) * w_eye, (p[0] + 0.03) * 20, p[2] * 8])
        return np.concatenate([np.atleast_1d(np.asarray(a, float)).ravel() for a in r])

    if x0 is None:
        x0 = np.zeros((3 if fix_p is None else 0) + nR + nL + nS + nG)
        if fix_p is None: x0[:3] = p0
        if free_spine: x0[len(x0) - nG - 2:len(x0) - nG] = spine0
        if free_grip: x0[-2:] = grip0
    sol = least_squares(res, x0, method="trf", max_nfev=max_nfev, diff_step=1e-4)
    p, G, tR, tL, ER, EL, pose, Md, sp, wR, wL, gr = build(sol.x)
    eR = np.linalg.norm(ER[:3, 3] - tR[:3, 3]); eL = np.linalg.norm(EL[:3, 3] - tL[:3, 3])
    rL = np.degrees(Rot.from_matrix(tL[:3, :3].T @ normalized(EL)[:3, :3]).magnitude())
    info = dict(p=p, G=G, eR=eR, eL=eL, rL=rL, cost=sol.cost, x=sol.x, spine=sp, grip=gr)
    if verbose:
        P = (G[:3, :3] @ WPTS.T).T + G[:3, 3]; P = (Md[:3, :3] @ P.T).T + Md[:3, 3]
        pen = max(max(0.0, zfront(q[0], q[1]) - q[2]) for q in P)
        top = (G @ np.r_[GUN_TOP, 1.0])[1]
        dd, vr = belly.dent(pose, REF_BODY)
        st = " | ".join(f"{b}: {delta_st(pose, b)[0]:.0f}/{delta_st(pose, b)[1]:.0f}" for s in "LR" for b in ARM_BONES[s])
        print(f"dent R {dd[vr[:, 0] < 0].max()*1000:.1f}mm L {dd[vr[:, 0] > 0].max()*1000:.1f}mm | grip p {np.round(p, 3)} | "
              f"R {eR*1000:.2f}mm L {eL*1000:.2f}mm {rL:.1f}deg | body pen {pen*1000:.1f}mm | gun top {top:.3f} | "
              f"spine yaw {sp[0]:.1f} lean {sp[1]:.1f} | grip {None if gr is None else np.round(gr, 2)} | cost {sol.cost:.1f}\n   {st}", flush=True)
    return pose, info


if __name__ == "__main__" and sys.argv[1:2] == ["key"]:
    best = None
    for p0 in [(0.0, 0.46, 0.17), (0.03, 0.45, 0.15), (-0.03, 0.47, 0.18)]:
        for sp0, g0 in [((-10.0, 5.0), (20.0, 0.05)), ((-12.0, 8.0), (35.0, 0.0))]:
            pose, info = solve_straight(p0, st={}, spine0=sp0, max_nfev=500, free_grip=True, grip0=g0)
            if best is None or info["cost"] < best[1]["cost"]: best = (pose, info)
    pickle.dump(best, open("tp_key.pkl", "wb"))
    print("BEST", np.round(best[1]["p"], 3), best[1]["spine"], best[1]["grip"], best[1]["cost"], best[1]["eL"], best[1]["rL"])


# ---------------------------------------------------------------- clips (always aiming)
def load_key(path="tp_key.pkl"):
    k = pickle.load(open(path, "rb"))[1]
    TP_GRIP.update(yaw=float(k["grip"][0]), slide=float(k["grip"][1]))
    return np.asarray(k["p"], float), tuple(float(v) for v in k["spine"])


class Baker:
    def __init__(self):
        self.x = None

    skip = False                                                     # True: only the weapon state (in-between frame)

    def frame(self, base, p, off=None, lh=None, st=None, lf=None, rfi=1.0, w_nat=1.0, wrot=0.6):
        if self.skip:
            return None, dict(st or {}), (0.0, 0.0, 0.0, 0.0)
        kw = dict(base=base, fix_p=p, gun_off=off or {}, lh=lh, st=st or {}, free_spine=False, verbose=False, w_nat=w_nat,
                  max_nfev=200, wrot_l=wrot)
        pose, info = solve_straight(x0=self.x, **kw)
        if info["eL"] > 0.008 and self.x is not None:            # cold restart only when clearly stuck (slow)
            p2, i2 = solve_straight(x0=None, **dict(kw, max_nfev=300))
            if i2["eL"] + i2["eR"] < info["eL"] + info["eR"]: pose, info = p2, i2
        self.x = info["x"]
        lf = A.FORE_CURLS_V1 if lf is None else lf
        lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
        for n in FINGERS_L:
            pose[n] = (REST[n][0], A.finger_q(n, lfs.get(n, 1.0)), REST[n][2])
        pose["Index_R_1"] = (REST["Index_R_1"][0], finger_q_R("Index_R_1", rfi), REST["Index_R_1"][2])
        pose["Weapon_R"] = REST["Weapon_R"]
        return pose, dict(st or {}), (info["eR"], 0.0, info["eL"], info["rL"])


P0, SPINE = (None, None)


def body(clip, t, s=1.0):
    return spine_pose(hex_pose(clip, t), SPINE[0] * s, SPINE[1] * s)


def breathing(t, period=2.0, amp=1.0):
    ph = 2 * np.pi * t / period
    return np.array([0.0006 * np.sin(ph + 0.6), 0.0016 * np.sin(ph), 0.0005 * np.sin(ph + 2.2)]) * amp, \
        dict(pitch=0.5 * amp * np.sin(ph + 1.1), roll=0.4 * amp * np.sin(ph + 2.0), yaw=0.25 * amp * np.sin(ph + 0.4))


def c_hold(t, bk):
    dp, dr = breathing(t)
    return bk.frame(body("TP_Aim_HexSniper", t), P0 + dp, dr)


def c_aim(t, bk):
    dp, dr = breathing(t, amp=0.5)
    return bk.frame(body("TP_Aim_HexSniper", t), P0 + np.array([0.0, 0.004, 0.0]) + dp, dr)


def c_raise(t, bk, dur=0.3):
    u = ease(t / dur, "io")
    return bk.frame(body("TP_Aim_HexSniper", 0.0), P0 + np.array([0.0, 0.004 * u, 0.0]))


def c_lower(t, bk, dur=0.3):
    u = ease(t / dur, "io")
    return bk.frame(body("TP_Aim_HexSniper", 0.0), P0 + np.array([0.0, 0.004 * (1 - u), 0.0]))


_CH0 = None


def c_run(t, bk):
    global _CH0
    if _CH0 is None: _CH0 = ch.world(body("TP_Aim_HexSniper", 0.0))["Chest"][:3, 3]
    b = body("TP_Run_HexSniper", t)
    chest = ch.world(b)["Chest"][:3, 3]
    ph = 2 * np.pi * t / 0.8
    dp = (chest - _CH0) * np.array([0.8, 1.0, 0.6]) + np.array([0.004 * np.sin(ph), 0.006 * np.cos(2 * ph), 0.0])
    return bk.frame(b, P0 + dp, dict(yaw=1.5 * np.sin(ph), pitch=1.5 * np.cos(2 * ph + 0.4), roll=2.0 * np.sin(ph + 0.3)))


def _kick_body(base, k):
    b2 = dict(base)
    Tq, Rq, Sq = base["Spine_1"]
    b2["Spine_1"] = (Tq, (Rot.from_quat(Rq) * Rot.from_euler("X", -1.6 * k, degrees=True)).as_quat(), Sq)
    return b2


# ---- TP launcher offsets during the re-cock / swap (character space: +X = the character's LEFT, +Z forward)
CY = A.CY
TP_CY_GUN = Track([(0, np.zeros(6)),
                   (0.16, [0.02, 0.01, -0.04, 18.0, 6.0, -14.0], "io"),
                   (CY["h1"], [0.03, 0.01, -0.05, 22.0, 6.0, -18.0], "io"),
                   (CY["pull"], [0.04, 0.02, -0.07, 24.0, 12.0, -18.0], "io"),
                   (CY["take"], [0.04, 0.01, -0.06, 22.0, 14.0, -22.0], "io"),
                   (0.90, [0.05, 0.03, -0.08, 26.0, 20.0, -18.0], "io"),
                   (CY["seat"], [0.04, 0.02, -0.06, 22.0, 12.0, -20.0], "io"),
                   (CY["end"], np.zeros(6), "io")])


def tp_place(v):
    v = np.asarray(v, float)
    return v[:3], dict(yaw=v[3], pitch=v[4], roll=v[5])


def tp_cycle_target(u, G, st_now):
    """World hand target for the cycle schedule element at u (TP sockets), with the gun G."""
    L = A.cycle_left(u)
    if L[0] == "grip":
        return normalized(tp_nodes(wd.world_nodes(G, st_now))["Offhand"])
    if A.CY["h1"] <= u < A.CY["rel"]:
        return normalized(tp_nodes(wd.world_nodes(G, dict(st_now, sled=float(A.SLED_CY(u)))))["SledGrab"])
    if A.CY["d0"] <= u < A.CY["drel"]:
        return tp_disc_target(G @ A.disc_in_hand(max(u, A.CY["take"])))
    if L[0] == "jb":
        ua, ub = L[1], L[2]
        w = ease((u - ua) / (ub - ua), "io")
        ta = tp_cycle_target(ua - 1e-6 if ua > 0 else 0.0, G, st_now) if ua > 0 else tp_cycle_target(-1.0, G, st_now)
        tb = tp_cycle_target(ub + 1e-6, G, st_now)
        return blend_frames(ta, tb, w)
    return normalized(tp_nodes(wd.world_nodes(G, st_now))["Offhand"])


def _cycle_lf(u):
    L = A.cycle_left(u)
    if L[0] == "contact": return L[2]
    if L[0] == "jb":
        w = ease((u - L[1]) / (L[2] - L[1]), "io")
        a = A.cycle_left(L[1] - 1e-6) if L[1] > 0 else ("grip",); b = A.cycle_left(L[2] + 1e-6)
        ca = a[2] if a[0] == "contact" else A.FORE_CURLS_V1; cb = b[2] if b[0] == "contact" else A.FORE_CURLS_V1
        return {n: ca.get(n, 1.0) * (1 - w) + cb.get(n, 1.0) * w - 0.3 * np.sin(np.pi * w) for n in FINGERS_L}
    return None


def c_fire(t, bk, cycle=True):
    c0 = A.SHOT["end"]
    k = A.KICK(t)
    kk = float(np.clip(k[4] / 4.0, 0, 1))
    base = _kick_body(body("TP_Aim_HexSniper", 0.0), 0.6 * kk)
    st = A.fire_def(cycle=cycle).state(t)
    p = P0 + np.array([0.0, 0.0015 * kk, -0.006 * kk])
    off = dict(pitch=1.8 * kk, roll=0.3 * kk, yaw=-0.2 * kk)
    if not cycle or t < c0:
        return bk.frame(base, p, off, st=st, rfi=float(A.RFI_SHOT(t)))
    u = t - c0
    dp, doff = tp_place(TP_CY_GUN(u))
    p = p + dp
    off = {k2: off.get(k2, 0.0) + doff[k2] for k2 in doff}
    G = gun_matrix(p, off["yaw"], off["pitch"], off["roll"])
    tgt = tp_cycle_target(u, G, st)
    return bk.frame(base, p, off, lh=lambda Wn, tgt=tgt: tgt, st=st, lf=_cycle_lf(u), w_nat=0.8,
                    wrot=0.6 if A.cycle_left(u)[0] != "jb" else 0.25)


def c_fire_last(t, bk):
    return c_fire(t, bk, cycle=False)


# --- reload (same timeline as FP): the empty cage goes to the LEFT hip, a full one comes from the belt
RL = A.RL
TP_RL_GUN = Track([(0, np.zeros(6)), (RL["h1"], [0.02, 0.02, -0.03, 12.0, 8.0, 16.0], "io"),
                   (RL["down"], [0.03, 0.02, -0.03, 14.0, 9.0, 18.0], "io"),
                   (RL["away"], [0.02, 0.01, -0.02, 8.0, 5.0, 10.0], "io"),
                   (RL["back"], [0.02, 0.01, -0.02, 8.0, 5.0, 10.0], "lin"),
                   (RL["align"], [0.03, 0.02, -0.03, 14.0, 9.0, 18.0], "io"),
                   (RL["seat"], [0.03, 0.015, -0.03, 14.0, 7.0, 18.0], "out"),
                   (RL["ret"], [0.003, 0.002, -0.002, 1.0, 0.8, 2.0], "io"),
                   (RL["end"], np.zeros(6), "io")])
CAGE_KEYS_TP = [(RL["grab"], "local", [0, 0, 0, 0, 0, 0]),
                (RL["down"], "local", [0.05, -0.55, 0.15, 0, 0, 8]),
                (RL["drop"], "local", [0.30, -1.60, 1.40, 25, 0, 15]),
                (RL["away"], "char", [0.25, 0.36, 0.03, 20, 0, 70]),          # belt pouch, left hip (side)
                (RL["back"], "char", [0.24, 0.37, 0.05, 20, 0, 60]),
                (RL["low"], "local", [0.20, -1.40, 1.10, 20, 0, 10]),
                (RL["align"], "local", [0.0, -0.45, 0.05, 2, 0, 2]),
                (RL["seat"], "local", [0, 0, 0, 0, 0, 0])]


def reload_gun_tp(t):
    v = TP_RL_GUN(t)
    k = float(A.SEAT_JOLT(t))
    return P0 + v[:3] + np.array([0.0, -0.003 * k, 0.0]), dict(yaw=v[3], pitch=v[4] - 0.8 * k, roll=v[5])


def _G_tp(t):
    p, off = reload_gun_tp(t)
    return gun_matrix(p, off["yaw"], off["pitch"], off["roll"])


_TPKEYS = {}


def tp_cage_keys():
    """CAGE_KEYS_TP with the character-space keys converted to cage offsets (ROOT space)."""
    if not _TPKEYS:
        keys = []
        for tk, kind, v in CAGE_KEYS_TP:
            if kind == "char":
                G = _G_tp(tk); Gi = np.linalg.inv(G); Gn = normalized(G)
                p = (Gi @ np.r_[np.asarray(v[:3], float), 1.0])[:3]
                R = Gn[:3, :3].T @ Rot.from_euler("XYZ", v[3:], degrees=True).as_matrix()
                e = Rot.from_matrix(R).as_euler("XYZ", degrees=True)
                keys.append((tk, "local", list(p - wd.CAGE_C) + list(e)))
            else:
                keys.append((tk, kind, v))
        _TPKEYS["k"] = keys
    return _TPKEYS["k"]


TP_HANDOFF = 1.0 / 60.0          # the TP cage node is hidden one frame after the release: the world prop takes over


def cage_local_tp(t):
    """TP cage node (ROOT space): in the hand until the release, then HIDDEN (the runtime drops a world-space copy that
    falls to the ground: DroppedCages / onCageDrop), the new cage grows out of the belt pouch at hide1."""
    if t <= RL["grab"] or t >= RL["seat"]:
        return None
    if RL["release"] + TP_HANDOFF <= t < RL["hide1"]:
        return "hidden"
    return A.cage_grow(A.cage_key_path(t, _G_tp, tp_cage_keys()), t)


def cage_grip_tp(t):
    return A.cage_hand_at(t, _G_tp, tp_cage_keys())


def reload_left_tp(t):
    """TP left-hand schedule of the cage swap: on the cage / the hand's path to the belt pouch from h1 to rel (the FP
    arm drops out of the view instead, A.reload_left), joint blends before / after."""
    if t < RL["h1"]: return ("jb", 0.0, RL["h1"])
    if t < RL["rel"]:
        c = ease((t - RL["h1"]) / (RL["grab"] - RL["h1"]), "io")
        o = ease((t - RL["seat"]) / (RL["rel"] - RL["seat"]), "io") if t > RL["seat"] else 0.0
        r = ease((t - RL["release"]) / 0.05, "out") if t > RL["release"] else 0.0
        g = ease((t - (RL["hide1"] - 0.10)) / 0.08, "io") if t > RL["hide1"] - 0.10 else 0.0
        hold = c * (1 - r + r * g) * (1 - o)
        return ("contact", None, {k: A.OPEN + (A.CAGE_CURLS[k] - A.OPEN) * hold for k in A.CAGE_CURLS})
    if t < RL["ret"]: return ("jb", RL["rel"], RL["ret"])
    return ("grip",)


def reload_target_tp(t, G, st):
    L = reload_left_tp(t)
    if L[0] == "grip":
        return normalized(tp_nodes(wd.world_nodes(G, st))["Offhand"])
    if RL["h1"] <= t < RL["rel"]:
        return tp_cage_target(G @ cage_grip_tp(t))
    ua, ub = L[1], L[2]
    w = ease((t - ua) / (ub - ua), "io")
    ta = reload_target_tp(ua - 1e-6, G, st) if ua > 0 else normalized(tp_nodes(wd.world_nodes(G, st))["Offhand"])
    tb = reload_target_tp(ub + 1e-6, G, st) if ub < RL["ret"] else normalized(tp_nodes(wd.world_nodes(G, st))["Offhand"])
    return blend_frames(ta, tb, w)


def c_reload(t, bk, deck="loaded", sled=1.0):
    p, off = reload_gun_tp(t)
    G = gun_matrix(p, off["yaw"], off["pitch"], off["roll"])
    cg = cage_local_tp(t)
    st = dict(sled=sled, flex=sled, deck=deck, hand=None, cage=cg, cage_n=wd.CAGE_SLOTS if t >= RL["hide1"] else 0)
    tgt = reload_target_tp(t, G, st)
    L = reload_left_tp(t)
    lf = L[2] if L[0] == "contact" else None
    return bk.frame(body("TP_Aim_HexSniper", 0.0), p, off, lh=lambda Wn, tgt=tgt: tgt, st=st, lf=lf, rfi=0.9, w_nat=0.8,
                    wrot=0.6 if L[0] != "jb" else 0.25)


def c_reload_empty(t, bk):
    c0 = RL["rel"] + 0.20 - CY["h1"]
    if t < RL["rel"]:
        return c_reload(t, bk, deck=None, sled=0.0)
    u = t - c0
    w = ease((t - RL["seat"]) / 0.24, "io")
    p_r, off_r = reload_gun_tp(min(t, RL["rel"] + 0.1))
    v_r = np.r_[p_r - P0, off_r["yaw"], off_r["pitch"], off_r["roll"]]
    v = v_r * (1 - w) + TP_CY_GUN(max(0.0, u)) * w
    p, off = P0 + v[:3], dict(yaw=v[3], pitch=v[4], roll=v[5])
    st = A.cycle_state(u) if u >= CY["grab"] else dict(sled=0.0, flex=0.0, deck=None)
    st["cage_n"] = wd.CAGE_SLOTS
    G = gun_matrix(p, off["yaw"], off["pitch"], off["roll"])
    if u < CY["h1"]:
        ww = ease((t - RL["rel"]) / (c0 + CY["h1"] - RL["rel"]), "io")
        tgt = blend_frames(tp_cage_target(G @ trs(wd.CAGE_C)), tp_cycle_target(CY["h1"] + 1e-6, G, st), ww)
        lf = None; wrot = 0.25
    else:
        tgt = tp_cycle_target(u, G, st); lf = _cycle_lf(u); wrot = 0.6 if A.cycle_left(u)[0] != "jb" else 0.25
    return bk.frame(body("TP_Aim_HexSniper", 0.0), p, off, lh=lambda Wn, tgt=tgt: tgt, st=st, lf=lf, w_nat=0.8, wrot=wrot)


TP_CLIPS = {
    "TP_Hold_FrisbeeLauncher": (c_hold, 2.0, 30, True, HOLD_CH),
    "TP_Run_FrisbeeLauncher": (c_run, 0.8, 30, True, RUN_CH),
    "TP_Aim_FrisbeeLauncher": (c_aim, 2.0, 30, True, HOLD_CH),
    "TP_Raise_FrisbeeLauncher": (c_raise, 0.3, 120, False, RAISE_CH),
    "TP_Lower_FrisbeeLauncher": (c_lower, 0.3, 120, False, RAISE_CH),
    "TP_Fire_FrisbeeLauncher": (c_fire, A.SHOT["end"] + CY["end"], 30, False, HOLD_CH),
    "TP_FireLast_FrisbeeLauncher": (c_fire_last, 0.5, 60, False, HOLD_CH),
    "TP_Reload_FrisbeeLauncher": (c_reload, RL["end"], 30, False, HOLD_CH),
    "TP_ReloadEmpty_FrisbeeLauncher": (c_reload_empty, RL["rel"] + 0.20 - CY["h1"] + CY["end"], 30, False, HOLD_CH),
}


KEY_STEP = 3


def bake(name):
    fn, dur, fps, loop, chans = TP_CLIPS[name]
    chans = sorted(set(chans) | {(b, "rotation") for b in FINGERS_L + FINGERS_R + ["Hand_L", "LowerArm_L", "UpperArm_L", "Shoulder_L",
                                                                                     "Hand_R", "LowerArm_R", "UpperArm_R", "Shoulder_R", "Spine_1"]}
                   | {("Weapon_R", "translation")})
    n = int(round(dur * fps)) + 1
    bk = Baker()
    frames, ws, errs = [], [], []
    bones = set(c[0] for c in chans)
    # action clips: IK solved every KEY_STEP-th frame (and every frame around the shot kick), joint-space interpolation
    # in between (the TP solver is slow; the hand targets are smooth so the in-between contact error stays small)
    step = KEY_STEP if (not loop and fps <= 30) else 1
    solve = [i % step == 0 or i == n - 1 or (name.startswith("TP_Fire") and i / fps < 0.30) for i in range(n)]
    for i in range(n):
        t = min(i / fps, dur)
        bk.skip = not solve[i]
        pose, w, err = fn(t, bk)
        frames.append(None if pose is None else {b: pose[b] for b in bones})
        if i % 10 == 0: print(f"  {name} {i}/{n} eL={err[2] * 1000:.1f}mm", flush=True)
        ws.append(w); errs.append(err)
    bk.skip = False
    keys = [i for i in range(n) if frames[i] is not None]
    for a, b in zip(keys[:-1], keys[1:]):
        for i in range(a + 1, b):
            u = (i - a) / (b - a)
            fa, fb = frames[a], frames[b]
            frames[i] = {bn: (np.asarray(fa[bn][0]) * (1 - u) + np.asarray(fb[bn][0]) * u,
                              slerp(np.asarray(fa[bn][1], float), np.asarray(fb[bn][1], float), u), fa[bn][2]) for bn in bones}
            errs[i] = tuple(np.asarray(errs[a]) * (1 - u) + np.asarray(errs[b]) * u)
    errs = np.array(errs)
    print(f"{name:30s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
          f"maxR={errs[:, 0].max() * 1000:.2f}mm", flush=True)
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=ws, channels=chans, errors=errs)


if __name__ == "__main__" and sys.argv[1:2] != ["key"]:
    P0, SPINE = load_key()
    OUT = os.environ.get("OUT", "tp_clips.pkl")
    todo = sys.argv[1:] or list(TP_CLIPS)
    try:
        out = pickle.load(open(OUT, "rb"))
    except Exception:
        out = {}
    for nm in todo:
        out[nm] = bake(nm)
        out["_meta"] = dict(mount=M_TP, channels=HOLD_CH, grip=dict(TP_GRIP), spine=SPINE, p0=P0)
        pickle.dump(out, open(OUT, "wb"))
