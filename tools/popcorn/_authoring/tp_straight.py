"""v5 — TP 'always aiming' hold: the gun points STRAIGHT ahead (character +Z, level, no roll) and both arms are
solved together with the gun position, under natural-range limits (no twisted forearms / wrists, shoulders
close to the HexSniper authoring), with the weapon kept out of the body and the tank under the eyes."""
import sys, json, numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
sys.argv = sys.argv[:1]
import author_tp as T
import author_fp as A
import weapon_def as wd
from rig import Rig, trs, skin_vertices
from scene import drawables
from twist import swing_twist
import belly
import os as _os
if _os.path.exists("tp_weights_J.npy"):          # v5: the repaired flank / armpit skin of Potato_TP_Character
    _J1, _W1 = np.load("tp_weights_J.npy"), np.load("tp_weights_W.npy")
    belly.J, belly.WT = _J1, _W1
    belly.SUBJ, belly.SUBW = _J1[belly.INV], _W1[belly.INV]
REF_BODY = belly.rest_arms(dict(T.ch.rest_pose(), **T.hex_pose("TP_Aim_HexSniper", 0.0)))   # clean body: hex aim torso, arms at rest
DENT_TOL = 0.006

ch = T.ch
REST = ch.rest_pose()
HEX_HOLD = T.hex_pose("TP_Hold_HexSniper", 0.0)
HEX_AIM = T.hex_pose("TP_Aim_HexSniper", 0.0)
S = wd.ROOT_SCALE * float(np.linalg.norm(T.M_TP[:3, 0]))          # metres per weapon unit in TP (0.0665)
R_STRAIGHT = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])   # columns: weapon X->-Z, Y->Y, Z->+X
ARM_BONES = {s: [f"Shoulder_{s}", f"UpperArm_{s}", f"LowerArm_{s}", f"Hand_{s}"] for s in "LR"}

# ---------------------------------------------------------------- body front surface (height map, no arms)
_body = np.load("tp_body_aim.npy")
GX = np.arange(-0.20, 0.2001, 0.01); GY = np.arange(0.25, 0.7501, 0.01)
ZF = np.full((len(GY), len(GX)), -1.0)
for k, y in enumerate(GY):
    for j, x in enumerate(GX):
        m = (np.abs(_body[:, 1] - y) < 0.012) & (np.abs(_body[:, 0] - x) < 0.012)
        if m.any(): ZF[k, j] = _body[m, 2].max()


def zfront(x, y):
    fx = np.clip((x - GX[0]) / 0.01, 0, len(GX) - 1.001); fy = np.clip((y - GY[0]) / 0.01, 0, len(GY) - 1.001)
    i0, j0 = int(fy), int(fx); ty, tx = fy - i0, fx - j0
    z = (ZF[i0, j0] * (1 - tx) * (1 - ty) + ZF[i0, j0 + 1] * tx * (1 - ty) + ZF[i0 + 1, j0] * (1 - tx) * ty + ZF[i0 + 1, j0 + 1] * tx * ty)
    inside = (GX[0] <= x <= GX[-1]) and (GY[0] <= y <= GY[-1])
    return z if inside else -1.0


# ---------------------------------------------------------------- weapon points (weapon units)
_wr = Rig("PopcornShotgun_Weapon.glb")
_Ww = _wr.world(_wr.rest_pose())
_pts = np.concatenate([d[0] for d in drawables(_wr, _Ww)]) / wd.ROOT_SCALE
WPTS = _pts[(_pts[:, 0] > -0.3) & (_pts[:, 0] < 1.35)]   # receiver, grip, tank: must stay out of the body; the stock
# (x > 1.35) may sink into the soft chest — it reads as a shouldered gun (the HexSniper TP aim does the same)
WPTS = WPTS[np.random.default_rng(0).choice(len(WPTS), min(500, len(WPTS)), replace=False)]
EYE_BOTTOM = 0.618


