"""FP pose-library authoring for the Water FAMAS (IK-driven, same 20-channel set as the HexSniper).

ONE-HANDED weapon: the right hand holds the pistol grip (the Paintball Rifle grip, same mount / same right-hand pose);
the left arm stays down, off screen, and only comes in for the reload (unscrew the rear cap, pour a water bottle,
screw the cap back). Every frame: the weapon placement is authored in CAMERA space, the right arm is solved so
Weapon_R carries the weapon there, then the left arm is solved against the ACTUAL cap / bottle transforms.
"""
import pickle, sys, json
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from fp_common import arms, hold_ref, mount_from, weapon_root_world, S_ROOT, render
import weapon_def as wd
from ik import ChainIK
from anim_util import Track, ease, normalized, frame_from, blend_frames, rotz, rotx, roty, noise1
from rig import trs, qaxis, qmul, quat_to_mat3, mat3_to_quat, qnorm
from twist import swing_twist as _swing_twist

# ---------------------------------------------------------------- setup (= Paintball Rifle: same grip, same mount)
MOUNT_OFFSET = (0.04, -0.24, 0.0)
M_FP = mount_from(offset_local=MOUNT_OFFSET)
GUN_SCALE = wd.ROOT_SCALE * float(np.linalg.norm(M_FP[:3, 0]))  # world metres per weapon unit (≈0.076)
HOLD = dict(grip=np.array([0.25, -0.255, -0.49]), yaw=26.0, pitch=7.0, roll=-13.0)     # diagonal: tank + left side visible
AIM = dict(grip=np.array([0.19, -0.245, -0.47]), yaw=8.0, pitch=2.0, roll=-4.0)       # raised, nozzle toward the crosshair

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


def finger_q(name, s):
    """Curl a finger with the HexSniper grip curl axis (both hands): s=0 rest, 1 HexSniper curl, 2 twice."""
    rq = REST[name][1]
    hq = HEX[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


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
    return np.concatenate([joint_limits(wl, "L"), sleeve_offscreen(wl, "L")])


def keep_right_limited(wl):
    return np.concatenate([keep_right(wl), joint_limits(wl, "R")])


# ---------------------------------------------------------------- left hand targets
LEFT_DOWN_POS = np.array([-0.03, -0.55, -0.56])              # hand hanging below the screen (camera space)
LEFT_DOWN_R = None                                            # its NATURAL orientation (solved once, position only)


def left_down(_Wn=None):
    """Left hand out of the way, below the bottom edge of the screen (one-handed weapon)."""
    M = np.eye(4)
    M[:3, :3] = LEFT_DOWN_R if LEFT_DOWN_R is not None else normalized(arms.world(HEX)["Weapon_L"])[:3, :3]
    M[:3, 3] = LEFT_DOWN_POS
    return M


def mix(*pairs):
    def fn(Wn):
        M = normalized(pairs[0][1](Wn))
        for w, f in pairs[1:]:
            if w > 0:
                M = blend_frames(M, normalized(f(Wn)), w)
        return M
    return fn


# ---------------------------------------------------------------- solve one frame
REF = None
LEFT_IDLE = None                                           # set below from fp_left_idle.json (after init_ref)
LEFT_IDLE_CURL = 0.6


def solve_pose(spec, xR=None, xL=None, ref=None, base_pose=None):
    """spec: dict(place, trig, cap_turn, hinge, bottle(4x4 | None), level, lh(Wn)->4x4 (default: left_down),
    lf (curls dict | float), rf, rfi, wrotL, regL)."""
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
    ws = dict(trig=spec.get("trig", 0.0), cap_turn=spec.get("cap_turn", 0.0), hinge=spec.get("hinge", 0.0),
              bottle=spec.get("bottle"), level=spec.get("level", 1.0))
    Wn = wd.world_nodes(Ga, ws["trig"], ws["cap_turn"], ws["hinge"], ws["bottle"])
    if "lh" not in spec and LEFT_IDLE is not None:         # idle: the left arm hangs along the body (fp_idle_left.py)
        pose.update(LEFT_IDLE)
        lfs = {n: spec.get("lf", LEFT_IDLE_CURL) for n in FINGERS_L}
        for n in FINGERS_L:
            pose[n] = (REST[n][0], finger_q(n, lfs[n]), REST[n][2])
        rf = spec.get("rf", 1.0)
        for n in FINGERS_R:
            s = spec.get("rfi", rf) if n == "Index_R_1" else rf
            pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
        return pose, ws, xR, None, (eR, rR, 0.0, 0.0)
    lh = spec.get("lh", left_down)
    tgtL = normalized(lh(Wn))
    pose0 = pose
    pose, xL1, eL, rL = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 0.25),
                                  reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=xL, extra=keep_left_limited)
    if rL > 4.0 and xL is not None and spec.get("wrotL", 0.25) > 0.5:
        p2, x2, e2, r2 = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 0.25),
                                   reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=None, extra=keep_left_limited)
        if r2 < rL:
            pose, xL1, eL, rL = p2, x2, e2, r2
    xL = xL1
    lf = spec.get("lf", 0.6)
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    for n in FINGERS_L:
        pose[n] = (REST[n][0], finger_q(n, lfs.get(n, 1.0)), REST[n][2])
    rf = spec.get("rf", 1.0)
    for n in FINGERS_R:
        s = spec.get("rfi", rf) if n == "Index_R_1" else rf
        pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
    return pose, ws, xR, xL, (eR, rR, eL, rL)


