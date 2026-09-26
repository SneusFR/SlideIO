"""TP pose-library authoring on Potato_TP_Character (third-person, remote players).

Base body / right arm come from the HexSniper TP library (same silhouette family); the weapon is
re-mounted on our grip, the left hand is IK-solved on the OffhandSocket / lid / tank frames of the
SAME weapon clip curves as FP, so remote players' pump / lid stay in sync with their hands.
"""
import json, pickle, sys
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from rig import Rig, trs, qaxis, qmul, qnorm, quat_to_mat3
import weapon_def as wd
import author_fp as A
from anim_util import Track, ease, normalized, blend_frames, rotx, roty, rotz, noise1
from ik import ChainIK

ch = Rig("Potato_TP_Character.glb")
hexp = Rig("HexSniper_TP_Poses.glb")
prof = json.load(open("WeaponProfile_HexSniper.json"))
M_HEX_TP = np.array(prof["mounts"]["tp"]["matrixColumnMajor"]).reshape(4, 4).T
S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)
HEX_GRIP = np.array([1.47, -0.17, 0.0])
M_TP = M_HEX_TP @ trs(wd.ROOT_SCALE * (HEX_GRIP - wd.GRIP + np.array(A.MOUNT_OFFSET)))
REST = ch.rest_pose()

ikR = ChainIK(ch, ["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"], "Weapon_R",
              rot_bones=["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"])
