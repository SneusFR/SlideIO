"""Fit the LEFT hand (Hand_L frame + 4 finger curls) around the pump cylinder.

Works on the real skinned FP_Arms mesh: vertices driven by Hand_L / fingers are re-skinned for a
candidate hand frame expressed in the pump's METRIC frame (axis = +X, centre at the origin), then
we minimise: penetration into pump / barrel / magazine rod, gaps between the palm-side surfaces
and the pump (wrap), and deviation from a natural wrist direction (forearm from below-left, the
HexSniper hold). Output: OffhandSocket frame (Weapon_L, pump-local weapon units) + finger curls.
"""
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
from rig import Rig, trs, qmul, qnorm, accessor
import weapon_def as wd
import weapon_parts as wp

arms = Rig("Potato_FP_CommonArms.glb")
md = arms.mesh_data(0)[0]
skin = arms.js["skins"][0]
JN = [arms.names[j] for j in skin["joints"]]
IBM = accessor(arms.js, arms.bin, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
HAND = ["Hand_L", "Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FING = HAND[1:]
jidx = {n: JN.index(n) for n in HAND}
REST = arms.rest_pose()

# vertices dominated by the hand / fingers (weights renormalised over those 5 joints)
dom = np.array([JN[md["joints"][i][np.argmax(md["weights"][i])]] for i in range(len(md["pos"]))])
VSEL = np.nonzero(np.isin(dom, HAND))[0]
P0 = np.c_[md["pos"][VSEL], np.ones(len(VSEL))]
Wsel = np.zeros((len(VSEL), 5))
for k, n in enumerate(HAND):
    Wsel[:, k] = np.sum(md["weights"][VSEL] * (md["joints"][VSEL] == jidx[n]), axis=1)
Wsel /= Wsel.sum(1, keepdims=True)
DOMSEL = dom[VSEL]

UNIT = wd.ROOT_SCALE * 0.4          # metres per weapon unit (FP)
R_PUMP = (wp.PUMP_R + 0.012) * UNIT   # ribs average
R_BARREL = wp.BARREL_R * UNIT
Y_BARREL = -wp.PUMP_CY * UNIT         # barrel axis above the pump axis
R_ROD = 0.10 * UNIT
PUMP_HALF = 0.5 * (wp.PUMP_X0 - wp.PUMP_X1) * UNIT
WL_LOCAL = trs(*REST["Weapon_L"])       # Weapon_L relative to Hand_L
# receiver lower block (weapon-local px 712..835 / py 660..772, z ±0.31) in the pump metric frame
BLOCK_X = (wp.X(712) - wd.PUMP_ORIGIN[0]) * UNIT
BLOCK_Y0 = (wp.Y(772) - wp.PUMP_CY) * UNIT
BLOCK_Y1 = (wp.Y(660) - wp.PUMP_CY) * UNIT
BLOCK_Z = 0.31 * UNIT
TRAVEL = wd.PUMP_TRAVEL * UNIT


def curl_q(name, s):
    rq = REST[name][1]
    import fp_common as F
    hq = F.hold_ref()[name][1]
    d = (Rot.from_quat(rq).inv() * Rot.from_quat(hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


_HEX = None


def hex_curl_axes():
    global _HEX
    if _HEX is None:
        import fp_common as F
        h = F.hold_ref()
        _HEX = {n: (Rot.from_quat(REST[n][1]).inv() * Rot.from_quat(h[n][1])).as_rotvec() for n in FING}
    return _HEX


def finger_local(name, s):
    rq = REST[name][1]
    q = qnorm(qmul(rq, Rot.from_rotvec(hex_curl_axes()[name] * s).as_quat()))
    return trs(REST[name][0], q, REST[name][2])


def hand_vertices(H, curls):
    """H: Hand_L 4x4 (metric pump frame). curls: dict finger -> s."""
    mats = [H @ IBM[jidx["Hand_L"]]]
    for n in FING:
        mats.append(H @ finger_local(n, curls[n]) @ IBM[jidx[n]])
    out = np.zeros((len(P0), 3))
    for k, M in enumerate(mats):
        out += Wsel[:, k:k + 1] * (P0 @ M.T)[:, :3]
    return out


def cyl_dist(v, cy=0.0, cz=0.0):
    return np.hypot(v[:, 1] - cy, v[:, 2] - cz)


def fit(H0, curls0, wrist_dir, iters=4000, verbose=True):
    """H0: initial Hand_L frame; wrist_dir: preferred forearm direction (unit, pump metric frame)."""
    r0 = Rot.from_matrix(H0[:3, :3])
    t0 = H0[:3, 3].copy()
    names = FING

    def unpack(x):
        R = (r0 * Rot.from_rotvec(x[:3])).as_matrix()
        H = np.eye(4); H[:3, :3] = R; H[:3, 3] = t0 + x[3:6]
        curls = {n: x[6 + k] for k, n in enumerate(names)}
        return H, curls

    def res(x):
        H, curls = unpack(x)
        v = hand_vertices(H, curls)
        along = np.abs(v[:, 0]) < PUMP_HALF + 0.004
        d = cyl_dist(v)
        pen_p = np.where(along, np.maximum(0, R_PUMP + 0.0008 - d), 0) * 3000
        pen_b = np.maximum(0, R_BARREL + 0.0008 - cyl_dist(v, Y_BARREL)) * 3000
        # wrap: finger + palm vertices within 1.2 cm of the pump should lie ON it (not floating)
        near = along & (d < R_PUMP + 0.012) & np.isin(DOMSEL, HAND)
        gap = np.where(near, np.maximum(0, d - R_PUMP - 0.0015), 0) * 180
        # every finger must actually touch: its closest vertex to the surface
        touch = []
        for n in FING:
            m = (DOMSEL == n) & along
            dd = (d[m] - R_PUMP).min() if m.any() else 0.02
            touch.append(max(0.0, dd - 0.001) * 900)
        # natural wrist: forearm direction (−Y_hand) close to the preferred one
        wy = -H[:3, 1]
        wrist = (1 - wy @ wrist_dir) * 60
        # palm under / left of the pump axis (support from below)
        palm = (H @ WL_LOCAL)[:3, 3]
        below = max(0.0, palm[1] + 0.004) * 400
        curl_reg = [(x[6 + k] - 1.0) * 0.8 for k in range(4)]
        return np.concatenate([pen_p, pen_b, gap, touch, [wrist, below], curl_reg, x[3:6] * 20])

    x0 = np.zeros(10); x0[6:] = [curls0[n] for n in names]
    lb = np.r_[[-1.2] * 3, [-0.05] * 3, [0.0, 0.0, 0.0, -0.3]]
    ub = np.r_[[1.2] * 3, [0.05] * 3, [2.2, 2.2, 2.2, 2.0]]
    sol = least_squares(res, x0, bounds=(lb, ub), max_nfev=iters, x_scale="jac")
    H, curls = unpack(sol.x)
    v = hand_vertices(H, curls)
    along = np.abs(v[:, 0]) < PUMP_HALF + 0.004
    d = cyl_dist(v)
    if verbose:
        print("cost", sol.cost, "max pump penetration mm", 1000 * max(0, (R_PUMP - d[along]).max()),
              "barrel pen mm", 1000 * max(0, (R_BARREL - cyl_dist(v, Y_BARREL)).max()))
        for n in FING:
            m = (DOMSEL == n) & along
            print(f"  {n}: curl {curls[n]:.2f}  closest to surface {1000 * (d[m] - R_PUMP).min():.1f} mm")
        print("  wrist dir", -H[:3, 1], "pref", wrist_dir)
    return H, curls


# ---------------------------------------------------------------- grid search in cylindrical terms
def frame_from_params(theta, psi, xc, gap, tilt=0.0):
    """theta: palm contact angle around the pump (0 = under, + toward the gun's left/camera side).
    psi: hand rotation about the palm normal (fingers angled forward/back across the pump).
    tilt: rotation about the pump-tangent (knuckles up/down). Returns the Hand_L frame (metric)."""
    c, s = np.cos(theta), np.sin(theta)
    radial = np.array([0.0, -c, s])                   # from axis to the contact point
    X = -radial                                       # palm normal toward the axis
    Z = np.array([-1.0, 0.0, 0.0])                    # thumb forward
    Y = np.cross(Z, X)
    R = np.stack([X, Y, Z], axis=1)
    R = R @ Rot.from_rotvec(np.array([1.0, 0, 0]) * psi).as_matrix() @ Rot.from_rotvec(np.array([0, 0, 1.0]) * tilt).as_matrix()
    # Weapon_L is the centre of the closed hand (the held object's axis): put it on the pump axis,
    # shifted by `gap` along the radial direction (negative = deeper into the palm)
    H = np.eye(4); H[:3, :3] = R
    wl = WL_LOCAL[:3, 3]
    centre = radial * gap + np.array([xc, 0, 0])
    H[:3, 3] = centre - R @ wl
    return H


def score(H, curls, want_wrist, detail=False):
    v = hand_vertices(H, curls)
    along = np.abs(v[:, 0]) < PUMP_HALF + 0.004
    d = cyl_dist(v)
    pen = np.where(along, np.maximum(0, R_PUMP - d), 0)
    penb = np.maximum(0, R_BARREL - cyl_dist(v, Y_BARREL))
    pen_rod = np.where((v[:, 0] > PUMP_HALF) | (v[:, 0] < -PUMP_HALF), np.maximum(0, R_ROD - d), 0)
    cost = 400 * (pen ** 2).sum() * 1e4 + 400 * (penb ** 2).sum() * 1e4 + 100 * (pen_rod ** 2).sum() * 1e4
    touch = {}
    for n in FING + ["Hand_L"]:
        m = (DOMSEL == n) & along
        dd = (d[m] - R_PUMP).min() if m.any() else 0.03
        touch[n] = dd
        if n != "Thumb_L_1":
            cost += 40 * max(0.0, dd - 0.0015) * 1000
    # thumb on the camera side, not over the top
    tm = DOMSEL == "Thumb_L_1"
    over = np.maximum(0, v[tm, 1] - 0.55 * R_PUMP)
    cost += 30 * over.max() * 1000 if tm.any() else 0
    # far-side fingers must not claw over the top toward the camera
    fm = np.isin(DOMSEL, ["Index_L_1", "Middle_L_1", "Ring_L_1"])
    claw = np.maximum(0, v[fm, 1] - (R_PUMP + 0.002)) * (v[fm, 2] > -0.3 * R_PUMP)
    cost += 25 * claw.max() * 1000
    wy = -H[:3, 1]
    cost += 25 * (1 - wy @ want_wrist)
    if detail:
        return cost, dict(pen_mm=1000 * pen.max(), barrel_mm=1000 * penb.max(), touch_mm={k: round(1000 * x, 1) for k, x in touch.items()},
                          thumb_over_mm=1000 * (over.max() if tm.any() else 0), claw_mm=1000 * claw.max(), wrist=wy)
    return cost


def best_curls(H, want_wrist, grid=np.linspace(-0.2, 2.0, 12)):
    curls = {n: 1.0 for n in FING}
    for _ in range(2):
        for n in FING:
            best = None
            for s in (grid if n != "Thumb_L_1" else np.linspace(-0.6, 1.4, 11)):
                c2 = dict(curls); c2[n] = s
                sc = score(H, c2, want_wrist)
                if best is None or sc < best[0]:
                    best = (sc, s)
            curls[n] = best[1]
    return curls


def search(want_wrist, verbose=True):
    results = []
    for theta in np.radians([-35, -20, -5, 10, 25, 40, 55]):
        for psi in np.radians([-35, -15, 0, 15, 35]):
            for xc in [-0.02, -0.005, 0.01, 0.025]:
                for gap in [-0.006, 0.0, 0.006, 0.012]:
                    H = frame_from_params(theta, psi, xc, gap)
                    cu = best_curls(H, want_wrist, grid=np.linspace(0.0, 2.0, 6))
                    results.append((score(H, cu, want_wrist), theta, psi, xc, gap, cu))
    results.sort(key=lambda r: r[0])
    if verbose:
        for r in results[:6]:
            print(f"cost {r[0]:8.2f} theta {np.degrees(r[1]):5.0f} psi {np.degrees(r[2]):5.0f} xc {r[3]:+.3f} gap {r[4]:+.3f} curls " +
                  " ".join(f"{k[:1]}{v:.2f}" for k, v in r[5].items()))
    return results


def penetration(v, margin=0.001):
    along = np.abs(v[:, 0]) < PUMP_HALF + 0.004
    d = cyl_dist(v)
    p1 = np.where(along, R_PUMP - d, -1)
    p2 = R_BARREL - cyl_dist(v, Y_BARREL)
    p3 = np.where(~along, R_ROD - d, -1)
    return np.maximum(np.maximum(p1, p2), p3)


def close_fingers(H, start=None, step=0.05, tol=0.001):
    """Close each finger until it touches (like a real grip): largest curl with ≤ tol penetration."""
    curls = {n: (-0.6 if n == "Thumb_L_1" else 0.0) for n in FING} if start is None else dict(start)
    for n in FING:
        m = DOMSEL == n
        s = curls[n]
        best = s
        while s <= 2.2:
            c2 = dict(curls); c2[n] = s
            v = hand_vertices(H, c2)
            if penetration(v[m]).max() > tol:
                break
            best = s
            s += step
        curls[n] = best
    return curls


def palm_gap(H, curls):
    v = hand_vertices(H, curls)
    m = DOMSEL == "Hand_L"
    along = np.abs(v[:, 0]) < PUMP_HALF
    d = cyl_dist(v)
    sel = m & along
    return (d[sel] - R_PUMP).min() if sel.any() else 0.05, penetration(v[m]).max()


def fit2(H0, curls0, want_wrist, max_nfev=600, verbose=True, w_wrist=40.0):
    """Robust local fit (starts from a penetration-free pose)."""
    r0 = Rot.from_matrix(H0[:3, :3]); t0 = H0[:3, 3].copy()

    def unpack(x):
        H = np.eye(4); H[:3, :3] = (r0 * Rot.from_rotvec(x[:3])).as_matrix(); H[:3, 3] = t0 + x[3:6]
        return H, {n: x[6 + k] for k, n in enumerate(FING)}

    def res(x):
        H, cu = unpack(x)
        v = hand_vertices(H, cu)
        along = np.abs(v[:, 0]) < PUMP_HALF + 0.004
        d = cyl_dist(v)
        r = []
        r.append(np.where(along, np.maximum(0, R_PUMP + 0.0005 - d), 0) * 2000)
        r.append(np.maximum(0, R_BARREL + 0.0005 - cyl_dist(v, Y_BARREL)) * 2000)
        r.append(np.where(~along, np.maximum(0, R_ROD + 0.0005 - d), 0) * 2000)
        for n in ["Index_L_1", "Middle_L_1", "Ring_L_1"]:
            m = (DOMSEL == n) & along
            g = (d[m] - R_PUMP).min() if m.any() else 0.03
            r.append([max(0.0, g - 0.0015) * 800])
        m = (DOMSEL == "Hand_L") & along
        g = (d[m] - R_PUMP).min() if m.any() else 0.03
        r.append([max(0.0, g - 0.003) * 600])
        tm = DOMSEL == "Thumb_L_1"
        g = (d[tm & along] - R_PUMP).min() if (tm & along).any() else 0.03
        r.append([max(0.0, g - 0.004) * 400])
        r.append(np.maximum(0, v[tm, 1] - 0.45 * R_PUMP) * 300)                 # thumb not over the top
        fm = np.isin(DOMSEL, ["Index_L_1", "Middle_L_1", "Ring_L_1"])
        r.append(np.maximum(0, v[fm, 1] - 0.2 * R_PUMP) * np.maximum(0, v[fm, 2]) * 3e4)  # no claw from the near side
        # fingers centred on the pump (their spread must fit between the pump front and the receiver)
        r.append([v[fm, 0].mean() * 300])
        # receiver lower block, reached when the pump is racked back (travel) — keep clear
        bx0 = BLOCK_X - TRAVEL
        inside = (v[:, 0] > bx0) & (np.abs(v[:, 2]) < BLOCK_Z) & (v[:, 1] > BLOCK_Y0) & (v[:, 1] < BLOCK_Y1)
        r.append(np.where(inside, np.minimum.reduce([v[:, 0] - bx0, BLOCK_Z - np.abs(v[:, 2]), v[:, 1] - BLOCK_Y0]), 0) * 2000)
        r.append([(1 - (-H[:3, 1]) @ want_wrist) * w_wrist])
        r.append([(x[6 + k] - 1.2) * 1.0 for k in range(4)])
        return np.concatenate([np.atleast_1d(np.asarray(a, float)).ravel() for a in r])

    x0 = np.zeros(10); x0[6:] = [curls0[n] for n in FING]
    lb = np.r_[[-1.5] * 3, [-0.06] * 3, [0.0, 0.0, 0.0, -0.8]]
    ub = np.r_[[1.5] * 3, [0.06] * 3, [2.3, 2.3, 2.3, 2.0]]
    sol = least_squares(res, x0, bounds=(lb, ub), max_nfev=max_nfev, diff_step=1e-3)
    H, cu = unpack(sol.x)
    if verbose:
        v = hand_vertices(H, cu); d = cyl_dist(v); along = np.abs(v[:, 0]) < PUMP_HALF
        print("cost", round(sol.cost, 3), "pen pump mm", round(1000 * max(0, (R_PUMP - d[along]).max()), 2),
              "barrel mm", round(1000 * max(0, (R_BARREL - cyl_dist(v, Y_BARREL)).max()), 2))
        for n in FING + ["Hand_L"]:
            m = (DOMSEL == n) & along
            print(f"   {n:10s} curl {cu.get(n, 0):.2f} gap {1000 * (d[m] - R_PUMP).min() if m.any() else 99:.1f} mm  maxY {1000 * v[DOMSEL == n, 1].max():.1f}")
        print("   wrist", np.round(-H[:3, 1], 2), "WL x mm", round(1000 * (H @ WL_LOCAL)[0, 3], 1))
    return H, cu