def init_ref():
    """Reference pose: right hand on the grip, left arm hanging with a natural (untwisted) hand: solved on position
    only, then that hand orientation becomes the left_down target."""
    global REF, LEFT_DOWN_R
    REF = None
    p, _, _, _, _ = solve_pose(dict(place=HOLD, wrotL=0.0), ref=HEX, base_pose=HEX)
    LEFT_DOWN_R = normalized(arms.world(p)["Weapon_L"])[:3, :3]
    p, _, _, _, _ = solve_pose(dict(place=HOLD), ref=p, base_pose=p)
    REF = p
    return p


init_ref()


# ---------------------------------------------------------------- idle left arm: hanging along the body, out of the FP view
L_BONES = ("Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L")


def _load_left_idle(path="fp_left_idle.json"):
    """Solved by fp_idle_left.py: shoulder beside / just behind the eye, arm hanging straight down (nothing of the arm or
    of its long FP sleeve can enter the viewmodel frustum). Used by every clip except the reload, and as the reload's
    "down" pose (the start / end of its left-arm moves)."""
    js = json.load(open(path))
    return {b: (np.array(js[b]["t"], float), np.array(js[b]["q"], float), np.array(js[b]["s"], float)) for b in L_BONES}, float(js["curl"])


LEFT_IDLE, LEFT_IDLE_CURL = _load_left_idle()
REF.update(LEFT_IDLE)


# ---------------------------------------------------------------- left-hand frames on the cap / on the bottle
U_FP = GUN_SCALE                                                   # metres per weapon unit (FP)
WL_IN_HAND = trs(*REST["Weapon_L"])                                # Weapon_L relative to Hand_L (metres)
PALM_PT = np.array([0.033, 0.035, 0.0])                            # palm-surface centre, Hand_L local (metres)


def cap_grab_local(phi_deg=0.0, lift=0.0):
    """CLAW on the cap end: palm on the outer face (cap-local +X is outward), fingers over the rim, turned by phi
    about the cap axis. Returned as the Weapon_L frame in CAP-local weapon units. lift: palm off the face (units)."""
    ph = np.radians(phi_deg)
    Xh = np.array([-1.0, 0.0, 0.0])                                # palm normal -> into the cap
    Yh = np.array([0.0, np.cos(ph), np.sin(ph)])                   # fingers across the face
    Zh = np.cross(Xh, Yh)
    R = np.stack([Xh, Yh, Zh], 1)
    H = np.eye(4); H[:3, :3] = R
    face = np.array([(0.19 + lift) * U_FP + 0.004, 0.0, 0.0])      # just above the outer face (metres, cap-local)
    H[:3, 3] = face - R @ PALM_PT
    WL = H @ WL_IN_HAND
    F = np.eye(4); F[:3, :3] = normalized(WL)[:3, :3]; F[:3, 3] = WL[:3, 3] / U_FP
    return F


