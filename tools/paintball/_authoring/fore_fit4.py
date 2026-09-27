"""FP foregrip hold v2 — cartoon fist CLOSED AROUND the grip.

The Potato hand is a chunky mitt (single-bone fingers ~2 cm thick, 6 cm long) and the grip is 4.3 x 3.8 cm:
a physically exact wrap (fore_fit2 / fore_fit3) leaves the fist BESIDE the grip as seen from the game camera.
Here the grip goes THROUGH the closed fist (like a stylised game hand): inside the fist the overlap is invisible,
so the constraints are visual:
  - between the fist's top and bottom, the grip is hidden from the game camera (rays to the camera hit the hand)
    and from the four horizontal sides (it does not poke out of the fist);
  - no contact with the visible parts above (mount, barrel, receiver);
  - a natural closed fist (uniform finger curl), hammer orientation (lateral hand axis along the grip);
  - wrist toward the elbow side of today's FP IK (the arm keeps its direction, checked after with the IK).
Output: fore_grip.json for FP (v1 = fore_grip_v1.json stays for TP and the hopper / charging-handle sockets).
"""
import json, itertools, sys, numpy as np
from scipy.spatial.transform import Rotation as Rot
import fore_fit as F
import fist_views as V

FING = F.FING
TRIS = V.HAND_TRIS
CAM = V.CAM_M
WANT = np.array([0.665, -0.482, 0.571]); WANT /= np.linalg.norm(WANT)            # hand -> elbow (FP IK, HOLD)
WANT_H = np.array([WANT[0], 0.0, WANT[2]]); WANT_H /= np.linalg.norm(WANT_H)
TOP_Y = -0.011                                   # below the mount / receiver
UP = np.array([0.0, 1.0, 0.0])


