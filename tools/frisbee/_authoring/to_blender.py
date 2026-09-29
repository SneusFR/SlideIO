"""Export baked clips (fp_clips.pkl / tp_clips.pkl) as glTF-local TRS per frame for blender/fl_anim.load_clips:
   python3 to_blender.py fp_clips.pkl blender_fp_clips.json [clip ...]"""
import sys, json, pickle, numpy as np
import weapon_def as wd
from rig import decompose

PARTS = ("Trigger", "Sled", "LimbL", "LimbR", "CordL", "CordR", "DiscDeck", "DiscHand", "Cage")


def trqs(M):
    if np.min(np.linalg.norm(M[:3, :3], axis=0)) < 1e-6:                  # hidden part (scale 0): identity rotation
        return [list(map(float, M[:3, 3])), [0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0]]
    t, r, s = decompose(M)
    s = np.asarray(s, float)
    return [list(map(float, t)), list(map(float, r)), list(map(float, s))]


def cage_disc_scales(st):
    n = int(st.get("cage_n", wd.CAGE_SLOTS))
    return [1.0 if (k < n and not (k == 0 and st.get("cage_top") is False)) else 0.0 for k in range(wd.CAGE_SLOTS)]


# ---- TP: the thrown cage becomes a world prop at the release (same physics as ts/DroppedCages.ts), character space
TOP, BOTTOM, RADIUS = 0.08, -1.64, 1.25
CENTER_Y, HALF = (TOP + BOTTOM) / 2, (TOP - BOTTOM) / 2


def _qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def _qaxis(axis, ang):
    axis = np.asarray(axis, float); n = np.linalg.norm(axis)
    if n < 1e-9 or abs(ang) < 1e-12: return np.array([0, 0, 0, 1.0])
    return np.r_[axis / n * np.sin(ang / 2), np.cos(ang / 2)]


def _rot(q, v):
    from rig import quat_to_mat3
    return quat_to_mat3(q) @ v


def simulate_drop(W0, vel, t0, times, g=9.81):
    """World matrix per requested time (None before t0) of the dropped cage (glTF / character space, ground y = 0)."""
    from rig import mat3_to_quat, quat_to_mat3
    sc = float(np.linalg.norm(W0[:3, 0])); pos = W0[:3, 3].copy(); q = mat3_to_quat(W0[:3, :3] / sc)
    v = np.asarray(vel, float).copy()
    spin = np.array([v[2], 0.0, -v[0]]); spin = spin / np.linalg.norm(spin) * 3.5 if np.linalg.norm(spin) > 1e-3 else np.array([3.5, 0, 0])
    out, t, h, resting = [], t0, 1 / 120, False
    for tt in times:
        if tt < t0: out.append(None); continue
        while t + 1e-9 < tt:
            if not resting:
                v[1] -= g * h; pos = pos + v * h
                w = np.linalg.norm(spin)
                if w > 1e-6: q = _qmul(_qaxis(spin / w, w * h), q); q /= np.linalg.norm(q)
                a = _rot(q, np.array([0, 1.0, 0])); c = pos + _rot(q, np.array([0, CENTER_Y * sc, 0]))
                ay = abs(a[1]); low = c[1] - (ay * HALF + np.sqrt(max(0.0, 1 - ay * ay)) * RADIUS) * sc
                if low < 0:
                    pos[1] -= low
                    if v[1] < 0: v[1] = -v[1] * 0.2
                    v[0] *= 0.55; v[2] *= 0.55; spin *= 0.5
                    tgt = np.array([0, np.sign(a[1]), 0.0]) if ay > 0.72 else np.array([a[0], 0.0, a[2]])
                    if np.linalg.norm(tgt) < 0.5: tgt = np.array([1.0, 0, 0])
                    tgt /= np.linalg.norm(tgt)
                    ax = np.cross(a, tgt); ang = np.arctan2(np.linalg.norm(ax), np.dot(a, tgt))
                    if ang > 1e-4:
                        step = min(ang, 10 * h)
                        q = _qmul(_qaxis(ax, step), q); q /= np.linalg.norm(q)
                    if np.dot(v, v) < 0.04 and np.dot(spin, spin) < 0.3 and ang < 0.02:
                        resting = True
            t += h
        M = np.eye(4); M[:3, :3] = quat_to_mat3(q) * sc; M[:3, 3] = pos
        out.append(M)
    return out


def tp_drop_track(c, name):
    """Per frame [t, q, s] of the dropped cage prop for the TP reload clips (None = not dropped yet)."""
    import author_fp as A
    from tp_rig import ch
    from rig import trs
    M_TP = pickle.load(open("tp_clips.pkl", "rb"))["_meta"]["mount"]
    S = trs(s=(wd.ROOT_SCALE,) * 3)
    fps = c["fps"]; times = [i / fps for i in range(len(c["frames"]))]
    rel = A.RL["release"]
    vis = [i for i, w in enumerate(c["weapon"]) if times[i] <= rel + 1e-9 and not isinstance(w.get("cage"), str) and w.get("cage") is not None]
    if len(vis) < 2: return [None] * len(times)
    i1, i0 = vis[-1], vis[-2]

    def cage_world(i):
        P = ch.rest_pose(); P.update(c["frames"][i])
        return ch.world(P)["Weapon_R"] @ M_TP @ S @ np.asarray(c["weapon"][i]["cage"])
    W1, W0 = cage_world(i1), cage_world(i0)
    vel = (W1[:3, 3] - W0[:3, 3]) / (times[i1] - times[i0])
    Ms = simulate_drop(W1, vel, times[i1], times)
    return [None if (M is None or t <= times[i1]) else trqs(M) for M, t in zip(Ms, times)]


def export(src, outp, names=None):
    clips = pickle.load(open(src, "rb"))
    out = {}
    for nm in (names or [k for k in clips if not k.startswith("_")]):
        c = clips[nm]; frames = []
        for f, w in zip(c["frames"], c["weapon"]):
            L = wd.node_locals(w)
            frames.append({"bones": {k: [list(map(float, f[k][0])), list(map(float, f[k][1]))] for k in f},
                           "objects": {n: trqs(L[n]) for n in PARTS},
                           "cage_discs": cage_disc_scales(w)})
        if nm.startswith("TP_Reload"):
            for f, d in zip(frames, tp_drop_track(c, nm)): f["drop"] = d
        out[nm] = {"fps": c["fps"], "frames": frames}
    json.dump(out, open(outp, "w"))
    print("wrote", outp, {k: len(v["frames"]) for k, v in out.items()})


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2], sys.argv[3:] or None)