_PB = json.load(open("pb_fist_v2.json"))
_PB_FIST = np.array(_PB["offhand_local"], float)
_PB_FIST_CENTRE = np.array([-1.6516, -1.002, 0.0])                # Paintball Rifle foregrip centre (same units)
FIST_CURLS = {k: float(v) for k, v in _PB["curls"].items()}
BOTTLE_BAND = np.array([0.0, -0.09, 0.17])                          # bottle-local grip band centre, pushed out to the bigger radius
BOTTLE_CURLS = {"Index_L_1": 0.95, "Middle_L_1": 1.1, "Ring_L_1": 1.0, "Thumb_L_1": 1.3}


def bottle_grab_local():
    """The Paintball Rifle v2 foregrip fist (closed around a vertical 4 cm post) moved onto the bottle band:
    bottle axis = +Y, same radius as the foregrip."""
    return trs(BOTTLE_BAND) @ trs(-_PB_FIST_CENTRE) @ _PB_FIST


wd.BOTTLE_GRAB_LOCAL = bottle_grab_local()
wd.CAP_GRAB_LOCAL = cap_grab_local(0.0)


def cap_hand(phi, lift=0.0):
    return lambda Wn: Wn["Cap"] @ cap_grab_local(phi, lift)


def cap_push(phi, lift=0.0):
    """Claw kept in its CLOSED-cap orientation, carried along with the cap centre while the retainer swings
    (pushing the cap open / closed without flipping the wrist)."""
    def fn(Wn):
        Cc = Wn["Tank"] @ wd.node_locals()["CapHinge"] @ wd.node_locals()["Cap"]     # closed cap (hinge 0, turn 0)
        M = Cc @ cap_grab_local(phi, lift)
        M = M.copy(); M[:3, 3] += Wn["Cap"][:3, 3] - Cc[:3, 3]
        return M
    return fn


def bottle_hand(Wn):
    return Wn["BottleGrab"]


# ---------------------------------------------------------------- clips: hold / aim / run / raise / lower
def breathing(t, period, amp=1.0):
    ph = 2 * np.pi * t / period
    return dict(grip=amp * np.array([0.0008 * np.sin(ph + 0.6), 0.0018 * np.sin(ph), 0.0006 * np.sin(ph + 2.2)]),
                pitch=amp * 0.55 * np.sin(ph + 1.1), roll=amp * 0.45 * np.sin(ph + 2.0), yaw=amp * 0.3 * np.sin(ph + 0.4))


def clip_hold(t):
    return dict(place=place(HOLD, breathing(t, 2.0)))


def clip_aim(t):
    return dict(place=place(AIM, breathing(t, 2.0, 0.5)))


RUN_BASE = place(HOLD, dict(grip=(0.012, -0.03, 0.03), yaw=6.0, pitch=-8.0, roll=-14.0))


def clip_run(t):
    ph = 2 * np.pi * t / 0.8
    d = dict(grip=(0.009 * np.sin(ph), 0.011 * np.cos(2 * ph) - 0.002, 0.004 * np.cos(2 * ph)),
             yaw=2.0 * np.sin(ph), pitch=2.4 * np.cos(2 * ph + 0.4), roll=3.2 * np.sin(ph + 0.3))
    return dict(place=place(RUN_BASE, d))


def clip_raise(t, dur=0.25):
    return dict(place=lerp_place(HOLD, AIM, ease(t / dur, "io")))


def clip_lower(t, dur=0.25):
    return dict(place=lerp_place(AIM, HOLD, ease(t / dur, "io")))


# --- fire: FAMAS-style 3-jet BURST per trigger pull (jets at 0, 0.075, 0.15 s), then settle (whole clip 0.42 s)
JET_TIMES = (0.0, 0.075, 0.15)
BURST_DUR = 0.42
TRIG_PULL = 16.0


