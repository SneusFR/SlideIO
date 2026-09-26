"""v5 TP clips — 'always aiming' stance: the gun points STRAIGHT ahead in every clip (hold / aim / run / fire /
fire-last / raise / lower), the upper body is bladed a little (Spine_1 yaw -10.6°, lean 4.5°) so the Potato's short
left arm reaches the pump, and every frame solves both arms with natural-range limits (tp_straight.solve_straight).
Run: python3 author_tp5.py [clip ...]  -> tp_clips.pkl (same format as author_tp.py)."""
import sys, pickle, numpy as np
names = sys.argv[1:]; sys.argv = sys.argv[:1]
import author_tp as T
import author_fp as A
import tp_straight as S
import weapon_def as wd
from anim_util import Track, ease, noise1

KEY = pickle.load(open("tp_straight_hold_w.pkl", "rb"))[1]
P0 = np.asarray(KEY["p"]); THETA = float(KEY["theta"]); SLIDE = float(KEY["slide"]); SPINE = tuple(float(v) for v in KEY["spine"])
OFF_TP = S.tp_offhand(THETA, SLIDE)


def pump_lh(Wn):
    return Wn["Pump"] @ OFF_TP


def body(clip, t, spine_scale=1.0):
    b = T.hex_pose(clip, t)
    return S.spine_pose(b, SPINE[0] * spine_scale, SPINE[1] * spine_scale)


def breathing(t, period=2.0, amp=1.0):
    ph = 2 * np.pi * t / period
    return np.array([0.0006 * np.sin(ph + 0.6), 0.0016 * np.sin(ph), 0.0005 * np.sin(ph + 2.2)]) * amp, \
        dict(pitch=0.5 * amp * np.sin(ph + 1.1), roll=0.4 * amp * np.sin(ph + 2.0), yaw=0.25 * amp * np.sin(ph + 0.4))


class Baker:
    def __init__(self):
        self.x = None

    def frame(self, base, p, off=None, lh=None, pump=0.0, lid=0.0, trig=0.0, lf=None, rfi=1.0, w_nat=1.0, wrot=None):
        pose, info = S.solve_straight(base=base, fix_p=p, gun_off=off or {}, lh=lh or pump_lh, pump=pump, lid=lid, trig=trig,
                                      free_spine=False, x0=self.x, verbose=False, w_nat=w_nat, max_nfev=200)
        if info["eL"] > 0.002 and self.x is not None:            # re-seed from neutral if the warm start got trapped
            p2, i2 = S.solve_straight(base=base, fix_p=p, gun_off=off or {}, lh=lh or pump_lh, pump=pump, lid=lid, trig=trig,
                                      free_spine=False, x0=None, verbose=False, w_nat=w_nat, max_nfev=300)
            if i2["eL"] + i2["eR"] < info["eL"] + info["eR"]: pose, info = p2, i2
        self.x = info["x"]
        lf = A.PUMP_CURLS if lf is None else lf
        lfs = lf if isinstance(lf, dict) else {n: lf for n in T.FINGERS_L}
        for n in T.FINGERS_L:
            pose[n] = (T.REST[n][0], A.finger_q(n, lfs.get(n, 1.0)), T.REST[n][2])
        pose["Index_R_1"] = (T.REST["Index_R_1"][0], T.finger_q("Index_R_1", rfi), T.REST["Index_R_1"][2])
        pose["Weapon_R"] = T.REST["Weapon_R"]
        return pose, (pump, lid, trig), (info["eR"], 0.0, info["eL"], info["rL"])


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


_CH0 = T.ch.world(body("TP_Aim_HexSniper", 0.0))["Chest"][:3, 3]


def c_run(t, bk):
    b = body("TP_Run_HexSniper", t)
    chest = T.ch.world(b)["Chest"][:3, 3]
    ph = 2 * np.pi * t / 0.8
    dp = (chest - _CH0) * np.array([0.8, 1.0, 0.6]) + np.array([0.004 * np.sin(ph), 0.006 * np.cos(2 * ph), 0.0])
    return bk.frame(b, P0 + dp, dict(yaw=1.5 * np.sin(ph), pitch=1.5 * np.cos(2 * ph + 0.4), roll=2.0 * np.sin(ph + 0.3)))


def fire_generic(t, bk, with_pump):
    k = A.KICK(t)
    base = body("TP_Aim_HexSniper", 0.0)
    b2 = dict(base)
    Tq, Rq, Sq = base["Spine_1"]
    from scipy.spatial.transform import Rotation as Rot
    b2["Spine_1"] = (Tq, (Rot.from_quat(Rq) * Rot.from_euler("X", -5.0 * T.SPINE_KICK(t), degrees=True)).as_quat(), Sq)
    off = dict(pitch=9.0 * k, roll=1.5 * k, yaw=-1.0 * k)
    dp = np.array([0.0, 0.006 * k, -0.018 * k])
    pump = float(A.PUMP_FIRE(t)) if with_pump else 0.0
    if with_pump:
        rk = A.pump_body(t, 0.24, 0.39, 0.42, 0.54)
        off = dict(pitch=off["pitch"] + rk["pitch"] * 0.6, roll=off["roll"] + rk["roll"] * 0.6, yaw=off["yaw"] + rk["yaw"] * 0.6)
    return bk.frame(b2, P0 + dp, off, pump=pump, trig=float(A.TRIG_FIRE(t)), rfi=float(A.INDEX_FIRE(t)))


