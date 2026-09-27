"""FP pose-library authoring for the Paintball Rifle (IK-driven, same 20-channel set as the HexSniper).

Every frame: the weapon placement is authored in CAMERA space, the right arm is solved so Weapon_R carries
the weapon there (the weapon is parented to Weapon_R at runtime), then the left arm is solved against the
ACTUAL weapon / hopper / charging-handle transforms of that frame (hand glued).
Left hand on the vertical foregrip = the right hand's pistol-grip hold MIRRORED (the Potato rig is
left/right symmetric), re-aligned on the foregrip axis, then turned about the foregrip axis for a straight
arm on screen.
"""
import pickle, sys, json
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from fp_common import arms, hold_ref, mount_from, weapon_root_world, S_ROOT, render
import weapon_def as wd
from ik import ChainIK
from anim_util import Track, ease, normalized, frame_from, blend_frames, rotz, rotx, roty, noise1
from rig import trs, qaxis, qmul, quat_to_mat3, mat3_to_quat, qnorm

# ---------------------------------------------------------------- setup
MOUNT_OFFSET = (0.04, -0.24, 0.0)                 # = Popcorn Shotgun (same grip point, same right hand)
M_FP = mount_from(offset_local=MOUNT_OFFSET)
GUN_SCALE = wd.ROOT_SCALE * float(np.linalg.norm(M_FP[:3, 0]))  # world metres per weapon unit (≈0.076)
HOLD = dict(grip=np.array([0.254, -0.281, -0.508]), yaw=12.0, pitch=0.0, roll=0.0)
AIM = dict(grip=np.array([0.20, -0.276, -0.495]), yaw=0.0, pitch=0.0, roll=0.0)

HEX = hold_ref()
V0 = HEX["FP_Viewmodel"]
ikR = ChainIK(arms, ["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"], "Weapon_R",
              rot_bones=["UpperArm_R", "LowerArm_R", "Hand_R"], trans_bones=["Shoulder_R"])