def _kick(t):
    k = 0.0
    for j, tj in enumerate(JET_TIMES):
        u = t - tj
        if u < 0: continue
        a = 1.0 - 0.15 * j
        k += a * (np.clip(u / 0.016, 0, 1) if u < 0.016 else np.exp(-(u - 0.016) / 0.05))
    return k


BURST_PUSH = Track([(0, 0.0), (0.04, 1.0, "out"), (0.19, 1.0, "lin"), (BURST_DUR, 0.0, "io")])
TRIG_BURST = Track([(0, 0.0), (0.03, TRIG_PULL, "out"), (0.19, TRIG_PULL, "lin"), (0.27, 0.0, "io")])
INDEX_BURST = Track([(0, 1.0), (0.03, 1.35, "out"), (0.19, 1.35, "lin"), (0.27, 1.0, "io")])


def clip_fire(t):
    k = _kick(t); s = float(BURST_PUSH(t))
    d = dict(grip=(0.0008 * s + 0.0006 * k, 0.0012 * s + 0.0014 * k, 0.006 * s + 0.005 * k),
             pitch=0.9 * s + 1.3 * k, roll=0.3 * s + 0.35 * k, yaw=-0.2 * s - 0.15 * k)
    return dict(place=place(HOLD, d), trig=float(TRIG_BURST(t)), rfi=float(INDEX_BURST(t)))


def clip_fire_aim(t):
    k = _kick(t); s = float(BURST_PUSH(t))
    d = dict(grip=(0.0006 * s + 0.0005 * k, 0.001 * s + 0.0012 * k, 0.005 * s + 0.004 * k),
             pitch=0.7 * s + 1.1 * k, roll=0.2 * s + 0.25 * k, yaw=-0.15 * s - 0.1 * k)
    return dict(place=place(AIM, d), trig=float(TRIG_BURST(t)), rfi=float(INDEX_BURST(t)))


# --- reload (3.3 s): unscrew the rear cap, swing it open, pour a water bottle, close + screw, back
RL = dict(reach=0.26, grab=0.32, uns1=0.66, open0=0.70, open1=0.88, away=1.10, bottle_in=1.10, arrive=1.32, pour0=1.44,
          pour1=1.98, untip=2.10, bottle_out=2.30, back=2.48, close1=2.62, screw1=2.86, leave=3.05, end=3.30)
UNS = [-0.10, 0.10, 0.05, -55.0, -10.0, -10.0]                 # cap facing the left hand
POUR = [-0.08, 0.10, 0.03, -30.0, -60.0, -10.0]                # nose down: the filler hole faces up
RELOAD_GUN = Track([(0, np.zeros(6)), (0.24, UNS, "io"), (0.88, UNS, "lin"), (1.22, POUR, "io"), (2.06, POUR, "lin"),
                    (2.36, UNS, "io"), (2.95, UNS, "lin"), (RL["end"], np.zeros(6), "io")])
CAP_PHI = -105.0                                               # claw orientation about the cap axis (centre of the strokes)
# half a turn in 2 wrist strokes, like a jar lid: the claw turns WITH the cap (~90°), lets go, turns back, grabs again
UNSCREW = Track([(0, 0.0), (RL["grab"], 0.0), (0.45, 0.24, "io"), (0.52, 0.24, "lin"), (RL["uns1"], 0.5, "io")])
SCREW = Track([(0, 0.5), (RL["close1"], 0.5), (2.72, 0.26, "io"), (2.78, 0.26, "lin"), (RL["screw1"], 0.0, "io")])
S1, S2 = 0.24 * 180.0, 0.26 * 180.0                            # half strokes (deg): 43.2 / 46.8
REGRIP_LIFT = 0.12