def c_fire(t, bk):
    return fire_generic(t, bk, True)


def c_fire_last(t, bk):
    return fire_generic(t, bk, False)


# reload: the gun leaves the straight line only for the lid / sprinkle part (it comes to the left hand), then
# presents the tank for the pops and returns straight for the rack.
TP_RELOAD = Track([(0, np.zeros(6)),
                   (0.22, [0.030, -0.030, -0.030, 22.0, 8.0, -18.0], "io"),
                   (0.60, [0.032, -0.032, -0.032, 24.0, 9.0, -20.0], "io"),
                   (0.88, [0.028, -0.028, -0.030, 20.0, 7.0, -16.0], "io"),
                   (1.10, [0.010, -0.012, -0.012, 8.0, 5.0, -8.0], "io"),
                   (1.62, [0.008, -0.010, -0.010, 6.0, 4.0, -6.0], "io"),
                   (1.80, [0.0, 0.0, 0.0, 0.0, 1.0, -1.0], "io"),
                   (2.20, np.zeros(6), "io")])


def c_reload(t, bk):
    fp = A.clip_reload(t)
    v = TP_RELOAD(t)
    pr = float(A.POP_RATE(t))
    rk = A.pump_body(t, A.RL["rack0"] - 0.02, A.RL["rack_b"], A.RL["rack_h"], A.RL["rack_f"])
    off = dict(yaw=v[3] + rk["yaw"] * 0.6, pitch=v[4] + 1.2 * pr * noise1(t, 4, 26) + rk["pitch"] * 0.6,
               roll=v[5] + 1.4 * pr * noise1(t, 5, 21) + rk["roll"] * 0.6)
    spine_s = 1.0
    lh = fp["lh"]
    if lh is A.pump_hand:
        lh_tp = pump_lh
    else:
        lh_tp = lambda Wn, f=lh: A.normalized(f(dict(Wn, Offhand=Wn["Pump"] @ OFF_TP)))
    return bk.frame(body("TP_Aim_HexSniper", 0.0, spine_s), P0 + v[:3], off, lh=lh_tp, pump=fp["pump"], lid=fp["lid"],
                    lf=fp["lf"], rfi=0.9, w_nat=0.8)


TP_CLIPS5 = {
    "TP_Hold_PopcornShotgun": (c_hold, 2.0, 30, True, T.HOLD_CH),
    "TP_Run_PopcornShotgun": (c_run, 0.8, 30, True, T.RUN_CH),
    "TP_Aim_PopcornShotgun": (c_aim, 2.0, 30, True, T.HOLD_CH),
    "TP_Raise_PopcornShotgun": (c_raise, 0.3, 120, False, T.RAISE_CH),
    "TP_Lower_PopcornShotgun": (c_lower, 0.3, 120, False, T.RAISE_CH),
    "TP_Fire_PopcornShotgun": (c_fire, 0.9, 60, False, T.HOLD_CH),
    "TP_FireLast_PopcornShotgun": (c_fire_last, 0.55, 60, False, T.HOLD_CH),
    "TP_Reload_PopcornShotgun": (c_reload, 2.2, 60, False, T.HOLD_CH),
}


def bake(name):
    fn, dur, fps, loop, chans = TP_CLIPS5[name]
    chans = sorted(set(chans) | {(b, "rotation") for b in T.FINGERS_L + T.FINGERS_R + ["Hand_L", "LowerArm_L", "UpperArm_L", "Shoulder_L",
                                                                                         "Hand_R", "LowerArm_R", "UpperArm_R", "Shoulder_R", "Spine_1"]}
                   | {("Weapon_R", "translation")})
    n = int(round(dur * fps)) + 1
    bk = Baker()
    frames, ws, errs = [], [], []
    for i in range(n):
        t = min(i / fps, dur)
        pose, w, err = fn(t, bk)
        frames.append({b: pose[b] for b in set(c[0] for c in chans)})
        ws.append(w); errs.append(err)
    errs = np.array(errs)
    print(f"{name:30s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
          f"maxR={errs[:, 0].max() * 1000:.2f}mm", flush=True)
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=ws, channels=chans, errors=errs)


import os
OUT = os.environ.get("OUT", "tp_clips_v5.pkl")

if __name__ == "__main__":
    todo = names or list(TP_CLIPS5)
    try:
        out = pickle.load(open(OUT, "rb"))
    except Exception:
        out = {}
    for nm in todo:
        out[nm] = bake(nm)
        out["_meta"] = dict(mount=T.M_TP, channels=T.HOLD_CH)
        pickle.dump(out, open(OUT, "wb"))
