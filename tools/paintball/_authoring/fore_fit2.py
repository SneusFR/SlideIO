"""Parametric foregrip hold search: palm on the gun's left side, fingers wrapping the FRONT face, thumb up;
fingers closed until contact (like a real grip)."""
import json, itertools, numpy as np
import fore_fit as F

FING = F.FING


def close_fingers(H, tol=0.0008):
    """Per finger: scan the curl, keep the tightest contact (smallest gap) without penetration (prefers wrapped)."""
    curls = {n: 1.2 for n in FING}; curls["Thumb_L_1"] = 0.6
    grid = np.arange(-0.6, 2.41, 0.1)
    for n in FING:
        m = F.DOMSEL == n
        best = None
        for s_ in grid:
            c2 = dict(curls); c2[n] = s_
            v = F.hand_vertices(H, c2)[m]
            pen = F.penetration(v, 0).max()
            if pen > tol: continue
            gap = F.sd_grip(v).min()
            key = (round(gap * 1000 / 1.5), -s_)          # 1.5 mm bins, then the most curled
            if best is None or key < best[0]: best = (key, s_)
        curls[n] = best[1] if best else 0.0
    return curls


def evaluate(H, cu, want):
    v = F.hand_vertices(H, cu)
    pen = max(0.0, F.penetration(v, 0).max())
    d = F.sd_grip(v)
    gaps = {n: d[F.DOMSEL == n].min() for n in F.HAND}
    wrist = -H[:3, 1]
    c = 1e4 * pen
    for n in ["Index_L_1", "Middle_L_1", "Ring_L_1"]: c += 1000 * max(0.0, gaps[n] - 0.0015)
    c += 1500 * max(0.0, gaps["Hand_L"] - 0.003) + 300 * max(0.0, gaps["Thumb_L_1"] - 0.006)
    c += 20 * (1 - wrist @ want)
    return c, pen, gaps, wrist


if __name__ == "__main__":
    want = np.array([0.6, -0.6, 0.5]); want /= np.linalg.norm(want)
    res = []
    for phi, psi, yc, gpx, gpy, gpz, tilt in itertools.product(np.radians([-15, 0, 15]), np.radians([15, 30, 45]),
                                                      [-0.4 * F.LEN, -0.55 * F.LEN], [0.045, 0.055, 0.065], [0.05, 0.065, 0.08],
                                                      [-0.03, -0.015, 0.0], np.radians([-10, 10])):
        gap = 0.0
        H = F.frame_from_params(phi, psi, yc, 0.0, tilt, gp=(gpx, gpy, gpz))
        v = F.hand_vertices(H, {n: -0.4 for n in FING})
        mh = F.DOMSEL == "Hand_L"
        if F.penetration(v[mh], 0).max() > 0.001: continue            # the palm itself must be free
        cu = close_fingers(H)
        c, pen, gaps, wrist = evaluate(H, cu, want)
        res.append((c, np.degrees([phi, psi, tilt]).round(), round(yc, 4), (gpx, gpy, gpz), cu, H, gaps, wrist))
    res.sort(key=lambda r: r[0])
    for r in res[:8]:
        print(f"cost {r[0]:7.2f} phi/psi/tilt {r[1]} yc {r[2]} gap {r[3]} curls " + " ".join(f"{k[:1]}{v:.2f}" for k, v in r[4].items())
              + " gaps " + " ".join(f"{k[:1]}{1000*v:.1f}" for k, v in r[6].items()) + f" wrist {np.round(r[7],2)}")
    c, ang, yc, gap, cu, H, gaps, wrist = res[0]
    Fs = F.to_socket(H)
    json.dump({"offhand_local": Fs.tolist(), "curls": cu, "hand_metric": H.tolist(), "params": [float(a) for a in ang] + [yc] + list(gap)},
              open("fore_grip.json", "w"), indent=1)
    print("socket", np.round(Fs[:3, 3], 3))