def claw_state(t):
    """(h, lift): claw angle about the cap axis relative to CAP_PHI (deg) and palm lift off the cap (units).
    During a stroke the hand follows the cap exactly (h = start + 360 * turned); between strokes it lets go, turns back
    and grabs again (the cap does not move)."""
    if t < RL["grab"]: return -S1, 0.0
    if t < 0.45: return -S1 + 360.0 * float(UNSCREW(t)), 0.0
    if t < 0.52:
        u = (t - 0.45) / 0.07
        return S1 + (-S2 - S1) * ease(u, "io"), REGRIP_LIFT * np.sin(np.pi * u)
    if t < RL["uns1"]: return -S2 + 360.0 * (float(UNSCREW(t)) - 0.24), 0.0
    if t < 1.5:                                                 # un-twists while pushing the cap aside
        u = ease((t - RL["uns1"]) / (RL["open1"] - RL["uns1"]), "io")
        return S2 * (1 - u), 0.0
    if t < RL["close1"]: return S1, 0.0
    if t < 2.72: return S1 - 360.0 * (0.5 - float(SCREW(t))), 0.0
    if t < 2.78:
        u = (t - 2.72) / 0.06
        return -S1 + (S2 + S1) * ease(u, "io"), REGRIP_LIFT * np.sin(np.pi * u)
    return S2 - 360.0 * (0.26 - float(SCREW(t))), 0.0
HINGE_T = Track([(0, 0.0), (RL["open0"], 0.0), (RL["open1"], 1.0, "io"), (RL["back"], 1.0, "lin"), (RL["close1"], 0.0, "io")])
LEVEL_T = Track([(0, 0.08), (RL["pour0"] + 0.04, 0.08), (RL["pour1"] - 0.02, 1.0, "io")])      # preview only (runtime: ammo)


def cap_turn_at(t):
    return float(UNSCREW(t)) if t < 1.5 else float(SCREW(t))


def flick(t, t0, t1):
    """±12° wiggle of the claw during a 2-flick unscrew / screw."""
    if not (t0 < t < t1): return 0.0
    u = (t - t0) / (t1 - t0)
    return 12.0 * np.sin(2 * np.pi * 2 * u)


def _pour_frames():
    """World (camera-space) bottle frames around the filler hole, from the POUR gun pose."""
    pl = place(HOLD, dict(grip=POUR[:3], yaw=POUR[3], pitch=POUR[4], roll=POUR[5]))
    G = gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    op = (wd.world_nodes(G)["Opening"])[:3, 3]
    return op


OPENING_POUR = _pour_frames()


def _bottle_world(nozzle_or_centre, axis, centre=False):
    """Rigid bottle frame (camera space, metres): +Y = axis toward the nozzle."""
    y = np.asarray(axis, float); y /= np.linalg.norm(y)
    x = np.cross(y, [0.0, 0.0, 1.0]); x /= np.linalg.norm(x)
    z = np.cross(x, y)
    M = np.eye(4); M[:3, :3] = np.stack([x, y, z], 1)
    c = np.asarray(nozzle_or_centre, float)
    M[:3, 3] = c if centre else c - y * wd.BOTTLE_NOZZLE[1] * GUN_SCALE
    return M


_UP = np.array([0.0, 1.0, 0.0])
BOTTLE_KEYS = [  # (t, world frame)
    (RL["bottle_in"], _bottle_world([-0.30, -0.60, -0.42], [0.35, 1.0, 0.1], centre=True)),
    (RL["arrive"], _bottle_world(OPENING_POUR + np.array([-0.05, 0.075, 0.01]), [0.35, 0.5, 0.05])),
    (RL["pour0"], _bottle_world(OPENING_POUR + np.array([-0.008, 0.052, 0.004]), [0.55, -0.72, 0.08])),
    (RL["pour1"], _bottle_world(OPENING_POUR + np.array([-0.004, 0.048, 0.004]), [0.45, -0.85, 0.06])),
    (RL["untip"], _bottle_world(OPENING_POUR + np.array([-0.06, 0.09, 0.01]), [0.35, 0.6, 0.05])),
    (RL["bottle_out"], _bottle_world([-0.30, -0.62, -0.42], [0.3, 1.0, 0.1], centre=True)),
]