ikL = ChainIK(arms, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["UpperArm_L", "LowerArm_L", "Hand_L"], trans_bones=["Shoulder_L"])
FINGERS_L = ["Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FINGERS_R = ["Index_R_1", "Middle_R_1", "Ring_R_1", "Thumb_R_1"]
REST = arms.rest_pose()

CHANNELS = [("FP_Viewmodel", "translation"), ("FP_Viewmodel", "rotation"), ("Hips", "translation"), ("Hips", "rotation"),
            ("Shoulder_L", "translation"), ("Shoulder_R", "translation")] + \
           [(b, "rotation") for b in ["UpperArm_L", "LowerArm_L", "Hand_L", "UpperArm_R", "LowerArm_R", "Hand_R"]
            + FINGERS_L + FINGERS_R]

MX = np.diag([-1.0, 1.0, 1.0])
MZ = np.diag([1.0, 1.0, -1.0])


def _mirror_q(q):
    return np.array([q[0], -q[1], -q[2], q[3]])


def finger_q(name, s):
    """Curl a finger with the HexSniper grip curl axis (both hands): s=0 rest, 1 HexSniper curl, 2 twice."""
    rq = REST[name][1]
    hq = HEX[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


def open_q(name, s):
    """Left-hand finger pose with the HexSniper LEFT curl (flat palm-up hand) — used off the gun."""
    rq = REST[name][1]; hq = HEX[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


# ---- the pistol-grip hold of the right hand, expressed in weapon units, mirrored onto the foregrip
GRIP_TOP = np.array([0.7705, -0.338, 0.0])
GRIP_BOT = np.array([0.981, -1.402, 0.0])
_ga = (GRIP_BOT - GRIP_TOP) / np.linalg.norm(GRIP_BOT - GRIP_TOP)
GRIP_TILT = np.degrees(np.arctan2(_ga[0], -_ga[1]))           # ≈ 11° (bottom toward the stock)
FORE_TOP = np.array([wd.FOREGRIP_X, wd.FOREGRIP_Y0, 0.0])


def right_socket_local():
    """Weapon_R in weapon-local units (root space, rotation normalised)."""
    T = np.linalg.inv(M_FP @ S_ROOT)
    return normalized(T)


def foregrip_socket(yaw_deg=0.0, slide=0.0, tilt=0.0, fwd=0.0):
    """Weapon_L frame on the foregrip (root space): mirrored right-hand grip, re-aligned on the vertical
    foregrip axis. yaw: turn of the hand about the foregrip axis (+ = toward the muzzle side), slide: along
    the axis (+ = down), tilt: extra pitch about Z, fwd: along X."""
    FR = right_socket_local()
    p = FR[:3, 3]; R = FR[:3, :3]
    pm = MZ @ p; Rm = MZ @ R @ MX                          # mirrored geometry, left-hand local convention
    Ralign = rotz(-(GRIP_TILT) + tilt)                      # pistol-grip axis -> vertical
    along = float((p - GRIP_TOP) @ _ga)                     # how far down the grip the hand sits
    pc = GRIP_TOP + _ga * along                             # grip-axis point level with the hand
    q = FORE_TOP + np.array([fwd, -along - slide, 0.0]) + Ralign @ (pm - pc)
    Ryaw = roty(yaw_deg)
    F = np.eye(4); F[:3, :3] = Ryaw @ Ralign @ Rm
    F[:3, 3] = FORE_TOP + np.array([fwd, -along - slide, 0.0]) + Ryaw @ (q - FORE_TOP - np.array([fwd, -along - slide, 0.0]))
    return F


# v1 foregrip hold FITTED on the real hand mesh (fore_fit2.py): fist on the grip's left face, knuckles forward,
# forearm from below-behind-left, no penetration.
_FG = json.load(open(__import__("os").environ.get("FORE_GRIP", "fore_grip.json")))                  # v2 (FP): fist closed around the grip (fore_fit4.py)
OFFHAND_FIT = np.array(_FG["offhand_local"], float)
FORE_CURLS = {k: float(v) for k, v in _FG["curls"].items()}
# v1 fit (fore_fit2.py) kept for the TP foregrip (tp_key.pkl / TP bake) and for the hopper / charging-handle grabs
_FG1 = json.load(open("fore_grip_v1.json"))
OFFHAND_FIT_V1 = np.array(_FG1["offhand_local"], float)
FORE_CURLS_V1 = {k: float(v) for k, v in _FG1["curls"].items()}
GRIP_YAW = 0.0               # extra turn of the hand about the (vertical) foregrip axis


def _yaw_about_grip(F, deg):
    c = np.array([wd.FOREGRIP_X, 0.0, 0.0])
    R = np.eye(4); R[:3, :3] = roty(deg)
    return trs(c) @ R @ trs(-c) @ F


wd.OFFHAND_LOCAL = _yaw_about_grip(OFFHAND_FIT, GRIP_YAW)
OFFHAND_LOCAL_V1 = _yaw_about_grip(OFFHAND_FIT_V1, GRIP_YAW)


def gripmix(w_grip, s_other):
    """Finger curls blended between the fitted foregrip fist (w=1) and a uniform curl."""
    w = float(np.clip(w_grip, 0, 1))
    return {n: FORE_CURLS[n] * w + s_other * (1 - w) for n in FORE_CURLS}


def gun_matrix(grip_pos, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon ROOT world matrix with the GRIP point at grip_pos (camera space).
    yaw +: muzzle to the left; pitch +: muzzle up; roll +: top to the right."""
    base = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]]).T
    R = roty(yaw) @ rotx(pitch) @ quat_to_mat3(qaxis([0, 0, 1], np.radians(-roll))) @ base
    G = np.eye(4); G[:3, :3] = R * GUN_SCALE
    G[:3, 3] = np.asarray(grip_pos) - G[:3, :3] @ wd.GRIP
    return G


def place(base, d=None):
    d = d or {}
    return dict(grip=base["grip"] + np.asarray(d.get("grip", (0, 0, 0))), yaw=base["yaw"] + d.get("yaw", 0.0),
                pitch=base["pitch"] + d.get("pitch", 0.0), roll=base["roll"] + d.get("roll", 0.0))


def lerp_place(a, b, u):
    return dict(grip=a["grip"] * (1 - u) + b["grip"] * u, yaw=a["yaw"] * (1 - u) + b["yaw"] * u,
                pitch=a["pitch"] * (1 - u) + b["pitch"] * u, roll=a["roll"] * (1 - u) + b["roll"] * u)


def add(*ds):
    out = dict(grip=np.zeros(3), yaw=0.0, pitch=0.0, roll=0.0)
    for d in ds:
        out["grip"] = out["grip"] + np.asarray(d.get("grip", (0, 0, 0)))
        for k in ("yaw", "pitch", "roll"):
            out[k] += d.get(k, 0.0)
    return out


# ---------------------------------------------------------------- arm aesthetics (soft constraints)
def _hinge(v):
    return np.maximum(v, 0.0)


def keep_left(wl):
    ua = wl["UpperArm_L"][:3, 3]; h = wl["Weapon_L"][:3, 3]; sh = wl["Shoulder_L"][:3, 3]
    return 1000.0 * 0.6 * np.array([_hinge(ua[0] - (h[0] - 0.10)), _hinge(ua[1] - (h[1] - 0.05)),
                                    _hinge(sh[0] - (h[0] + 0.02)), _hinge(sh[1] - (h[1] - 0.03))])


from twist import swing_twist as _swing_twist


def _local_q(wl, parent, child):
    Mp = wl[parent][:3, :3] / np.linalg.norm(wl[parent][:3, :3], axis=0)
    Mc = wl[child][:3, :3] / np.linalg.norm(wl[child][:3, :3], axis=0)
    return mat3_to_quat(Mp.T @ Mc)


LIMITS = {"Hand": (72.0, 32.0), "LowerArm": (125.0, 40.0)}


def joint_limits(wl, side):
    out = []
    for parent, child, key in ((f"LowerArm_{side}", f"Hand_{side}", "Hand"), (f"UpperArm_{side}", f"LowerArm_{side}", "LowerArm")):
        sw, tw = _swing_twist(_local_q(wl, parent, child))
        smax, tmax = LIMITS[key]
        out += [max(0.0, sw - smax) * 4.0, max(0.0, abs(tw) - tmax) * 6.0]
    return np.array(out)


SLEEVE_LEN = 0.45
_F65 = 1 / np.tan(np.radians(65) / 2)


def sleeve_offscreen(wl, side="L"):
    ua = wl[f"UpperArm_{side}"][:3, 3]; el = wl[f"LowerArm_{side}"][:3, 3]
    d = (el - ua) / np.linalg.norm(el - ua)
    out = []
    for p in (ua - d * SLEEVE_LEN * 0.5, ua - d * SLEEVE_LEN):
        if p[2] > -0.03:
            out.append(0.0); continue
        ndc_y = _F65 * p[1] / -p[2]
        out.append(max(0.0, ndc_y + 1.08) * 60.0)
    return np.array(out)


def keep_right(wl):
    ua = wl["UpperArm_R"][:3, 3]; h = wl["Weapon_R"][:3, 3]
    return 1000.0 * 0.6 * np.array([_hinge((h[0] - 0.02) - ua[0]), _hinge(ua[1] - (h[1] - 0.12))])


def keep_left_limited(wl):
    return np.concatenate([keep_left(wl), joint_limits(wl, "L"), sleeve_offscreen(wl, "L")])


def keep_right_limited(wl):
    return np.concatenate([keep_right(wl), joint_limits(wl, "R")])


from straight import straight_residual, screen_angles


def upper_arm_rises(wl, a_min=38.0, a_max=100.0, w=0.8):
    a = screen_angles(wl, "L")[0]
    return np.array([max(0.0, a_min - a) * w, max(0.0, a - a_max) * w])


def left_extra(w_straight=0.6):
    if w_straight <= 0:
        return keep_left_limited
    return lambda wl: np.concatenate([keep_left_limited(wl), straight_residual(wl, w_bend=w_straight), upper_arm_rises(wl)])


# ---------------------------------------------------------------- solve one frame
def fore_hand(Wn):
    return Wn["Offhand"]


REF = None


def solve_pose(spec, xR=None, xL=None, ref=None, base_pose=None):
    """spec: dict(place, trig, charge, hopper(4x4 local | None), lh(Wn)->4x4, lf (curls dict | float),
    lopen (0..1 blend toward the flat HexSniper left hand), rf, rfi, straight, wrotL, regL, on_grip)."""
    ref = ref if ref is not None else REF
    pose = dict(base_pose if base_pose is not None else ref)
    pose["FP_Viewmodel"] = V0
    pose["Hips"] = HEX["Hips"]
    W = arms.world(pose)
    pl = spec["place"]
    G = gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    tgtR = normalized(G @ np.linalg.inv(S_ROOT) @ np.linalg.inv(M_FP))
    pose, xR, eR, rR = ikR.solve(pose, W, tgtR, ref, w_rot=1.0, reg_rot=spec.get("regR", [0.10, 0.02, 0.02]),
                                 reg_trans=0.02, x0=xR, extra=keep_right_limited)
    W = arms.world(pose)
    Ga = weapon_root_world(W, M_FP)
    Wn = wd.world_nodes(Ga, spec.get("trig", 0.0), spec.get("charge", 0.0), spec.get("hopper"))
    tgtL = normalized(spec["lh"](Wn))
    pose0 = pose
    exL = left_extra(spec.get("straight", 0.6))
    wrot_default = 1.1 if spec["lh"] is fore_hand else 0.5
    pose, xL1, eL, rL = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", wrot_default),
                                  reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=xL, extra=exL)
    on_grip = spec.get("on_grip", spec["lh"] is fore_hand)
    if (on_grip and rL > 1.0 or rL > 4.0) and xL is not None:
        p2, x2, e2, r2 = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", wrot_default),
                                   reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=None, extra=exL)
        if r2 < rL:
            pose, xL1, eL, rL = p2, x2, e2, r2
    xL = xL1
    lf = spec.get("lf", FORE_CURLS)
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    lo = float(spec.get("lopen", 0.0))
    for n in FINGERS_L:
        qg = finger_q(n, lfs.get(n, 1.0))
        if lo > 0:
            from rig import slerp
            qg = slerp(qg, open_q(n, spec.get("lopen_curl", 0.4)), lo)
        pose[n] = (REST[n][0], qg, REST[n][2])
    rf = spec.get("rf", 1.0)
    for n in FINGERS_R:
        s = spec.get("rfi", rf) if n == "Index_R_1" else rf
        pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
    ws = (spec.get("trig", 0.0), spec.get("charge", 0.0), spec.get("hopper"))
    return pose, ws, xR, xL, (eR, rR, eL, rL)


def init_ref():
    global REF
    REF = None
    p, _, _, _, _ = solve_pose(dict(place=HOLD, lh=fore_hand), ref=HEX, base_pose=HEX)
    REF = p
    return p


init_ref()


# ---------------------------------------------------------------- hand frames on the hopper / charging handle
def _rz4(deg):
    M = np.eye(4); M[:3, :3] = rotz(deg); return M


def hopper_grab_local():
    """Left hand grabbing the hopper tube from the LEFT side, fingers over the top, forearm from below:
    the fitted foregrip fist turned -90° about Z (vertical post -> horizontal tube), pushed out to the tube radius.
    Returned in HOPPER-local weapon units."""
    F = OFFHAND_FIT_V1.copy()                                                         # (v1 fist: unchanged reload grabs)
    c = np.array([wd.FOREGRIP_X, 0.5 * (wd.FOREGRIP_Y0 + wd.FOREGRIP_Y1), 0.0])      # grip centre
    Fl = trs(-c) @ F                                                                  # relative to the grip centre
    Fr = _rz4(-90.0) @ Fl                                                             # post axis -> tube axis (-X)
    Fr[:3, 3] += np.array([-0.95, 0.0, wd.TUBE_R - wd.FOREGRIP_HALF[1] + 0.02])       # front part of the tube, radial push
    return Fr


wd.HOPPER_GRAB_LOCAL = hopper_grab_local()


def charge_local():
    """Fingers hooked on the charging-handle knob (left side), same hand orientation as on the hopper, smaller reach."""
    F = hopper_grab_local().copy()
    F[:3, 3] = F[:3, 3] - np.array([-0.95, 0.0, 0.0])                                 # back to the knob origin
    F[:3, 3] += np.array([0.05, -0.02, 0.0]) + np.array([0.0, 0.0, 0.40 - wd.TUBE_R])  # knob sticks out ~0.19 u
    return F


wd.CHARGE_LOCAL = charge_local()


def hopper_hand(Wn):
    return Wn["HopperGrab"]


def charge_hand(Wn):
    return Wn["Charge"]


def slap_hand(Wn, bounce=0.0):
    """Palm flat on top of the (seated) hopper, fingers toward the muzzle."""
    f = np.array([-1.0, 0.0, -0.25]); f /= np.linalg.norm(f)
    n = np.array([0.0, -1.0, 0.0])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, 3] = np.array([-0.55, wd.TUBE_R + 0.62 + bounce, 0.15])
    return Wn["Hopper"] @ F


REF_WL = None


def _ref_wl():
    global REF_WL
    if REF_WL is None:
        REF_WL = normalized(arms.world(REF)["Weapon_L"])
    return REF_WL


def rest_hand(_Wn=None):
    """Left hand dropped out of the way (one-handed inspect / equip)."""
    M = np.eye(4); R = _ref_wl()
    M[:3, :3] = R[:3, :3]
    M[:3, 3] = R[:3, 3] + np.array([-0.12, -0.24, 0.10])
    return M


def mix(*pairs):
    def fn(Wn):
        M = normalized(pairs[0][1](Wn))
        for w, f in pairs[1:]:
            if w > 0:
                M = blend_frames(M, normalized(f(Wn)), w)
        return M
    return fn


# ---------------------------------------------------------------- clips
def breathing(t, period, amp=1.0):
    ph = 2 * np.pi * t / period
    return dict(grip=amp * np.array([0.0008 * np.sin(ph + 0.6), 0.0018 * np.sin(ph), 0.0006 * np.sin(ph + 2.2)]),
                pitch=amp * 0.55 * np.sin(ph + 1.1), roll=amp * 0.45 * np.sin(ph + 2.0), yaw=amp * 0.3 * np.sin(ph + 0.4))


def clip_hold(t):
    return dict(place=place(HOLD, breathing(t, 2.0)), lh=fore_hand)


def clip_aim(t):
    return dict(place=place(AIM, breathing(t, 2.0, 0.5)), lh=fore_hand)


RUN_BASE = place(HOLD, dict(grip=(0.012, -0.028, 0.03), yaw=7.0, pitch=-9.0, roll=-17.0))


def clip_run(t):
    ph = 2 * np.pi * t / 0.8
    d = dict(grip=(0.008 * np.sin(ph), 0.010 * np.cos(2 * ph) - 0.002, 0.004 * np.cos(2 * ph)),
             yaw=1.8 * np.sin(ph), pitch=2.2 * np.cos(2 * ph + 0.4), roll=3.0 * np.sin(ph + 0.3))
    return dict(place=place(RUN_BASE, d), lh=fore_hand)


def clip_raise(t, dur=0.3):
    return dict(place=lerp_place(HOLD, AIM, ease(t / dur, "io")), lh=fore_hand)


def clip_lower(t, dur=0.3):
    return dict(place=lerp_place(AIM, HOLD, ease(t / dur, "io")), lh=fore_hand)


# --- automatic fire: a 0.1 s LOOP (600 rpm) + a settle clip when the trigger is released
FIRE_PERIOD = 0.1
_KICK1 = Track([(0, 0.0), (0.018, 1.0, "out"), (0.060, 0.28, "io"), (FIRE_PERIOD, 0.0, "io")])
SUSTAIN = dict(grip=(0.0015, 0.003, 0.012), pitch=1.8, roll=0.5, yaw=-0.3)   # gun pushed back while firing (v3: calmer)
TRIG_HELD = 17.0
CH_KICK = Track([(0, 0.0), (0.012, 0.75, "out"), (0.055, 0.0, "in2"), (FIRE_PERIOD, 0.0)])


def kick_offsets(k, a=1.0):
    # v3: per-shot kick ~45 % of v2 (the 10 Hz loop read as a vibration)
    return dict(grip=(0.001 * k * a, 0.0022 * k * a, 0.009 * k * a), pitch=1.8 * k * a, roll=0.5 * k * a, yaw=-0.25 * k * a)


def fire_jitter(t):
    """Tiny shot-to-shot variation (the loop is 0.1 s, the noise period is the loop period -> seamless)."""
    ph = 2 * np.pi * t / FIRE_PERIOD
    return dict(yaw=0.10 * np.sin(ph + 0.7), roll=0.12 * np.sin(ph + 2.1))


def clip_fire(t):
    k = float(_KICK1(t % FIRE_PERIOD))
    d = add(SUSTAIN, kick_offsets(k), fire_jitter(t))
    return dict(place=place(HOLD, d), trig=TRIG_HELD, charge=float(CH_KICK(t % FIRE_PERIOD)), rfi=1.35, lh=fore_hand)


FIRE_END = Track([(0, 1.0), (0.06, 1.25, "out"), (0.30, 0.0, "io")])
TRIG_END = Track([(0, TRIG_HELD), (0.05, TRIG_HELD, "lin"), (0.14, 0.0, "io")])
INDEX_END = Track([(0, 1.35), (0.05, 1.35, "lin"), (0.14, 1.0, "io")])


def clip_fire_end(t):
    s = float(FIRE_END(t))
    d = add(dict(grip=np.asarray(SUSTAIN["grip"]) * s, pitch=SUSTAIN["pitch"] * s, roll=SUSTAIN["roll"] * s, yaw=SUSTAIN["yaw"] * s))
    return dict(place=place(HOLD, d), trig=float(TRIG_END(t)), rfi=float(INDEX_END(t)), lh=fore_hand)


# --- reload: swap the hopper (2.45 s) — thumb on the release, the empty hopper is pulled off and dropped,
# the hand fetches a full one (off screen), seats it (click), slaps it, then racks the charging handle.
RL = dict(off0=0.06, reach=0.30, press=0.40, unclip=0.46, lift=0.62, release=0.78, down=0.95, pick=1.10, up=1.30,
          align=1.42, seat=1.52, slap0=1.58, slap=1.64, slap1=1.72, ch0=1.88, ch1=1.98, ch2=2.03, ret=2.30, end=2.45)
RELOAD_GUN = Track([(0, np.zeros(6)),
                    (RL["reach"], [-0.020, 0.010, 0.010, 10.0, 4.0, -24.0], "io"),
                    (RL["lift"], [-0.024, 0.012, 0.012, 11.0, 5.0, -26.0], "io"),
                    (RL["release"], [-0.018, 0.006, 0.008, 8.0, 3.0, -18.0], "io"),
                    (RL["pick"], [-0.014, 0.004, 0.006, 6.0, 2.0, -14.0], "io"),
                    (RL["align"], [-0.022, 0.010, 0.010, 10.0, 4.0, -24.0], "io"),
                    (RL["seat"], [-0.022, 0.002, 0.010, 10.0, 2.5, -24.0], "out"),
                    (RL["slap1"], [-0.020, 0.008, 0.010, 9.0, 3.5, -22.0], "io"),
                    (RL["ch1"], [-0.014, 0.006, 0.006, 6.0, 2.0, -14.0], "io"),
                    (RL["ret"], [-0.002, 0.001, 0.001, 1.0, 0.5, -2.0], "io"),
                    (RL["end"], np.zeros(6), "io")])
SLAP_JOLT = Track([(RL["slap"] - 0.001, 0.0), (RL["slap"] + 0.025, 1.0, "out"), (RL["slap"] + 0.14, 0.0, "io")])
SEAT_JOLT = Track([(RL["seat"] - 0.001, 0.0), (RL["seat"] + 0.02, 1.0, "out"), (RL["seat"] + 0.12, 0.0, "io")])
CHARGE_RL = Track([(0, 0.0), (RL["ch0"], 0.0), (RL["ch1"], 1.0, "io"), (RL["ch2"] - 0.012, 1.0, "lin"), (RL["ch2"] + 0.03, 0.0, "in2")])

# hopper keys: ("local", [dx,dy,dz, rx,ry,rz]) = offset to the seated hopper in ROOT units / degrees,
#              ("cam",  [x,y,z, rx,ry,rz])   = camera-space target (metres) for the off-screen part.
HOPPER_KEYS = [(RL["press"], "local", [0, 0, 0, 0, 0, 0]),
               (RL["unclip"], "local", [0.0, 0.14, 0.02, 3, 0, 0]),
               (RL["lift"], "local", [-0.25, 0.55, 1.10, 28, 0, 6]),
               (RL["release"], "cam", [-0.12, -0.22, -0.40, 55, 10, 25]),
               (RL["down"], "cam", [-0.18, -0.56, -0.32, 70, 10, 30]),
               (RL["pick"], "cam", [-0.16, -0.47, -0.36, 55, 5, 20]),
               (RL["up"], "local", [0.10, 0.85, 1.00, 24, 0, 4]),
               (RL["align"], "local", [0.0, 0.30, 0.16, 5, 0, 0]),
               (RL["seat"], "local", [0, 0, 0, 0, 0, 0])]


def _euler(v):
    return Rot.from_euler("XYZ", v, degrees=True).as_matrix()


def hopper_local_at(t, G_of_t):
    """Hopper node matrix in ROOT space at time t (None = seated). G_of_t(t): root world matrix (camera space)."""
    if t <= RL["press"] or t >= RL["seat"]:
        return None
    keys = []
    for tk, kind, v in HOPPER_KEYS:
        v = np.asarray(v, float)
        if kind == "local":
            p = wd.HOPPER_C + v[:3]; R = _euler(v[3:])
        else:
            G = G_of_t(tk); Gn = normalized(G); s = float(np.linalg.norm(G[:3, 0]))
            Gi = np.linalg.inv(G)
            p = (Gi @ np.r_[v[:3], 1.0])[:3]
            R = Gn[:3, :3].T @ _euler(v[3:])
        keys.append((tk, p, R))
    for i in range(len(keys) - 1):
        t0, p0, R0 = keys[i]; t1, p1, R1 = keys[i + 1]
        if t0 <= t <= t1:
            u = ease((t - t0) / (t1 - t0), "io" if i not in (2,) else "sio")
            # Catmull-Rom-ish position through the neighbours for a rounder arc
            pm = keys[max(i - 1, 0)][1]; pp = keys[min(i + 2, len(keys) - 1)][1]
            m0 = (p1 - pm) * 0.5; m1 = (pp - p0) * 0.5
            h00 = 2 * u ** 3 - 3 * u ** 2 + 1; h10 = u ** 3 - 2 * u ** 2 + u; h01 = -2 * u ** 3 + 3 * u ** 2; h11 = u ** 3 - u ** 2
            p = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
            q = Rot.from_matrix(np.stack([R0, R1])) if False else None
            from rig import slerp
            qq = slerp(mat3_to_quat(R0), mat3_to_quat(R1), u)
            M = np.eye(4); M[:3, :3] = quat_to_mat3(qq); M[:3, 3] = p
            return M
    return None


def hopper_visible(t):
    return not (RL["release"] + 1e-4 < t < RL["pick"] - 1e-4)


def reload_place(t):
    v = RELOAD_GUN(t)
    d = dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])
    s = float(SLAP_JOLT(t)); k = float(SEAT_JOLT(t))
    jig = dict(grip=(0.0, -0.006 * s - 0.004 * k, 0.0), pitch=-1.6 * s - 1.0 * k, roll=0.6 * s)
    return place(HOLD, add(d, jig))


def _G_of(t):
    pl = reload_place(t)
    return gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])


def clip_reload(t):
    pl = reload_place(t)
    hop = hopper_local_at(t, _G_of)
    charge = float(CHARGE_RL(t))
    tr = 0.0
    if t < RL["off0"]:
        lh = fore_hand; lf = FORE_CURLS; w = 1.0
    elif t < RL["reach"]:
        u = ease((t - RL["off0"]) / (RL["reach"] - RL["off0"]), "io")
        lh = mix((1, fore_hand), (u, hopper_hand)); lf = gripmix(1 - u, 0.6 + 0.8 * u); w = 1 - u; tr = np.sin(np.pi * u)
    elif t < RL["seat"] + 0.03:
        lh = hopper_hand; lf = {"Index_L_1": 1.4, "Middle_L_1": 1.4, "Ring_L_1": 1.6, "Thumb_L_1": 1.2}; w = 0.0
        if RL["press"] - 0.04 < t < RL["unclip"]:
            lf = dict(lf, Thumb_L_1=1.2 + 0.6 * np.sin(np.pi * (t - RL["press"] + 0.04) / (RL["unclip"] - RL["press"] + 0.04)))
    elif t < RL["slap"]:
        u = ease((t - RL["seat"] - 0.03) / (RL["slap"] - RL["seat"] - 0.03), "io")
        up = 0.20 * np.sin(np.pi * u)
        lh = mix((1, hopper_hand), (u, lambda Wn, b=up: slap_hand(Wn, b))); lf = 1.4 * (1 - u) + 0.1 * u; w = 0.0; tr = np.sin(np.pi * u)
    elif t < RL["slap1"]:
        lh = slap_hand; lf = 0.1; w = 0.0
    elif t < RL["ch0"]:
        u = ease((t - RL["slap1"]) / (RL["ch0"] - RL["slap1"]), "io")
        lh = mix((1, slap_hand), (u, charge_hand)); lf = 0.1 + 1.3 * u; w = 0.0; tr = np.sin(np.pi * u)
    elif t < RL["ch2"]:
        lh = charge_hand; lf = 1.4; w = 0.0
    elif t < RL["ret"]:
        u = ease((t - RL["ch2"]) / (RL["ret"] - RL["ch2"]), "io")
        # the knob snapped forward: the hand stays where it was (released), then goes back to the foregrip
        Wback = None
        lh = mix((1, lambda Wn: charge_hand(dict(Wn, Charge=Wn["ChargingHandle"] @ trs([wd.CH_TRAVEL, 0, 0]) @ wd.CHARGE_LOCAL))),
                 (u, fore_hand))
        lf = gripmix(u, 0.6); w = u; tr = np.sin(np.pi * u)
    else:
        lh = fore_hand; lf = FORE_CURLS; w = 1.0
    return dict(place=pl, hopper=hop, charge=charge, lh=lh, lf=lf, rfi=0.9, wrotL=0.6 * (1.0 - 0.9 * tr),
                on_grip=w > 0.999, straight=0.25 + 0.35 * w,
                regL=[0.12 * w + 0.012 * (1 - w), 0.02 * w + 0.008 * (1 - w), 0.02 * w + 0.008 * (1 - w)])


# --- inspect (3.6 s, one-handed): left side, then the hopper from above (balls rolling), back to the grip
INSPECT_GUN = Track([(0, np.zeros(6)),
                     (0.30, [0.004, -0.004, 0.0, -2.0, -1.0, 4.0], "io"),
                     (0.95, [-0.070, 0.050, 0.080, 34.0, 6.0, -10.0], "io"),
                     (1.60, [-0.073, 0.052, 0.084, 39.0, 4.0, -15.0], "io"),
                     (2.30, [-0.050, 0.030, 0.070, -4.0, 22.0, 34.0], "io"),
                     (2.75, [-0.048, 0.028, 0.068, -6.0, 24.0, 39.0], "io"),
                     (3.30, np.zeros(6), "io"),
                     (3.60, np.zeros(6), "io")])
INSPECT_LH = Track([(0, 0), (0.12, 0), (0.42, 1.0, "io"), (3.02, 1.0, "lin"), (3.38, 0.0, "io")])


def clip_inspect(t):
    v = INSPECT_GUN(t)
    wob = dict(pitch=0.6 * noise1(t, 11, 3.0), roll=0.8 * noise1(t, 12, 2.6)) if 0.9 < t < 2.9 else {}
    d = add(dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5]), wob)
    u = float(INSPECT_LH(t))
    lh = mix((1, fore_hand), (u, rest_hand))
    lf = gripmix(1 - u, 0.45)
    rfi = 1.0 - 0.45 * float(Track([(0, 0), (0.25, 1.0, "io"), (3.1, 1.0, "lin"), (3.4, 0.0, "io")])(t))
    return dict(place=place(HOLD, d), lh=lh, lf=lf, rfi=rfi, wrotL=0.2 + 0.3 * (1 - u), on_grip=u < 1e-3,
                straight=0.6 * (1 - u))


# --- equip / unequip
EQUIP_GUN = Track([(0, [0.04, -0.21, 0.07, 10.0, -42.0, 32.0]), (0.40, [0.0, 0.006, 0.0, 0.0, 2.5, -1.5], "out"),
                   (0.55, np.zeros(6), "io")])
EQUIP_LH = Track([(0, 1.0), (0.22, 1.0, "lin"), (0.45, 0.0, "io")])


def clip_equip(t):
    v = EQUIP_GUN(t)
    u = float(EQUIP_LH(t))
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])),
                lh=mix((1, fore_hand), (u, rest_hand)), lf=gripmix(1 - u, 0.5), wrotL=0.2 + 0.3 * (1 - u),
                on_grip=u < 1e-3, straight=0.6 * (1 - u))


UNEQUIP_GUN = Track([(0, np.zeros(6)), (0.35, [0.04, -0.22, 0.07, 10.0, -42.0, 32.0], "in2")])
UNEQUIP_LH = Track([(0, 0.0), (0.18, 1.0, "io")])


def clip_unequip(t):
    v = UNEQUIP_GUN(t)
    u = float(UNEQUIP_LH(t))
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])),
                lh=mix((1, fore_hand), (u, rest_hand)), lf=gripmix(1 - u, 0.5), wrotL=0.2 + 0.3 * (1 - u),
                on_grip=u < 1e-3, straight=0.6 * (1 - u))


CLIPS = {
    # name: (spec fn, duration, fps, loop)
    "FP_PaintballRifle_Hold": (clip_hold, 2.0, 30, True),
    "FP_PaintballRifle_Run": (clip_run, 0.8, 30, True),
    "FP_Aim_PaintballRifle": (clip_aim, 2.0, 30, True),
    "FP_Raise_PaintballRifle": (clip_raise, 0.3, 120, False),
    "FP_Lower_PaintballRifle": (clip_lower, 0.3, 120, False),
    "FP_Fire_PaintballRifle": (clip_fire, FIRE_PERIOD, 120, True),
    "FP_FireEnd_PaintballRifle": (clip_fire_end, 0.30, 60, False),
    "FP_Reload_PaintballRifle": (clip_reload, RL["end"], 60, False),
    "FP_Inspect_PaintballRifle": (clip_inspect, 3.6, 60, False),
    "FP_Equip_PaintballRifle": (clip_equip, 0.55, 60, False),
    "FP_Unequip_PaintballRifle": (clip_unequip, 0.35, 60, False),
}


def bake(name, verbose=True):
    fn, dur, fps, loop = CLIPS[name]
    n = int(round(dur * fps)) + 1
    frames, wstate, errs = [], [], []
    xR = xL = None
    for i in range(n):
        t = min(i / fps, dur)
        spec = fn(t)
        pose, ws, xR, xL, err = solve_pose(spec, xR, xL)
        frames.append({b: pose[b] for b in sorted(set(c[0] for c in CHANNELS))})
        wstate.append((ws[0], ws[1], None if ws[2] is None else np.array(ws[2]), hopper_visible(t) if fn is clip_reload else True))
        errs.append(err)
    errs = np.array(errs)
    if verbose:
        print(f"{name:32s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
              f"maxR={errs[:, 0].max() * 1000:.2f}mm/{errs[:, 1].max():.2f}deg", flush=True)
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=wstate, errors=errs)


if __name__ == "__main__":
    import os
    names = sys.argv[1:] or list(CLIPS)
    OUT = os.environ.get("OUT", "fp_clips.pkl")
    try:
        out = pickle.load(open(OUT, "rb"))
    except Exception:
        out = {}
    for nm in names:
        out[nm] = bake(nm)
        out["_meta"] = dict(mount=M_FP, hold=HOLD, aim=AIM, offhand=wd.OFFHAND_LOCAL, channels=CHANNELS)
        pickle.dump(out, open(OUT, "wb"))