ikL = ChainIK(ch, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"])

FINGERS_L = ["Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FINGERS_R = ["Index_R_1", "Middle_R_1", "Ring_R_1", "Thumb_R_1"]
HOLD_SET = sorted(set(c[0] for c in [(n, p) for (n, p) in hexp.clips["TP_Hold_HexSniper"]["channels"].keys()]))


def channel_set(hex_clip):
    return sorted(hexp.clips[hex_clip]["channels"].keys())


HOLD_CH = channel_set("TP_Hold_HexSniper")
RUN_CH = channel_set("TP_Run_HexSniper")
RAISE_CH = sorted(set(channel_set("TP_Raise_HexSniper")) | {("Spine_1", "rotation"), ("Plant_Root", "rotation")})

HEX_HOLD0 = ch.pose_from_clip(hexp.clips["TP_Hold_HexSniper"], 0.0)


def finger_q(name, s, ref=HEX_HOLD0):
    rq = REST[name][1]; hq = ref[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


def hex_pose(clip, t):
    return ch.pose_from_clip(hexp.clips[clip], t)


def gun_of(pose):
    W = ch.world(pose)
    return W, W["Weapon_R"] @ M_TP @ S_ROOT


def about_grip(G, dpos=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0):
    """Offset a weapon placement (character space): rotations about the GRIP point, axes of the
    weapon itself for roll (forward axis) and of the character for yaw / pitch."""
    g = (G @ np.r_[wd.GRIP, 1.0])[:3]
    Rw = G[:3, :3] / np.linalg.norm(G[:3, :3], axis=0)
    fwd = -Rw[:, 0]
    side = Rw[:, 2]
    R = Rot.from_rotvec(np.array([0, 1, 0]) * np.radians(yaw)).as_matrix() @ \
        Rot.from_rotvec(-side * np.radians(pitch)).as_matrix() @ Rot.from_rotvec(fwd * np.radians(roll)).as_matrix()
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = g - R @ g + np.asarray(dpos)
    return M @ G


# TP pump grip: same fitted hand-to-pump relation IN METRES as FP (the TP mount is 0.35 vs 0.40, so
# the socket offset expressed in weapon units is rescaled; the Potato hand keeps its real size).
_TP_OFF = wd.OFFHAND_LOCAL.copy()
_TP_OFF[:3, 3] *= float(np.linalg.norm(A.M_FP[:3, 0]) / np.linalg.norm(M_TP[:3, 0]))


def tp_pump_hand(Wn):
    return Wn["Pump"] @ _TP_OFF


def solve(base, G_target=None, lh=None, lf=None, rfi=1.0, pump=0.0, lid=0.0, trig=0.0, xR=None, xL=None, wrot=0.5):
    pose = dict(base)
    W = ch.world(pose)
    eR = rR = 0.0
    if G_target is not None:
        tgt = normalized(G_target @ np.linalg.inv(S_ROOT) @ np.linalg.inv(M_TP))
        pose, xR, eR, rR = ikR.solve(pose, W, tgt, base, w_rot=1.0, reg_rot=[0.25, 0.05, 0.02, 0.02], x0=xR,
                                     extra=lambda wl: A.joint_limits(wl, "R"))
        W = ch.world(pose)
    G = W["Weapon_R"] @ M_TP @ S_ROOT
    Wn = wd.world_nodes(G, pump, lid, trig)
    if lh is None or lh is A.pump_hand:
        lh = tp_pump_hand
    else:  # FP choreography frames (lid / tank) mixing with the pump: swap in the TP pump frame
        fp_lh = lh
        lh = lambda Wn2, f=fp_lh: f(dict(Wn2, Offhand=Wn2["Pump"] @ _TP_OFF))
    pose, xL, eL, rL = ikL.solve(pose, W, normalized(lh(Wn)), base, w_rot=wrot, reg_rot=[0.25, 0.03, 0.02, 0.02], x0=xL,
                                 extra=lambda wl: A.joint_limits(wl, "L"))
    lf = A.PUMP_CURLS if lf is None else lf
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    for n in FINGERS_L:
        pose[n] = (REST[n][0], A.finger_q(n, lfs.get(n, 1.0)), REST[n][2])   # same absolute curls as FP
    pose["Index_R_1"] = (REST["Index_R_1"][0], finger_q("Index_R_1", rfi), REST["Index_R_1"][2])
    pose["Weapon_R"] = REST["Weapon_R"]
    return pose, (pump, lid, trig), xR, xL, (eR, rR, eL, rL)


# ------------------------------------------------------------------ clips
def c_hold(t, st):
    return solve(hex_pose("TP_Hold_HexSniper", t), xL=st.get("xL"))


def c_run(t, st):
    return solve(hex_pose("TP_Run_HexSniper", t), xL=st.get("xL"))


def c_aim(t, st):
    return solve(hex_pose("TP_Aim_HexSniper", t), xL=st.get("xL"))


def c_raise(t, st):
    return solve(hex_pose("TP_Raise_HexSniper", t), xL=st.get("xL"))


def c_lower(t, st):
    return solve(hex_pose("TP_Lower_HexSniper", t), xL=st.get("xL"))


SPINE_KICK = Track([(0, 0), (0.05, 1.0, "out"), (0.22, 0.25, "io"), (0.40, 0.0, "io")])


def lean(pose, deg_back):
    p = dict(pose)
    T, R, S = p["Spine_1"]
    p["Spine_1"] = (T, qnorm(qmul(R, qaxis([1, 0, 0], np.radians(-deg_back)))), S)
    return p


def c_fire_generic(t, st, with_pump):
    base = lean(hex_pose("TP_Hold_HexSniper", 0.0), 5.0 * SPINE_KICK(t))
    _, G = gun_of(base)
    k = A.KICK(t)
    d = A.add(A.kick_offsets(k), A.pump_body(t, 0.24, 0.39, 0.42, 0.54)) if with_pump else A.kick_offsets(k)
    Gt = about_grip(G, dpos=(0, d["grip"][1] * 0.8, -d["grip"][2] * 0.6), pitch=d["pitch"] * 0.8, roll=d["roll"], yaw=d["yaw"])
    pump = float(A.PUMP_FIRE(t)) if with_pump else 0.0
    return solve(base, Gt, pump=pump, trig=float(A.TRIG_FIRE(t)), rfi=float(A.INDEX_FIRE(t)),
                 xR=st.get("xR"), xL=st.get("xL"))


def c_fire(t, st):
    return c_fire_generic(t, st, True)


def c_fire_last(t, st):
    return c_fire_generic(t, st, False)


TP_RELOAD_TILT = Track([(0, np.zeros(6)),
                        (0.22, [0.0, 0.030, -0.015, -10.0, 10.0, -20.0], "io"),
                        (0.60, [0.0, 0.032, -0.016, -11.0, 11.0, -21.0], "io"),
                        (0.88, [0.0, 0.028, -0.014, -9.0, 9.0, -18.0], "io"),
                        (1.10, [0.0, 0.018, -0.010, -5.0, 6.0, -10.0], "io"),
                        (1.62, [0.0, 0.014, -0.008, -4.0, 5.0, -8.0], "io"),
                        (1.80, [0.0, 0.004, -0.003, -1.0, 1.5, -3.0], "io"),
                        (2.20, np.zeros(6), "io")])


def c_reload(t, st):
    base = hex_pose("TP_Hold_HexSniper", 0.0)
    _, G = gun_of(base)
    fp = A.clip_reload(t)                     # same choreography / weapon curves as FP
    v = TP_RELOAD_TILT(t)
    pr = float(A.POP_RATE(t))
    jig_p = 1.2 * pr * noise1(t, 4, 26); jig_r = 1.4 * pr * noise1(t, 5, 21)
    rk = A.pump_body(t, A.RL["rack0"] - 0.02, A.RL["rack_b"], A.RL["rack_h"], A.RL["rack_f"])
    Gt = about_grip(G, dpos=v[:3], yaw=v[3] + rk["yaw"], pitch=v[4] + jig_p + rk["pitch"], roll=v[5] + jig_r + rk["roll"])
    return solve(base, Gt, lh=fp["lh"], lf=fp["lf"], pump=fp["pump"], lid=fp["lid"], rfi=0.9,
                 xR=st.get("xR"), xL=st.get("xL"), wrot=fp.get("wrotL", 0.5))


TP_CLIPS = {
    "TP_Hold_PopcornShotgun": (c_hold, 2.0, 30, True, HOLD_CH),
    "TP_Run_PopcornShotgun": (c_run, 0.8, 30, True, RUN_CH),
    "TP_Aim_PopcornShotgun": (c_aim, 2.0, 30, True, HOLD_CH),
    "TP_Raise_PopcornShotgun": (c_raise, 0.3, 120, False, RAISE_CH),
    "TP_Lower_PopcornShotgun": (c_lower, 0.3, 120, False, RAISE_CH),
    "TP_Fire_PopcornShotgun": (c_fire, 0.9, 60, False, HOLD_CH),
    "TP_FireLast_PopcornShotgun": (c_fire_last, 0.55, 60, False, HOLD_CH),
    "TP_Reload_PopcornShotgun": (c_reload, 2.2, 60, False, HOLD_CH),
}


def bake(name):
    fn, dur, fps, loop, chans = TP_CLIPS[name]
    chans = sorted(set(chans) | {(b, "rotation") for b in FINGERS_L + FINGERS_R + ["Hand_L", "LowerArm_L", "UpperArm_L", "Shoulder_L",
                                                                                     "Hand_R", "LowerArm_R", "UpperArm_R", "Shoulder_R"]}
                   | {("Weapon_R", "translation")})
    n = int(round(dur * fps)) + 1
    st = {}
    frames, ws, errs = [], [], []
    for i in range(n):
        t = min(i / fps, dur)
        pose, w, xR, xL, err = fn(t, st)
        st["xR"], st["xL"] = xR, xL
        frames.append({b: pose[b] for b in set(c[0] for c in chans)})
        ws.append(w); errs.append(err)
    errs = np.array(errs)
    print(f"{name:30s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
          f"maxR={errs[:, 0].max() * 1000:.2f}mm/{errs[:, 1].max():.2f}deg")
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=ws, channels=chans, errors=errs)


if __name__ == "__main__":
    names = sys.argv[1:] or list(TP_CLIPS)
    try:
        out = pickle.load(open("tp_clips.pkl", "rb"))
    except Exception:
        out = {}
    for nm in names:
        out[nm] = bake(nm)
    out["_meta"] = dict(mount=M_TP, channels=HOLD_CH)
    pickle.dump(out, open("tp_clips.pkl", "wb"))