def samples(ny=16, nt=8):
    """Grip side-surface points (4 faces) — (points, face normal)."""
    ys = np.linspace(-F.LEN + 0.003, TOP_Y, ny)
    P, N = [], []
    for y in ys:
        for t in np.linspace(-1, 1, nt):
            P += [[F.HX, y, t * (F.HZ - 0.003)], [-F.HX, y, t * (F.HZ - 0.003)], [t * (F.HX - 0.003), y, F.HZ], [t * (F.HX - 0.003), y, -F.HZ]]
            N += [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    return np.array(P), np.array(N, float)


GP, GNm = samples()


def ray_hits(v, pts, dirs, far=None):
    """For each point: does the ray p + t*dir (0 < t < far) hit a hand triangle."""
    A = v[TRIS[:, 0]]; B = v[TRIS[:, 1]]; C = v[TRIS[:, 2]]
    e1 = B - A; e2 = C - A
    D = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    Lm = np.full(len(pts), 10.0) if far is None else far
    p = np.cross(D[:, None, :], e2[None])
    det = np.einsum("tk,ptk->pt", e1, p)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = pts[:, None, :] - A[None]
    u = np.einsum("ptk,ptk->pt", s, p) * inv
    q = np.cross(s, e1[None])
    w = np.einsum("pk,ptk->pt", D, q) * inv
    t = np.einsum("tk,ptk->pt", e2, q) * inv
    hit = ok & (u >= 0) & (w >= 0) & (u + w <= 1) & (t > 1e-5) & (t < Lm[:, None])
    return hit.any(axis=1)


def hand_frame(roll, tilt_a, tilt_b, axis_pt, y_g):
    """Hand pose from: the grip axis in hand-local = Z_hand tilted by (tilt_a about X, tilt_b about Y), through
    axis_pt (hand-local); roll = turn of the hand about the grip so the wrist points toward WANT_H (+roll = toward the back)."""
    a_loc = Rot.from_euler("xy", [tilt_a, tilt_b]).apply([0.0, 0.0, 1.0])
    R1 = Rot.align_vectors([UP], [a_loc])[0]                                   # grip axis (local) -> world up
    w = R1.apply([0.0, -1.0, 0.0]); w[1] = 0.0; w /= np.linalg.norm(w)         # wrist dir, horizontal part
    ang_now = np.arctan2(w[0], w[2]); ang_want = np.arctan2(WANT_H[0], WANT_H[2]) + roll
    R = Rot.from_rotvec(UP * (ang_want - ang_now)) * R1
    H = np.eye(4); H[:3, :3] = R.as_matrix()
    H[:3, 3] = np.array([0.0, y_g, 0.0]) - R.apply(axis_pt)
    return H


def evaluate(H, cu, full=False):
    v = F.hand_vertices(H, cu)
    # visible parts only: mount, barrel, receiver (the grip itself may go inside the fist)
    pv = F.penetration(v, 0.0)
    d_grip = F.sd_grip(v)
    pen_vis = np.maximum(0, np.where(d_grip < -0.0 , -1e3, pv))           # placeholder, replaced below
    (a, b, hz) = F.MOUNT
    p_m = -F.sd_box(v, a[0], b[0], a[1], b[1], hz)
    p_b = F.BARREL_R - np.hypot(v[:, 1] - F.BARREL_Y, v[:, 2]) * (v[:, 0] < F.RECV_X0 + 0.02) - 1e3 * (v[:, 0] >= F.RECV_X0 + 0.02)
    p_r = -F.sd_box(v, F.RECV_X0, F.RECV_X0 + 0.08, F.RECV_Y, F.BARREL_Y + 0.03, F.RECV_Z)
    pen_vis = max(0.0, float(np.max([p_m.max(), p_b.max(), p_r.max()])))
    # fist band on the grip
    inside = d_grip < 0.012
    if not inside.any(): return None
    fy0 = max(v[inside, 1].min(), -F.LEN); fy1 = min(v[inside, 1].max(), TOP_Y)
    band = (GP[:, 1] >= fy0 + 0.004) & (GP[:, 1] <= fy1 - 0.004)
    if band.sum() < 8: return None
    P = GP[band]; Nn = GNm[band]
    cam_vis = np.einsum("ij,ij->i", Nn, CAM[None] - P) > 0
    hid_cam = ray_hits(v, P[cam_vis], CAM[None] - P[cam_vis], far=np.linalg.norm(CAM[None] - P[cam_vis], axis=1))
    hid_side = ray_hits(v, P, Nn)                                          # along the face normal: pokes out?
    occ_cam = hid_cam.mean() if len(hid_cam) else 0.0
    occ_side = hid_side.mean()
    cover = (fy1 - fy0) / (TOP_Y + F.LEN)                                  # share of the grip length inside the fist
    lat = H[:3, 2] @ UP                                                    # lateral hand axis along the grip
    wr = -H[:3, 1]; wh = np.array([wr[0], 0, wr[2]]); wh /= max(np.linalg.norm(wh), 1e-9)
    c = (2e4 * pen_vis + 40 * (1 - occ_cam) + 25 * (1 - occ_side) + 15 * max(0.0, 0.7 - cover)
         + 20 * (1 - lat) + 20 * (1 - wh @ WANT_H) + 10 * max(0.0, abs(wr[1]) - 0.6))
    out = dict(cost=c, pen_vis=pen_vis, occ_cam=occ_cam, occ_side=occ_side, cover=cover, lat=lat, wr=wr, band=(fy0, fy1))
    if full: out["v"] = v
    return out


def search(n_keep=15, verbose=True):
    res = []
    grid = itertools.product(np.radians([-30, -15, 0, 15, 30]), np.radians([-15, 0, 15]), np.radians([-15, 0, 15]),
                             [0.0, 0.012, 0.024], [0.035, 0.05, 0.065], [-0.01, 0.01], [-0.055, -0.042],
                             [1.4, 1.8], [0.8, 1.6])
    for roll, ta, tb, ax, ay, az, yg, s, th in grid:
        H = hand_frame(roll, ta, tb, np.array([ax, ay, az]), yg)
        cu = {n: s for n in FING}; cu["Thumb_L_1"] = th
        e = evaluate(H, cu)
        if e is None: continue
        res.append((e["cost"], (roll, ta, tb, ax, ay, az, yg, s, th), e))
    res.sort(key=lambda r: r[0])
    if verbose:
        for c, p, e in res[:n_keep]:
            print(f"cost {c:6.2f} roll/ta/tb {np.degrees(p[:3]).round()} axis ({p[3]:.3f},{p[4]:.3f},{p[5]:.3f}) yg {p[6]} curl {p[7]} thumb {p[8]} | "
                  f"pen {e['pen_vis']*1000:.1f}mm occ cam {e['occ_cam']:.2f} side {e['occ_side']:.2f} cover {e['cover']:.2f} lat {e['lat']:.2f} "
                  f"wrist {np.round(e['wr'], 2)}", flush=True)
    return res


def save(H, cu, path="fore_grip.json", extra=None):
    Fs = F.to_socket(H)
    d = {"offhand_local": Fs.tolist(), "curls": {k: float(v) for k, v in cu.items()}, "hand_metric": H.tolist(), "style": "fist_around_grip"}
    if extra: d.update(extra)
    json.dump(d, open(path, "w"), indent=1)
    return Fs


RAISE = 0.020          # the best-scoring fist sits low on the grip: raised 2 cm so it covers the middle (game-camera check)

if __name__ == "__main__":
    import pickle, time
    t0 = time.time()
    res = search()
    print("search s", round(time.time() - t0))
    pickle.dump([(c, p) for c, p, e in res[:60]], open("fore_fit4_top.pkl", "wb"))
    for k in range(3):
        c, p, e = res[k]
        H = hand_frame(*p[:3], np.array(p[3:6]), p[6]); cu = {n: p[7] for n in FING}; cu["Thumb_L_1"] = p[8]
        V.views(H, cu, f"fist_f{k}.png", label=f"#{k} cam {e['occ_cam']:.2f} side {e['occ_side']:.2f}")
    # local refinement of the best grid cell, then the raise; check with check_grip.py (IK) before baking
    H, cu, best = local_search(res[0][1], seed=1)
    x = best[1].copy(); x[6] += RAISE
    H = hand_frame(x[0], x[1], x[2], x[3:6], x[6])
    cu = {"Index_L_1": x[7], "Middle_L_1": x[8], "Ring_L_1": x[9], "Thumb_L_1": x[10]}
    e = evaluate(H, cu)
    print("final: cam %.2f side %.2f cover %.2f pen %.2f mm" % (e["occ_cam"], e["occ_side"], e["cover"], e["pen_vis"] * 1000))
    save(H, cu, "fore_grip.json", extra={"x": [float(a) for a in x]})
    V.views(H, cu, "fist_final.png", label="v2")


def local_search(p0, n_iter=5, n_samp=160, seed=1, verbose=True):
    """Cross-entropy style refinement around p0 = (roll, ta, tb, ax, ay, az, yg, s, th) with per-finger curls."""
    rng = np.random.default_rng(seed)
    roll, ta, tb, ax, ay, az, yg, s, th = p0
    mu = np.array([roll, ta, tb, ax, ay, az, yg, s, s, s, th], float)
    sig = np.array([np.radians(8), np.radians(6), np.radians(6), 0.005, 0.006, 0.005, 0.005, 0.25, 0.25, 0.25, 0.35])
    lo = np.array([-np.pi, -0.6, -0.6, -0.02, 0.02, -0.03, -0.07, 0.6, 0.6, 0.6, -0.8])
    hi = np.array([np.pi, 0.6, 0.6, 0.04, 0.09, 0.03, -0.03, 2.4, 2.4, 2.4, 2.4])

    def build(x):
        H = hand_frame(x[0], x[1], x[2], x[3:6], x[6])
        cu = {"Index_L_1": x[7], "Middle_L_1": x[8], "Ring_L_1": x[9], "Thumb_L_1": x[10]}
        return H, cu

    best = None
    for it in range(n_iter):
        X = np.clip(mu + rng.standard_normal((n_samp, len(mu))) * sig, lo, hi)
        X[0] = mu
        sc = []
        for x in X:
            H, cu = build(x)
            e = evaluate(H, cu)
            c = 1e9 if e is None else e["cost"] + 3 * np.std(x[7:10])          # prefer an even fist
            sc.append(c)
            if e is not None and (best is None or c < best[0]): best = (c, x.copy(), e)
        el = X[np.argsort(sc)[:16]]
        mu = el.mean(0); sig = np.maximum(el.std(0), sig * 0.25)
        if verbose:
            e = best[2]
            print(f"it {it} best {best[0]:.2f} cam {e['occ_cam']:.2f} side {e['occ_side']:.2f} cover {e['cover']:.2f} lat {e['lat']:.2f} "
                  f"pen {e['pen_vis']*1000:.2f} wrist {np.round(e['wr'],2)}", flush=True)
    H, cu = build(best[1])
    return H, cu, best
