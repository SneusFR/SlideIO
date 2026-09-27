"""Fit the LEFT hand (Hand_L frame + 4 finger curls) around the VERTICAL foregrip of the Paintball Rifle.

Works on the real skinned FP_Arms mesh (hand + finger vertices re-skinned for a candidate hand frame), in the
foregrip METRIC frame (weapon axes; origin on the foregrip axis at the top of the grip, y up). Minimises:
penetration into the foregrip / its mount / the barrel / the receiver, gaps between fingers + palm and the grip
(wrap), a natural forearm direction (from below-behind-left: the FP camera side) and a thumb pointing up the grip.
Output: OffhandSocket frame (Weapon_L in weapon ROOT units) + finger curls  ->  fore_grip.json
"""
import json
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
from rig import Rig, trs, qmul, qnorm, accessor
import weapon_def as wd

arms = Rig("Potato_FP_CommonArms.glb")
md = arms.mesh_data(0)[0]
skin = arms.js["skins"][0]
JN = [arms.names[j] for j in skin["joints"]]
IBM = accessor(arms.js, arms.bin, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
HAND = ["Hand_L", "Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FING = HAND[1:]
jidx = {n: JN.index(n) for n in HAND}
REST = arms.rest_pose()
dom = np.array([JN[md["joints"][i][np.argmax(md["weights"][i])]] for i in range(len(md["pos"]))])
VSEL = np.nonzero(np.isin(dom, HAND))[0]
P0 = np.c_[md["pos"][VSEL], np.ones(len(VSEL))]
Wsel = np.zeros((len(VSEL), 5))
for k, n in enumerate(HAND):
    Wsel[:, k] = np.sum(md["weights"][VSEL] * (md["joints"][VSEL] == jidx[n]), axis=1)
Wsel /= Wsel.sum(1, keepdims=True)
DOMSEL = dom[VSEL]
WL_LOCAL = trs(*REST["Weapon_L"])

U = wd.ROOT_SCALE * 0.4                          # metres per weapon unit (FP)
HX, HZ = wd.FOREGRIP_HALF[0] * U, wd.FOREGRIP_HALF[1] * U                     # foregrip half depth / half width (bevel ~0.034 u)
BEV = 0.036 * wd.SCALE * U
LEN = (wd.FOREGRIP_Y0 - wd.FOREGRIP_Y1) * U      # grip length (below the mount)
ORIGIN = np.array([wd.FOREGRIP_X, wd.FOREGRIP_Y0, 0.0])   # weapon units: top of the grip on its axis
# mount block (teal) above the grip, barrel above that, receiver lower block behind (weapon units -> metric frame)
def _m(xw, yw): return np.array([(xw - ORIGIN[0]) * U, (yw - ORIGIN[1]) * U])
MOUNT = (_m(wd.X(382), wd.Y(337)), _m(wd.X(470), wd.Y(298)), 0.20 * wd.SCALE * U)   # (x0,y0), (x1,y1), half z
BARREL_Y = (wd.YA - ORIGIN[1]) * U; BARREL_R = wd.BARREL_R * U
RECV_X0 = (wd.X(468) - ORIGIN[0]) * U; RECV_Y = (wd.Y(347) - ORIGIN[1]) * U; RECV_Z = 0.25 * wd.SCALE * U


def curl_axes():
    """HexSniper LEFT-hand grip curl axes (the popcorn pump fit used the same): s=1 HexSniper curl, 2 = twice."""
    import fp_common as F
    h = F.hold_ref()
    return {n: (Rot.from_quat(REST[n][1]).inv() * Rot.from_quat(h[n][1])).as_rotvec() for n in FING}


CA = curl_axes()


def finger_local(name, s):
    rq = REST[name][1]
    q = qnorm(qmul(rq, Rot.from_rotvec(CA[name] * s).as_quat()))
    return trs(REST[name][0], q, REST[name][2])


def hand_vertices(H, curls):
    mats = [H @ IBM[jidx["Hand_L"]]]
    for n in FING:
        mats.append(H @ finger_local(n, curls[n]) @ IBM[jidx[n]])
    out = np.zeros((len(P0), 3))
    for k, M in enumerate(mats):
        out += Wsel[:, k:k + 1] * (P0 @ M.T)[:, :3]
    return out


def sd_grip(v):
    """Signed distance to the rounded-box foregrip (negative inside); the grip spans y in [-LEN, 0]."""
    c = np.array([0.0, -LEN / 2, 0.0]); h = np.array([HX, LEN / 2, HZ]) - BEV
    q = np.abs(v - c) - h
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(np.max(q, axis=1), 0) - BEV


def sd_box(v, x0, x1, y0, y1, hz):
    c = np.array([(x0 + x1) / 2, (y0 + y1) / 2, 0.0]); h = np.array([(x1 - x0) / 2, (y1 - y0) / 2, hz])
    q = np.abs(v - c) - h
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(np.max(q, axis=1), 0)


def penetration(v, margin=0.0005):
    p = [margin - sd_grip(v)]
    (a, b, hz) = MOUNT
    p.append(margin - sd_box(v, a[0], b[0], a[1], b[1], hz))
    p.append(BARREL_R + margin - np.hypot(v[:, 1] - BARREL_Y, v[:, 2]) * (v[:, 0] < RECV_X0 + 0.02) - 1e3 * (v[:, 0] >= RECV_X0 + 0.02))
    p.append(margin - sd_box(v, RECV_X0, RECV_X0 + 0.08, RECV_Y, BARREL_Y + 0.03, RECV_Z))
    return np.max(np.stack(p, 1), axis=1)


def frame_from_params(phi, psi, yc, gap, tilt=0.0, gp=None):
    """phi: palm contact angle around the vertical grip axis (0 = palm on the gun's LEFT side (+Z), + toward the
    back). psi: rotation about the palm normal (0 = thumb straight up the grip, + = thumb leaning back),
    tilt: rotation about the finger direction. yc: height of the hand centre on the grip (m, negative = down),
    gap: offset of the hand centre from the axis along the contact radial (negative = deeper)."""
    radial = np.array([np.sin(phi), 0.0, np.cos(phi)])
    X = -radial
    Z = np.array([0.0, 1.0, 0.0])
    Y = np.cross(Z, X)
    R = np.stack([X, Y, Z], axis=1)
    R = R @ Rot.from_rotvec(np.array([1.0, 0, 0]) * psi).as_matrix() @ Rot.from_rotvec(np.array([0, 1.0, 0]) * tilt).as_matrix()
    H = np.eye(4); H[:3, :3] = R
    centre = radial * gap + np.array([0.0, yc, 0.0])
    anchor = WL_LOCAL[:3, 3] if gp is None else np.asarray(gp)      # hand-local point that sits on the grip axis
    H[:3, 3] = centre - R @ anchor
    return H


def fit(H0, curls0, want_wrist, max_nfev=500, w_wrist=40.0, verbose=True):
    r0 = Rot.from_matrix(H0[:3, :3]); t0 = H0[:3, 3].copy()

    def unpack(x):
        H = np.eye(4); H[:3, :3] = (r0 * Rot.from_rotvec(x[:3])).as_matrix(); H[:3, 3] = t0 + x[3:6]
        return H, {n: x[6 + k] for k, n in enumerate(FING)}

    def res(x):
        H, cu = unpack(x)
        v = hand_vertices(H, cu)
        r = [np.maximum(0, penetration(v)) * 2000]
        d = sd_grip(v)
        for n in ["Index_L_1", "Middle_L_1", "Ring_L_1"]:
            m = DOMSEL == n
            r.append([max(0.0, d[m].min() - 0.0015) * 800])
        m = DOMSEL == "Hand_L"; r.append([max(0.0, d[m].min() - 0.003) * 600])
        m = DOMSEL == "Thumb_L_1"; r.append([max(0.0, d[m].min() - 0.004) * 300])
        # fingers centred on the grip height
        fm = np.isin(DOMSEL, ["Index_L_1", "Middle_L_1", "Ring_L_1"])
        r.append([(v[fm, 1].mean() + LEN * 0.5) * 120])
        # no part of the hand below the grip bottom by more than 1 cm
        r.append(np.maximum(0, -(v[:, 1] + LEN + 0.025)) * 300)
        r.append([(1 - (-H[:3, 1]) @ want_wrist) * w_wrist])
        r.append([(1 - H[:3, 2] @ np.array([0.0, 1.0, 0.0])) * 60.0])          # thumb up the grip (natural left fist)
        r.append([(x[6 + k] - 1.6) * 0.5 for k in range(4)])
        return np.concatenate([np.atleast_1d(np.asarray(a, float)).ravel() for a in r])

    x0 = np.zeros(10); x0[6:] = [curls0[n] for n in FING]
    lb = np.r_[[-1.5] * 3, [-0.06] * 3, [0.0, 0.0, 0.0, -0.8]]
    ub = np.r_[[1.5] * 3, [0.06] * 3, [2.4, 2.4, 2.4, 2.0]]
    sol = least_squares(res, x0, bounds=(lb, ub), max_nfev=max_nfev, diff_step=1e-3)
    H, cu = unpack(sol.x)
    if verbose:
        v = hand_vertices(H, cu); d = sd_grip(v)
        print("cost", round(sol.cost, 3), "max pen mm", round(1000 * max(0, penetration(v, 0).max()), 2))
        for n in HAND:
            m = DOMSEL == n
            print(f"   {n:10s} curl {cu.get(n, 0):.2f} gap {1000 * d[m].min():.1f} mm")
        print("   wrist", np.round(-H[:3, 1], 2))
    return H, cu, sol.cost


def score(H, cu, want_wrist):
    v = hand_vertices(H, cu)
    pen = np.maximum(0, penetration(v, 0))
    d = sd_grip(v)
    c = 4e6 * (pen ** 2).sum()
    for n in ["Index_L_1", "Middle_L_1", "Ring_L_1", "Hand_L"]:
        m = DOMSEL == n
        c += 40 * max(0.0, d[m].min() - 0.002) * 1000
    c += 25 * (1 - (-H[:3, 1]) @ want_wrist)
    c += 40 * (1 - H[:3, 2] @ np.array([0.0, 1.0, 0.0]))
    return c


def to_socket(H):
    """Hand_L frame (metric grip frame) -> Weapon_L frame in weapon ROOT units."""
    WL = H @ WL_LOCAL
    F = np.eye(4); F[:3, :3] = WL[:3, :3]; F[:3, 3] = ORIGIN + WL[:3, 3] / U
    return F


if __name__ == "__main__":
    import sys
    want = np.array([0.55, -0.62, 0.56]); want /= np.linalg.norm(want)      # forearm toward back / down / left
    best = []
    for phi in np.radians([-50, -30, -10, 10, 30, 50]):
        for psi in np.radians([-40, -20, 0, 20, 40]):
            for yc in [-0.35 * LEN, -0.5 * LEN, -0.65 * LEN]:
                for gap in [-0.004, 0.0, 0.006]:
                    H = frame_from_params(phi, psi, yc, gap)
                    for cs in (1.2, 1.7):
                        cu = {n: cs for n in FING}; cu["Thumb_L_1"] = 0.8
                        best.append((score(H, cu, want), phi, psi, yc, gap, cu))
    best.sort(key=lambda r: r[0])
    out = []
    for sc, phi, psi, yc, gap, cu0 in best[:8]:
        H0 = frame_from_params(phi, psi, yc, gap)
        H, cu, cost = fit(H0, cu0, want, verbose=False)
        v = hand_vertices(H, cu)
        out.append((cost, H, cu, np.degrees(phi), np.degrees(psi), 1000 * max(0, penetration(v, 0).max())))
        print(f"start phi {np.degrees(phi):4.0f} psi {np.degrees(psi):4.0f} -> cost {cost:.2f} pen {out[-1][-1]:.2f}mm wrist {np.round(-H[:3,1],2)}", flush=True)
    out.sort(key=lambda r: r[0])
    cost, H, cu, phi, psi, pen = out[0]
    fit(H, cu, want, max_nfev=50)
    F = to_socket(H)
    json.dump({"offhand_local": F.tolist(), "curls": cu, "hand_metric": H.tolist()}, open("fore_grip.json", "w"), indent=1)
    print("saved fore_grip.json", np.round(F[:3, 3], 3))