def bottle_world_at(t):
    ks = BOTTLE_KEYS
    if t <= ks[0][0]: return ks[0][1]
    for (t0, A0), (t1, A1) in zip(ks, ks[1:]):
        if t <= t1:
            u = ease((t - t0) / (t1 - t0), "io")
            M = blend_frames(A0, A1, u)
            if RL["pour0"] < t < RL["pour1"]:                      # little shake while pouring
                M = M.copy(); M[:3, 3] += np.array([0.0015 * np.sin(t * 38), 0.001 * np.sin(t * 29 + 1), 0.0])
            return M
    return ks[-1][1]


def bottle_visible(t):
    return RL["bottle_in"] - 1e-6 <= t <= RL["bottle_out"] + 1e-6


def bottle_local_at(t, G):
    """Bottle node local matrix (root space, weapon units) for the solved gun G."""
    if not bottle_visible(t): return None
    B = bottle_world_at(t).copy()
    B[:3, :3] = B[:3, :3] * GUN_SCALE
    L = np.linalg.inv(G) @ B
    return L


def reload_place(t):
    v = RELOAD_GUN(t)
    return place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5]))


def clip_reload(t):
    pl = reload_place(t)
    G = gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    ct = cap_turn_at(t); hg = float(HINGE_T(t))
    bot = bottle_local_at(t, G)
    lf = 0.6; wr = 0.25
    h, lift = claw_state(t)
    claw = lambda hh, ll=0.0: cap_push(CAP_PHI + hh, ll)
    # left-hand path
    if t < RL["reach"]:
        u = ease(t / RL["reach"], "io")
        lh = mix((1, left_down), (u, claw(-S1, 0.45))); lf = 0.6 + 0.3 * u; wr = 0.25 + 0.75 * u
    elif t < RL["grab"]:
        u = ease((t - RL["reach"]) / (RL["grab"] - RL["reach"]), "io")
        lh = mix((1, claw(-S1, 0.45)), (u, claw(-S1, 0.0))); lf = 0.9 + 0.3 * u; wr = 1.0
    elif t < RL["open1"]:
        if t < RL["open0"]:
            lh = claw(h, lift); lf = 1.25 - 3.0 * lift; wr = 1.0
        else:                                                  # push the cap aside, the claw rides the retainer
            u = (t - RL["open0"]) / (RL["open1"] - RL["open0"])
            lh = mix((1, claw(h)), (ease(max(0.0, (u - 0.55) / 0.45), "io"), claw(h, 0.6))); lf = 1.2 - 0.5 * u; wr = 1.0 - 0.6 * u
    elif t < RL["away"]:
        u = ease((t - RL["open1"]) / (RL["away"] - RL["open1"]), "io")
        lh = mix((1, claw(0.0, 0.6)), (u, left_down)); lf = 0.7 - 0.1 * u; wr = 0.4 - 0.15 * u
    elif t < RL["bottle_out"]:
        lh = bottle_hand; lf = BOTTLE_CURLS; wr = 1.0
    elif t < RL["back"]:
        # hand leaves with the bottle (off screen), comes back to the open cap
        u = ease((t - RL["bottle_out"]) / (RL["back"] - RL["bottle_out"]), "io")
        lh = mix((1, left_down), (u, claw(S1, 0.3))); lf = 0.6 + 0.4 * u; wr = 0.25 + 0.75 * u
    elif t < RL["close1"]:
        u = ease((t - RL["back"]) / (RL["close1"] - RL["back"]), "io")
        lh = mix((1, claw(S1, 0.3)), (u, claw(S1, 0.0))); lf = 1.0 + 0.15 * u; wr = 1.0
    elif t < RL["screw1"]:
        lh = claw(h, lift); lf = 1.2 - 3.0 * lift; wr = 1.0
    elif t < RL["leave"] + 0.2:
        u = ease((t - RL["screw1"]) / (RL["leave"] + 0.2 - RL["screw1"]), "io")
        lh = mix((1, claw(-S2)), (u, left_down)); lf = 1.15 - 0.55 * u; wr = 1.0 - 0.75 * u
    else:
        lh = left_down
    return dict(place=pl, cap_turn=ct, hinge=hg, bottle=bot, level=float(LEVEL_T(t)), lh=lh, lf=lf, wrotL=wr, rfi=0.9)