def gun_matrix(p, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon ROOT matrix (character space): straight ahead, grip at p; optional small offsets (deg)."""
    R = Rot.from_euler("YXZ", [yaw, -pitch, -roll], degrees=True).as_matrix() @ R_STRAIGHT
    G = np.eye(4); G[:3, :3] = R * S; G[:3, 3] = np.asarray(p) - R * S @ wd.GRIP
    return G


def rx(deg):
    M = np.eye(4); c, s_ = np.cos(np.radians(deg)), np.sin(np.radians(deg)); M[1:3, 1:3] = [[c, -s_], [s_, c]]; return M


OFF0 = A.OFFHAND_FIT.copy()
OFF0[:3, 3] *= float(np.linalg.norm(A.M_FP[:3, 0]) / np.linalg.norm(T.M_TP[:3, 0]))   # same hand-to-pump metres as FP


def tp_offhand(theta, slide):
    return trs([slide, 0, 0]) @ rx(theta) @ OFF0


def delta_st(pose, b):
    d = Rot.from_quat(REST[b][1]).inv() * Rot.from_quat(pose[b][1])
    return swing_twist(d.as_quat())


REF_ST = {b: delta_st(HEX_HOLD, b) for s in "LR" for b in ARM_BONES[s]}


def natural(pose, w=1.0):
    """Stay close to the HexSniper authoring twists (they read as natural on this skin) + hard-ish ranges."""
    r = []
    for s in "LR":
        for b in ARM_BONES[s]:
            sw, tw = delta_st(pose, b); sw0, tw0 = REF_ST[b]
            dead = {"Shoulder": 6, "UpperArm": 30, "LowerArm": 14, "Hand": 8}[b[:-2]]
            r.append(max(0.0, abs(tw - tw0) - dead) * 0.6 * w)
            if b.startswith("Shoulder"): r.append(max(0.0, sw - 32.0) * 1.0 * w)
            if b.startswith("Hand"): r.append(max(0.0, sw - 45.0) * 0.6 * w)
            if b.startswith("LowerArm"): r.append(max(0.0, 12.0 - sw) * 0.5 * w)        # never hyper-straight
    return np.array(r)


SPINE_MAX = dict(yaw=12.0, lean=8.0)


def spine_pose(base, yaw, lean):
    p = dict(base)
    T_, R_, S_ = base["Spine_1"]
    q = (Rot.from_quat(R_) * Rot.from_euler("YX", [yaw, lean], degrees=True)).as_quat()
    p["Spine_1"] = (T_, q, S_)
    return p


def solve_straight(p0=(-0.04, 0.50, 0.19), theta0=-20.0, slide0=0.25, base=None, x0=None, pump=0.0, lid=0.0, trig=0.0,
                   fix_p=None, gun_off=None, lh=None, w_nat=1.0, verbose=True, max_nfev=300, spine0=(0.0, 0.0), free_spine=True,
                   w_eye=250.0, w_dent=600.0):
    base0 = dict(base if base is not None else HEX_AIM)
    for n in ("Weapon_R",): base0[n] = REST[n]
    SP0 = ch.world(base0)["Spine_1"]
    nR, nL = T.ikR.nx, T.ikL.nx
    nS = 2 if free_spine else 0
    go = gun_off or {}

    def unpack(x):
        k = 0
        if fix_p is None: p = x[0:3]; k = 3
        else: p = np.asarray(fix_p)
        th, sl = (x[k], x[k + 1]) if lh is None else (0.0, 0.0)
        k += 2 if lh is None else 0
        xR, xL = x[k:k + nR], x[k + nR:k + nR + nL]
        sp = x[k + nR + nL:k + nR + nL + nS] if free_spine else np.asarray(spine0)
        return p, th, sl, xR, xL, sp

    def build(x):
        p, th, sl, xR, xL, sp = unpack(x)
        base = spine_pose(base0, sp[0], sp[1])
        Wb = ch.world(base)
        WpR, WpL = Wb[T.ikR.parent_of_root], Wb[T.ikL.parent_of_root]
        G = gun_matrix(p, go.get("yaw", 0.0), go.get("pitch", 0.0), go.get("roll", 0.0))
        tR = A.normalized(G @ np.linalg.inv(T.S_ROOT) @ np.linalg.inv(T.M_TP))
        wR, wL = {}, {}
        ER, locR = T.ikR.fk(base, WpR, xR, base, wR)
        Wn = wd.world_nodes(G, pump, lid, trig)
        tL = A.normalized(Wn["Pump"] @ tp_offhand(th, sl)) if lh is None else A.normalized(lh(Wn))
        EL, locL = T.ikL.fk(base, WpL, xL, base, wL)
        pose = dict(base); pose.update(locR); pose.update(locL)
        Md = np.linalg.inv(Wb["Spine_1"] @ np.linalg.inv(SP0))          # maps the current body back to the base body
        return p, th, sl, G, tR, tL, ER, EL, pose, Md, sp, wR, wL

    def res(x):
        p, th, sl, G, tR, tL, ER, EL, pose, Md, sp, wR, wL = build(x)
        r = [(ER[:3, 3] - tR[:3, 3]) * 1000, Rot.from_matrix(tR[:3, :3].T @ A.normalized(ER)[:3, :3]).as_rotvec() * 57.3 * 0.8,
             (EL[:3, 3] - tL[:3, 3]) * 1000, Rot.from_matrix(tL[:3, :3].T @ A.normalized(EL)[:3, :3]).as_rotvec() * 57.3 * 0.6]
        r.append(natural(pose, w_nat))
        if w_dent > 0:                      # no fold / dent on the belly and flanks (linear-blend skinning artefacts)
            d, _ = belly.dent(pose, REF_BODY)
            r.append(np.maximum(0.0, d - DENT_TOL) * w_dent)
        # weapon out of the body (5 mm margin); right hand in front of the chest
        if fix_p is None or free_spine:            # the weapon only moves when the gun / spine are free
            P = (G[:3, :3] @ WPTS.T).T + G[:3, 3]
            P = (Md[:3, :3] @ P.T).T + Md[:3, 3]
            pen = [max(0.0, zfront(q[0], q[1]) + 0.005 - q[2]) * 800 for q in P]
            r.append(pen)
        wr_ = Md[:3, :3] @ ER[:3, 3] + Md[:3, 3]; r.append([max(0.0, zfront(wr_[0], wr_[1]) + 0.035 - wr_[2]) * 800])
        # elbows below the wrists (no raised 'chicken wing' elbow)
        for sd, ww in (("R", wR), ("L", wL)):
            r.append([max(0.0, ww[f"LowerArm_{sd}"][1, 3] - ww[f"Hand_{sd}"][1, 3] + 0.01) * 400])
        if free_spine:
            r.append([max(0.0, abs(sp[0]) - SPINE_MAX["yaw"]) * 3, max(0.0, abs(sp[1]) - SPINE_MAX["lean"]) * 3, sp[0] * 0.05, sp[1] * 0.08])
        if fix_p is None:
            top = (G @ np.r_[0.0, wd.LID_HINGE[1], 0.0, 1.0])[1]
            r.append([max(0.0, top - (EYE_BOTTOM + 0.005)) * w_eye, (p[0] + 0.03) * 20, p[2] * 8])
        if lh is None:
            r.append([max(0.0, sl - 0.80) * 200, max(0.0, -0.40 - sl) * 200, th * 0.01])
        return np.concatenate([np.atleast_1d(np.asarray(a, float)).ravel() for a in r])

    if x0 is None:
        x0 = np.zeros((3 if fix_p is None else 0) + (2 if lh is None else 0) + nR + nL + nS)
        k = 0
        if fix_p is None: x0[:3] = p0; k = 3
        if lh is None: x0[k:k + 2] = [theta0, slide0]
        if free_spine: x0[-2:] = spine0
    sol = least_squares(res, x0, method="trf", max_nfev=max_nfev, diff_step=1e-4)
    p, th, sl, G, tR, tL, ER, EL, pose, Md, sp, wR, wL = build(sol.x)
    eR = np.linalg.norm(ER[:3, 3] - tR[:3, 3]); eL = np.linalg.norm(EL[:3, 3] - tL[:3, 3])
    rL = np.degrees(Rot.from_matrix(tL[:3, :3].T @ A.normalized(EL)[:3, :3]).magnitude())
    info = dict(p=p, theta=th, slide=sl, G=G, eR=eR, eL=eL, rL=rL, cost=sol.cost, x=sol.x, spine=sp)
    if verbose:
        P = (G[:3, :3] @ WPTS.T).T + G[:3, 3]; P = (Md[:3, :3] @ P.T).T + Md[:3, 3]
        pen = max(max(0.0, zfront(q[0], q[1]) - q[2]) for q in P)
        top = (G @ np.r_[0.0, wd.LID_HINGE[1], 0.0, 1.0])[1]
        st = " | ".join(f"{b}: {delta_st(pose, b)[0]:.0f}/{delta_st(pose, b)[1]:.0f}" for s in "LR" for b in ARM_BONES[s])
        dd, vr = belly.dent(pose, REF_BODY)
        print(f"dent R {dd[vr[:, 0] < 0].max()*1000:.1f}mm L {dd[vr[:, 0] > 0].max()*1000:.1f}mm | grip p {np.round(p, 3)} theta {th:.0f} slide {sl:.2f} | R {eR*1000:.2f}mm L {eL*1000:.2f}mm {rL:.1f}deg | "
              f"body pen {pen*1000:.1f}mm | tank top {top:.3f} | spine yaw {sp[0]:.1f} lean {sp[1]:.1f} | cost {sol.cost:.1f}\n   {st}", flush=True)
    return pose, info


if __name__ == "__main__":
    import pickle
    best = None
    for p0 in [(-0.02, 0.49, 0.18), (-0.04, 0.47, 0.20), (0.0, 0.52, 0.17)]:
        for th0 in [-30.0, 0.0]:
            pose, info = solve_straight(p0, th0, slide0=0.7)
            if best is None or info["cost"] < best[1]["cost"]: best = (pose, info)
    pickle.dump(best, open("tp_straight_hold.pkl", "wb"))
    print("BEST", np.round(best[1]["p"], 3), best[1]["theta"], best[1]["slide"], best[1]["cost"])