# --- inspect (3.6 s, one-handed like the other weapons): left side, then the tank from above with a little shake
#     (the water sloshes — runtime), back
INSPECT_GUN = Track([(0, np.zeros(6)),
                     (0.30, [0.004, -0.004, 0.0, -2.0, -1.0, 4.0], "io"),
                     (0.95, [-0.075, 0.055, 0.075, 36.0, 6.0, -8.0], "io"),
                     (1.55, [-0.078, 0.057, 0.078, 41.0, 4.0, -13.0], "io"),
                     (2.20, [-0.055, 0.035, 0.065, -8.0, 20.0, 36.0], "io"),
                     (2.70, [-0.052, 0.033, 0.063, -10.0, 22.0, 41.0], "io"),
                     (3.30, np.zeros(6), "io"),
                     (3.60, np.zeros(6), "io")])


def clip_inspect(t):
    v = INSPECT_GUN(t)
    wob = dict(pitch=0.6 * noise1(t, 11, 3.0), roll=0.8 * noise1(t, 12, 2.6)) if 0.9 < t < 2.9 else {}
    shake = {}
    if 2.25 < t < 2.65:                                         # 3 quick shakes: the water sloshes in the tank
        u = (t - 2.25) / 0.4
        shake = dict(roll=7.0 * np.sin(2 * np.pi * 3 * u) * np.sin(np.pi * u), grip=(0.0, 0.0, 0.004 * np.sin(2 * np.pi * 3 * u)))
    d = add(dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5]), wob, shake)
    rfi = 1.0 - 0.45 * float(Track([(0, 0), (0.25, 1.0, "io"), (3.1, 1.0, "lin"), (3.4, 0.0, "io")])(t))
    return dict(place=place(HOLD, d), rfi=rfi)


# --- equip / unequip (left arm stays down)
EQUIP_GUN = Track([(0, [0.04, -0.21, 0.07, 10.0, -42.0, 32.0]), (0.40, [0.0, 0.006, 0.0, 0.0, 2.5, -1.5], "out"),
                   (0.55, np.zeros(6), "io")])
UNEQUIP_GUN = Track([(0, np.zeros(6)), (0.35, [0.04, -0.22, 0.07, 10.0, -42.0, 32.0], "in2")])


def clip_equip(t):
    v = EQUIP_GUN(t)
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])))


def clip_unequip(t):
    v = UNEQUIP_GUN(t)
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])))


CLIPS = {
    # name: (spec fn, duration, fps, loop)
    "FP_WaterFamas_Hold": (clip_hold, 2.0, 30, True),
    "FP_WaterFamas_Run": (clip_run, 0.8, 30, True),
    "FP_Aim_WaterFamas": (clip_aim, 2.0, 30, True),
    "FP_Raise_WaterFamas": (clip_raise, 0.25, 120, False),
    "FP_Lower_WaterFamas": (clip_lower, 0.25, 120, False),
    "FP_Fire_WaterFamas": (clip_fire, BURST_DUR, 120, False),
    "FP_FireAim_WaterFamas": (clip_fire_aim, BURST_DUR, 120, False),
    "FP_Reload_WaterFamas": (clip_reload, RL["end"], 60, False),
    "FP_Inspect_WaterFamas": (clip_inspect, 3.6, 60, False),
    "FP_Equip_WaterFamas": (clip_equip, 0.55, 60, False),
    "FP_Unequip_WaterFamas": (clip_unequip, 0.35, 60, False),
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
        wstate.append(dict(trig=ws["trig"], cap_turn=ws["cap_turn"], hinge=ws["hinge"],
                           bottle=None if ws["bottle"] is None else np.array(ws["bottle"]), level=ws["level"]))
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
        out["_meta"] = dict(mount=M_FP, hold=HOLD, aim=AIM, channels=CHANNELS, rl=RL, jets=JET_TIMES)
        pickle.dump(out, open(OUT, "wb"))
