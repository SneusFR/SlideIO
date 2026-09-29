"""FP pose-library authoring for the Frisbee Launcher (IK-driven, same 20-channel set as the HexSniper).

Two-handed: every frame the weapon placement is authored in CAMERA space, the right arm is solved so Weapon_R carries
the weapon there (pistol grip, the Paintball Rifle hold), then the left arm is solved against the ACTUAL weapon /
sled / cage / disc transforms of that frame. Left hand on the vertical foregrip = the Paintball Rifle fitted fist
(same foregrip section), moved to our foregrip. Off the grip (re-cocking, magazine swap) the left arm is solved under
the natural limits of fp_natural.py (skin-seen twists, elbows down/out, shoulder slide, sleeve off screen), and its
free-air moves are joint-space blends between contact poses (no twisted wrists in between).
"""
import pickle, sys, json, os
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from fp_common import arms, hold_ref, mount_from, weapon_root_world, S_ROOT, render
import weapon_def as wd
from ik import ChainIK
from anim_util import Track, ease, normalized, frame_from, blend_frames, rotz, rotx, roty, noise1
from rig import trs, qaxis, qmul, quat_to_mat3, mat3_to_quat, qnorm, slerp

# ---------------------------------------------------------------- setup
MOUNT_OFFSET = (0.04, -0.24, 0.0)                 # = Popcorn Shotgun / Paintball Rifle (same grip point, same right hand)
M_FP = mount_from(offset_local=MOUNT_OFFSET)
GUN_SCALE = wd.ROOT_SCALE * float(np.linalg.norm(M_FP[:3, 0]))  # world metres per weapon unit (≈0.076)
HOLD = dict(grip=np.array([0.195, -0.272, -0.40]), yaw=14.0, pitch=2.0, roll=-6.0)
AIM = dict(grip=np.array([0.006, -0.245, -0.31]), yaw=0.0, pitch=4.0, roll=0.0)

HEX = hold_ref()
V0 = HEX["FP_Viewmodel"]
ikR = ChainIK(arms, ["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"], "Weapon_R",
              rot_bones=["UpperArm_R", "LowerArm_R", "Hand_R"], trans_bones=["Shoulder_R"])
ikL = ChainIK(arms, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["UpperArm_L", "LowerArm_L", "Hand_L"], trans_bones=["Shoulder_L"])
FINGERS_L = ["Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FINGERS_R = ["Index_R_1", "Middle_R_1", "Ring_R_1", "Thumb_R_1"]
L_BONES = ("Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L")
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


# ---- the Paintball Rifle foregrip fist, moved onto our foregrip (same post section)
PB_FORE = np.array([-1.6516, -0.484, 0.0])                     # Paintball Rifle foregrip (x, top y)
FORE_TOP = np.array([wd.FOREGRIP_X, wd.FOREGRIP_Y0, 0.0])
_FG = json.load(open("fore_grip.json")); _FG1 = json.load(open("fore_grip_v1.json"))
OFFHAND_FIT = trs(FORE_TOP - PB_FORE) @ np.array(_FG["offhand_local"], float)
FORE_CURLS = {k: float(v) for k, v in _FG["curls"].items()}
OFFHAND_FIT_V1 = trs(FORE_TOP - PB_FORE) @ np.array(_FG1["offhand_local"], float)
FORE_CURLS_V1 = {k: float(v) for k, v in _FG1["curls"].items()}
wd.OFFHAND_LOCAL = OFFHAND_FIT


def gripmix(w_grip, s_other):
    w = float(np.clip(w_grip, 0, 1))
    if isinstance(s_other, dict):
        return {n: FORE_CURLS[n] * w + s_other.get(n, 1.0) * (1 - w) for n in FORE_CURLS}
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


def vec_place(v):
    """[dx, dy, dz, yaw, pitch, roll] -> offset dict."""
    v = np.asarray(v, float)
    return dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])


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


# ---------------------------------------------------------------- solve one frame (foregrip hold)
def fore_hand(Wn):
    return Wn["Offhand"]


REF = None


def solve_right(pose, pl, ref, xR=None):
    pose = dict(pose)
    pose["FP_Viewmodel"] = V0
    pose["Hips"] = HEX["Hips"]
    W = arms.world(pose)
    G = gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    tgtR = normalized(G @ np.linalg.inv(S_ROOT) @ np.linalg.inv(M_FP))
    pose, xR, eR, rR = ikR.solve(pose, W, tgtR, ref, w_rot=1.0, reg_rot=[0.10, 0.02, 0.02], reg_trans=0.02, x0=xR,
                                 extra=keep_right_limited)
    return pose, xR, eR, rR


def set_fingers(pose, lf, rf=1.0, rfi=None):
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    for n in FINGERS_L:
        pose[n] = (REST[n][0], finger_q(n, lfs.get(n, 1.0)), REST[n][2])
    for n in FINGERS_R:
        s = (rfi if rfi is not None else rf) if n == "Index_R_1" else rf
        pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
    return pose


def solve_pose(spec, xR=None, xL=None, ref=None, base_pose=None):
    """Foregrip hold: spec = dict(place, st (weapon state), lf, rf, rfi, straight)."""
    ref = ref if ref is not None else REF
    pose = dict(base_pose if base_pose is not None else ref)
    pose, xR, eR, rR = solve_right(pose, spec["place"], ref, xR)
    W = arms.world(pose)
    Ga = weapon_root_world(W, M_FP)
    Wn = wd.world_nodes(Ga, spec.get("st"))
    tgtL = normalized(spec.get("lh", fore_hand)(Wn))
    pose0 = pose
    exL = left_extra(spec.get("straight", 0.6))
    pose, xL1, eL, rL = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 1.1), reg_rot=[0.12, 0.02, 0.02],
                                  reg_trans=0.02, x0=xL, extra=exL)
    if rL > 1.0 and xL is not None:
        p2, x2, e2, r2 = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 1.1), reg_rot=[0.12, 0.02, 0.02],
                                   reg_trans=0.02, x0=None, extra=exL)
        if r2 < rL:
            pose, xL1, eL, rL = p2, x2, e2, r2
    set_fingers(pose, spec.get("lf", FORE_CURLS), spec.get("rf", 1.0), spec.get("rfi"))
    return pose, spec.get("st") or {}, xR, xL1, (eR, rR, eL, rL)


def init_ref():
    global REF
    REF = None
    p, _, _, _, _ = solve_pose(dict(place=HOLD), ref=HEX, base_pose=HEX)
    REF = p
    return p


init_ref()


# ---------------------------------------------------------------- base clips
def breathing(t, period, amp=1.0):
    ph = 2 * np.pi * t / period
    return dict(grip=amp * np.array([0.0008 * np.sin(ph + 0.6), 0.0018 * np.sin(ph), 0.0006 * np.sin(ph + 2.2)]),
                pitch=amp * 0.55 * np.sin(ph + 1.1), roll=amp * 0.45 * np.sin(ph + 2.0), yaw=amp * 0.3 * np.sin(ph + 0.4))


def clip_hold(t):
    return dict(place=place(HOLD, breathing(t, 2.0)))


def clip_aim(t):
    return dict(place=place(AIM, breathing(t, 2.0, 0.5)))


RUN_BASE = place(HOLD, dict(grip=(0.012, -0.028, 0.03), yaw=7.0, pitch=-9.0, roll=-17.0))


def clip_run(t):
    ph = 2 * np.pi * t / 0.8
    d = dict(grip=(0.008 * np.sin(ph), 0.010 * np.cos(2 * ph) - 0.002, 0.004 * np.cos(2 * ph)),
             yaw=1.8 * np.sin(ph), pitch=2.2 * np.cos(2 * ph + 0.4), roll=3.0 * np.sin(ph + 0.3))
    return dict(place=place(RUN_BASE, d))


def clip_raise(t, dur=0.3):
    return dict(place=lerp_place(HOLD, AIM, ease(t / dur, "io")))


def clip_lower(t, dur=0.3):
    return dict(place=lerp_place(AIM, HOLD, ease(t / dur, "io")))


# ---------------------------------------------------------------- hand geometry + natural left arm (off the foregrip)
WL_IN_HAND = trs(*REST["Weapon_L"])                            # Weapon_L relative to Hand_L (metres)
PALM_PT = np.array([0.033, 0.035, 0.0])                        # palm-surface centre, Hand_L local (metres)
import fp_natural as N                                         # (after REF: fp_natural reads it)


def rigid(M):
    return normalized(M)


def fist_on_bar(fist_root, post_c, bar_c, R_post_to_bar, push):
    """Re-express a fist fitted on the vertical foregrip (root units) around another bar (node units)."""
    R = np.eye(4); R[:3, :3] = R_post_to_bar
    return trs(bar_c) @ trs(push) @ R @ trs(-post_c) @ fist_root


# fist over the sled T-handle (overhand, palm down, thumb toward the right): the foregrip fist, post axis +Y -> -Z
SLED_GRAB_LOCAL = fist_on_bar(OFFHAND_FIT, np.array([wd.FOREGRIP_X, OFFHAND_FIT[1, 3], 0.0]), wd.SLED_HANDLE, rotx(-90.0),
                              [0.0, -(wd.FOREGRIP_HALF[1] - 0.15), 0.0])
wd.SLED_GRAB_LOCAL = SLED_GRAB_LOCAL
BAR_CURLS = {k: v * 1.18 for k, v in FORE_CURLS.items()}       # thinner bar: the fist closes more


def palm_target(node_world_rigid, p_units, n, phi, lift=0.0):
    """Weapon_L target: palm on the node-local point p (weapon units) with normal n / finger angle phi (node axes)."""
    return node_world_rigid @ N.hand_frame(np.asarray(p_units, float) * GUN_SCALE, n, phi, lift)


# frisbee (backhand) grip on the LEFT rim of a disc: palm on the rim, fingers down under it, thumb over the top
DISC_GRIP = dict(p=[0.15, -0.02, wd.DISC_R + 0.02], n=(0.0, 0.0, -1.0), phi=100.0)
DISC_CURLS = {"Index_L_1": 1.25, "Middle_L_1": 1.35, "Ring_L_1": 1.35, "Thumb_L_1": 1.55}
# palm under the cage bottom (magazine swap), fingers toward the right / front
CAGE_GRIP = dict(p=[0.05, wd.CAGE_BOTTOM - 0.17, 0.35], n=(0.0, 1.0, 0.0), phi=28.0)
CAGE_CURLS = {"Index_L_1": 0.75, "Middle_L_1": 0.8, "Ring_L_1": 0.85, "Thumb_L_1": 0.7}
OPEN = 0.45


def disc_grip_target(Gd):
    """Gd: disc world matrix (camera space)."""
    return palm_target(rigid(Gd), DISC_GRIP["p"], DISC_GRIP["n"], DISC_GRIP["phi"])


def cage_grip_target(Gc):
    return palm_target(rigid(Gc), CAGE_GRIP["p"], CAGE_GRIP["n"], CAGE_GRIP["phi"])


# ---------------------------------------------------------------- path helpers
def _euler(v):
    return Rot.from_euler("XYZ", v, degrees=True).as_matrix()


def key_path(keys, t, kind="io"):
    """keys: [(t, pos(3), euler_deg(3))] root space -> 4x4 (Catmull-Rom position, slerp rotation)."""
    if t <= keys[0][0]: i = 0; u = 0.0
    elif t >= keys[-1][0]: i = len(keys) - 2; u = 1.0
    else:
        i = max(k for k in range(len(keys) - 1) if keys[k][0] <= t)
        u = ease((t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]), kind)
    P = [np.asarray(k[1], float) for k in keys]
    p0, p1 = P[i], P[i + 1]
    pm = P[max(i - 1, 0)]; pp = P[min(i + 2, len(P) - 1)]
    m0 = (p1 - pm) * 0.5; m1 = (pp - p0) * 0.5
    h00 = 2 * u ** 3 - 3 * u ** 2 + 1; h10 = u ** 3 - 2 * u ** 2 + u; h01 = -2 * u ** 3 + 3 * u ** 2; h11 = u ** 3 - u ** 2
    p = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
    q = slerp(mat3_to_quat(_euler(keys[i][2])), mat3_to_quat(_euler(keys[i + 1][2])), u)
    M = np.eye(4); M[:3, :3] = quat_to_mat3(q); M[:3, 3] = p
    return M


SLOT0 = wd.CAGE_C + np.array([0.0, wd.SLOT_Y[0], 0.0])
DECK = wd.DISC_LOADED.copy()

# ---------------------------------------------------------------- the shot
SHOT = dict(end=0.24)
TRIG_SHOT = Track([(0, 14.0), (0.06, 14.0, "lin"), (0.18, 0.0, "io")])
RFI_SHOT = Track([(0, 1.35), (0.06, 1.35, "lin"), (0.18, 1.0, "io")])
SLED_SHOT = Track([(0, 1.0), (0.035, 0.0, "in2")])
FLEX_SHOT = Track([(0, 1.0), (0.035, -0.32, "in2"), (0.075, 0.17, "io"), (0.12, -0.08, "io"), (0.17, 0.035, "io"),
                   (0.23, 0.0, "io")])
KICK = Track([(0, np.zeros(6)), (0.018, [0.0, 0.004, 0.012, -0.6, 4.0, 0.8], "out"), (0.09, [0.0, 0.0015, 0.004, -0.2, 1.2, 0.3], "io"),
              (SHOT["end"], np.zeros(6), "io")])

# ---------------------------------------------------------------- the re-cocking cycle (times relative to its start)
CY = dict(h1=0.20, grab=0.25, pull=0.46, rel=0.50, d0=0.68, take=0.71, seat=1.05, drel=1.09, back=1.30, end=1.34)
CY_GUN = Track([(0, np.zeros(6)),                                              # gun placements solved by opt/search_keys.py
                (0.14, [0.004, -0.032, 0.004, 0.0, 5.0, -24.0], "io"),
                (CY["h1"], [0.0049, -0.0438, 0.0061, -0.71, 6.9, -31.7], "io"),       # hand on the handle (front)
                (CY["pull"], [0.0048, -0.014, -0.0583, 5.3, 20.0, -30.1], "io"),      # pulled back, latched
                (CY["take"], [0.0192, -0.0115, -0.0392, -5.4, 24.5, -26.4], "io"),    # disc taken from the cage
                (0.86, [0.025, 0.012, -0.060, -11.0, 32.0, -22.0], "io"),
                (0.95, [0.023, -0.006, -0.070, -12.0, 34.0, -24.0], "io"),
                (CY["seat"], [0.0211, -0.0152, -0.0525, -5.8, 18.1, -34.7], "io"),    # disc laid on the deck
                (CY["end"], np.zeros(6), "io")])
SLED_CY = Track([(0, 0.0), (CY["grab"], 0.0, "lin"), (CY["pull"], 1.0, "io")])
DISC_KEYS = [(CY["take"], SLOT0, [0, 0, 0]),
             (0.78, SLOT0 + np.array([0.04, -0.03, 1.35]), [4, 0, 0]),
             (0.84, np.array([-1.90, -0.35, 2.30]), [12, 0, 6]),
             (0.90, np.array([-1.05, 0.20, 2.05]), [16, 0, 8]),
             (0.95, np.array([-1.20, 0.85, 1.25]), [-10, 0, 4]),
             (1.01, np.array([-2.35, 0.62, 0.25]), [-4, 0, 0]),
             (CY["seat"], DECK, [0, 0, 0])]


def disc_in_hand(u):
    return key_path(DISC_KEYS, u, "sio")


def cycle_state(u):
    """Weapon state during the cycle (u = time since its start)."""
    s = float(SLED_CY(u))
    st = dict(sled=s, flex=s, deck=None, hand=None, cage_top=True)
    if CY["take"] <= u < CY["seat"]:
        st["hand"] = disc_in_hand(u); st["cage_top"] = False
    if u >= CY["seat"]:
        st["deck"] = "loaded"
    return st


def cycle_left(u):
    """Left-hand schedule of the cycle: ('grip',) | ('jb', uA, uB) | ('contact', target(Gn, st) -> 4x4, curls)."""
    if u < 0: return ("grip",)
    if u < CY["h1"]: return ("jb", 0.0, CY["h1"])
    if u < CY["rel"]:
        c = ease((u - CY["h1"]) / (CY["grab"] - CY["h1"]), "io")
        o = ease((u - CY["pull"]) / (CY["rel"] - CY["pull"]), "io") if u > CY["pull"] else 0.0
        curls = {k: OPEN + (BAR_CURLS[k] - OPEN) * c * (1 - o) for k in BAR_CURLS}
        return ("contact", lambda Wn, st: normalized(Wn["SledGrab"]), curls)
    if u < CY["d0"]: return ("jb", CY["rel"], CY["d0"])
    if u < CY["drel"]:
        c = ease((u - CY["d0"]) / (CY["take"] - CY["d0"]), "io")
        o = ease((u - CY["seat"]) / (CY["drel"] - CY["seat"]), "io") if u > CY["seat"] else 0.0
        curls = {k: OPEN + (DISC_CURLS[k] - OPEN) * c * (1 - o) for k in DISC_CURLS}
        dm = disc_in_hand(max(u, CY["take"]))
        return ("contact", lambda Wn, st, dm=dm: disc_grip_target(Wn["Root"] @ dm), curls)
    if u < CY["back"]: return ("jb", CY["drel"], CY["back"])
    return ("grip",)


# ---------------------------------------------------------------- generic clip = placement + weapon state + left schedule
class ClipDef:
    def __init__(self, dur, fps, loop, place_fn, state_fn, left_fn=None, rfi_fn=None):
        self.dur, self.fps, self.loop = dur, fps, loop
        self.place, self.state, self.left = place_fn, state_fn, left_fn or (lambda t: ("grip",))
        self.rfi = rfi_fn or (lambda t: None)


def fire_def(aim=False, cycle=True):
    base_a = AIM if aim else HOLD
    c0 = SHOT["end"]

    def pl(t):
        d = vec_place(KICK(t) * (0.6 if aim else 1.0))
        if not cycle or t < c0:
            return place(base_a, d)
        u = t - c0
        w = 1.0 if not aim else float(Track([(0, 0.0), (0.16, 1.0, "io"), (CY["drel"], 1.0, "lin"), (CY["end"], 0.0, "io")])(u))
        return place(lerp_place(base_a, HOLD, w), add(d, vec_place(CY_GUN(u))))

    def st(t):
        s = dict(trig=float(TRIG_SHOT(t)), sled=float(SLED_SHOT(t)), flex=float(FLEX_SHOT(t)), deck=None)
        if cycle and t >= c0:
            s.update(cycle_state(t - c0)); s["trig"] = 0.0
            if t - c0 < 0.3: s["flex"] = min(s["flex"], 0.0) + float(FLEX_SHOT(t)) * (t < SHOT["end"] + 0.01)
        return s

    def left(t):
        if not cycle or t < c0: return ("grip",)
        L = cycle_left(t - c0)
        if L[0] == "jb": return ("jb", L[1] + c0, L[2] + c0)
        return L

    dur = c0 + CY["end"] if cycle else 0.5
    return ClipDef(dur, 60, False, pl, st, left, lambda t: float(RFI_SHOT(t)))


def hold_def(fn, dur, fps, loop):
    return ClipDef(dur, fps, loop, lambda t: fn(t)["place"], lambda t: {})


# ---------------------------------------------------------------- baker
class Baker:
    def __init__(self, cd):
        self.cd = cd; self.xR = None; self.xLg = None; self.xLc = None; self.keys = {}

    def right(self, t):
        pose, self.xR, eR, rR = solve_right(dict(REF), self.cd.place(t), REF, self.xR)
        return pose, eR, rR

    def nodes(self, pose, t):
        W = arms.world(pose)
        Ga = weapon_root_world(W, M_FP)
        st = self.cd.state(t)
        return W, Ga, st, wd.world_nodes(Ga, st)

    def grip_left(self, pose, W, Wn, xL=None):
        exL = left_extra(0.6)
        p2, x, e, r = ikL.solve(pose, W, normalized(Wn["Offhand"]), REF, w_rot=1.1, reg_rot=[0.12, 0.02, 0.02], reg_trans=0.02,
                                x0=xL, extra=exL)
        return p2, x, e, r

    def key_pose(self, t, side=+1):
        """Left-arm locals + curls at a key time (grip / contact / pose). side=-1: the schedule element that ENDS at t
        (start of a joint-space blend), +1: the one that STARTS at t (end of the blend)."""
        k = (round(t, 5), side)
        if k in self.keys: return self.keys[k]
        pose, eR, rR = self.right(t)
        W, Ga, st, Wn = self.nodes(pose, t)
        tq = t + side * 1e-6
        L = self.cd.left(tq) if 0.0 <= tq < self.cd.dur else ("grip",)
        if L[0] == "contact":
            p2, _, _, _ = N.solve_left(pose, L[1](Wn, st))
            curls = L[2]
        elif L[0] == "pose":
            p2 = dict(pose); p2.update(L[1]); curls = L[2]
        else:
            p2, _, _, _ = self.grip_left(pose, W, Wn)
            curls = FORE_CURLS
        self.keys[k] = ({b: p2[b] for b in L_BONES}, curls)
        return self.keys[k]

    def frame(self, t):
        pose, eR, rR = self.right(t)
        W, Ga, st, Wn = self.nodes(pose, t)
        L = self.cd.left(t)
        eL = rL = 0.0
        if L[0] == "grip":
            pose, self.xLg, eL, rL = self.grip_left(pose, W, Wn, self.xLg)
            curls = FORE_CURLS; self.xLc = None
        elif L[0] == "contact":
            pose, self.xLc, (eL, rL), s = N.solve_left(pose, L[1](Wn, st), x0=self.xLc)
            curls = L[2]
        elif L[0] == "pose":
            pose.update(L[1]); curls = L[2]; self.xLc = None
        else:
            _, ta, tb = L
            u = ease((t - ta) / (tb - ta), "io")
            La, ca = self.key_pose(ta, -1); Lb, cb = self.key_pose(tb, +1)
            for bn in L_BONES:
                Ta, qa, Sa = La[bn]; Tb, qb, Sb = Lb[bn]
                pose[bn] = (np.asarray(Ta) * (1 - u) + np.asarray(Tb) * u, slerp(np.asarray(qa, float), np.asarray(qb, float), u), Sa)
            curls = {n: ca.get(n, 1.0) * (1 - u) + cb.get(n, 1.0) * u for n in FINGERS_L}
            curls = {n: v - 0.35 * np.sin(np.pi * u) for n, v in curls.items()}          # the hand opens a little in the air
            self.xLc = None
        rfi = self.cd.rfi(t)
        set_fingers(pose, curls, 1.0, rfi)
        pose["FP_Viewmodel"] = V0; pose["Hips"] = HEX["Hips"]
        return pose, st, (eR, rR, eL, rL)


def bake_def(name, cd, verbose=True):
    n = int(round(cd.dur * cd.fps)) + 1
    bk = Baker(cd)
    frames, wstate, errs = [], [], []
    for i in range(n):
        t = min(i / cd.fps, cd.dur)
        pose, st, err = bk.frame(t)
        frames.append({b: pose[b] for b in sorted(set(c[0] for c in CHANNELS))})
        wstate.append(st); errs.append(err)
    errs = np.array(errs)
    if verbose:
        print(f"{name:32s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
              f"maxR={errs[:, 0].max() * 1000:.2f}mm/{errs[:, 1].max():.2f}deg", flush=True)
    return dict(name=name, fps=cd.fps, duration=cd.dur, loop=cd.loop, frames=frames, weapon=wstate, errors=errs)


# ---------------------------------------------------------------- magazine swap (cage off / new cage in)
RL = dict(h1=0.20, grab=0.26, down=0.40, release=0.45, drop=0.50, away=0.58, hide0=0.60, hide1=0.82, back=0.84, low=0.94,
          align=1.02, seat=1.10, rel=1.14, ret=1.36, end=1.40)
# release: the hand lets the empty cage go (it falls out of the view, FP; handed to a world prop, TP);
# hide1: the new cage appears in the hand, OFF SCREEN (FP) / at the hip (TP), growing out of the pouch in GROW s
GROW = 0.06
RL_GUN = Track([(0, np.zeros(6)),                                              # gun placements solved by opt/search_keys.py
                (RL["h1"], [0.0131, 0.0505, -0.0094, 1.4, 12.2, -0.3], "io"),        # hand under the cage
                (RL["down"], [-0.0014, 0.0668, -0.0169, 0.0, 18.4, -1.2], "io"),      # cage pulled off the rail
                (RL["away"], [0.004, 0.045, -0.010, 0.5, 13.0, -1.0], "io"),
                (RL["back"], [0.004, 0.045, -0.010, 0.5, 13.0, -1.0], "lin"),
                (RL["align"], [-0.0024, 0.0583, -0.0133, 0.5, 16.2, -1.7], "io"),     # new cage under the rail
                (RL["seat"], [-0.0024, 0.052, -0.0133, 0.5, 14.5, -1.7], "out"),
                (RL["ret"], [0.0, 0.004, -0.001, 0.0, 1.0, 0.0], "io"),
                (RL["end"], np.zeros(6), "io")])
SEAT_JOLT = Track([(RL["seat"] - 0.001, 0.0), (RL["seat"] + 0.02, 1.0, "out"), (RL["seat"] + 0.14, 0.0, "io")])
# cage keys: ("local", [dx,dy,dz, rx,ry,rz]) = offset to the seated cage (ROOT units / deg),
#            ("cam",   [x,y,z, rx,ry,rz])   = camera-space target (metres) for the off-screen part
CAGE_KEYS = [(RL["grab"], "local", [0, 0, 0, 0, 0, 0]),
             (RL["down"], "local", [0.05, -0.55, 0.15, 0, 0, 8]),
             (RL["drop"], "local", [0.30, -1.60, 1.40, 25, 0, 15]),
             (RL["away"], "cam", [-0.16, -0.56, -0.30, 40, 10, 20]),
             (RL["back"], "cam", [-0.14, -0.53, -0.32, 35, 5, 15]),
             (RL["low"], "local", [0.20, -1.40, 1.10, 20, 0, 10]),
             (RL["align"], "local", [0.0, -0.45, 0.05, 2, 0, 2]),
             (RL["seat"], "local", [0, 0, 0, 0, 0, 0])]


def reload_place(t):
    k = float(SEAT_JOLT(t))
    return place(HOLD, add(vec_place(RL_GUN(t)), dict(grip=(0.0, -0.004 * k, 0.0), pitch=-1.2 * k)))


def _G_rl(t):
    pl = reload_place(t)
    return gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])


def cage_key_path(t, G_of_t=_G_rl, keys=None):
    """Cage frame (ROOT space) along the key path (the cage in the hand; after the release: where the empty hand goes)."""
    keys_in = CAGE_KEYS if keys is None else keys
    kk = []
    for tk, kind, v in keys_in:
        v = np.asarray(v, float)
        if kind == "local":
            p = wd.CAGE_C + v[:3]; e = v[3:]
        else:
            G = G_of_t(tk); Gn = normalized(G); Gi = np.linalg.inv(G)
            p = (Gi @ np.r_[v[:3], 1.0])[:3]
            e = Rot.from_matrix(Gn[:3, :3].T @ _euler(v[3:])).as_euler("XYZ", degrees=True)
        kk.append((tk, p, e))
    return key_path(kk, t, "io")


def cage_hand_at(t, G_of_t=_G_rl, keys=None):
    """Cage frame (ROOT space) the LEFT HAND follows: the key path; while no cage is in the hand (after the release,
    until the new cage) the hand goes from the drop point to the pick-up point (belt)."""
    if t <= RL["grab"] or t >= RL["seat"]:
        return trs(wd.CAGE_C)
    if RL["hide0"] < t < RL["hide1"]:
        a = cage_key_path(RL["hide0"], G_of_t, keys); b = cage_key_path(RL["hide1"], G_of_t, keys)
        return blend_frames(a, b, ease((t - RL["hide0"]) / (RL["hide1"] - RL["hide0"]), "io"))
    return cage_key_path(t, G_of_t, keys)


def cage_grow(M, t):
    """New cage coming out of the belt pouch: scaled up about the palm point for GROW s after hide1."""
    u = (t - RL["hide1"]) / GROW
    if not 0.0 <= u < 1.0:
        return M
    sc = 0.3 + 0.7 * ease(u, "out")
    pg = np.asarray(CAGE_GRIP["p"], float)
    return M @ trs(pg) @ trs(s=(sc, sc, sc)) @ trs(-pg)


# --- FP: the released empty cage falls (gravity, a little tumble) out of the bottom of the view, camera space
DROP_G = np.array([0.0, -9.81, 0.0])
DROP_SPIN = np.array([3.0, 0.6, 4.5])                  # rad/s, camera axes
_FALL = {}


def _fall_init():
    if not _FALL:
        t0 = RL["release"]; h = 1.0 / 120.0
        W0 = _G_rl(t0) @ cage_key_path(t0); Wm = _G_rl(t0 - h) @ cage_key_path(t0 - h)
        sc = float(np.linalg.norm(W0[:3, 0]))
        _FALL.update(W0=W0, R0=W0[:3, :3] / sc, s=sc, v0=(W0[:3, 3] - Wm[:3, 3]) / h)
    return _FALL


def cage_fall_cam(t):
    F = _fall_init()
    dt = max(0.0, t - RL["release"])
    W = np.eye(4)
    W[:3, :3] = Rot.from_rotvec(DROP_SPIN * dt).as_matrix() @ F["R0"] * F["s"]
    W[:3, 3] = F["W0"][:3, 3] + F["v0"] * dt + 0.5 * DROP_G * dt * dt
    return W


CAGE_BOX = np.array([[x, y, z] for x in (-1.3, 1.3) for y in (0.08, wd.CAGE_BOTTOM - 0.18) for z in (-1.3, 1.3)])


def offscreen_cam(W, box=CAGE_BOX, vfov=65.0, aspect=21.0 / 9.0):
    """True when the box (node-local corners) seen through camera-space matrix W is entirely outside the FP view
    (below the bottom plane or left of the left plane of the widest supported aspect)."""
    P = (W[:3, :3] @ box.T).T + W[:3, 3]
    tv = np.tan(np.radians(vfov) / 2); th = tv * aspect
    below = np.all(P[:, 1] < tv * P[:, 2])
    left = np.all(P[:, 0] < th * P[:, 2])
    return bool(below or left)


def _gone_time():
    t = RL["release"]
    while t < RL["hide1"]:
        if offscreen_cam(cage_fall_cam(t)):
            return t + 1.0 / 60.0
        t += 1.0 / 240.0
    raise RuntimeError("the dropped cage never leaves the view")


RL["gone"] = round(_gone_time(), 4)
assert RL["gone"] < RL["hide1"] - 0.05, RL["gone"]


def cage_local_at(t, G_of_t=_G_rl):
    """FP cage node (ROOT space) at t: None = seated, 'hidden', or a 4x4. In the hand until the release, then falling out
    of the view (hidden once it is off screen), then the new cage in the hand from hide1 (appearing off screen)."""
    if t <= RL["grab"] or t >= RL["seat"]:
        return None
    if RL["release"] <= t <= RL["gone"]:
        return np.linalg.inv(G_of_t(t)) @ cage_fall_cam(t)
    if RL["gone"] < t < RL_ARM["appear"]:
        return "hidden"
    if t < RL_ARM["pick"]:
        return cage_grow(cage_display_fp_new(t, G_of_t), t - (RL_ARM["appear"] - RL["hide1"]))
    return cage_key_path(t, G_of_t)


def cage_grip_at(t):
    return cage_hand_at(t)


# ---- FP left arm while it has no cage: it SLIDES DOWN out of the view (the foregrip-hold arm translated under the
# screen: the arm keeps its normal orientation, so no part of the long FP sleeve swings up into the view), the new
# cage appears in that hand off screen and the arm comes back up with it
RL_ARM = dict(letgo=RL["release"] + 0.05, down=0.60, appear=0.78, pick=0.94)
ARM_DROP_CAM = np.array([-0.04, -0.36, 0.08])            # camera-space offset of the whole left arm (m)


def _left_drop_pose():
    P = dict(REST); P.update(REF)
    W = arms.world(P)
    par = arms.names[arms.parent[arms.names.index("Shoulder_L")]]
    R = W[par][:3, :3]; sc = np.linalg.norm(R, axis=0)
    d_local = (R / sc).T @ ARM_DROP_CAM / sc
    pose = {b: REF[b] for b in L_BONES}
    T, q, S = REF["Shoulder_L"]
    pose["Shoulder_L"] = (np.asarray(T, float) + d_local, q, S)
    P.update(pose)
    return pose, arms.world(P)["Weapon_L"]


LEFT_DROP, WL_DROP = _left_drop_pose()
_K = {}


def k_cage():
    """Weapon_L frame relative to the rigid cage frame (palm under the cage bottom), lazily (fp_natural imports us)."""
    if not _K:
        _K["k"] = N.hand_frame(np.asarray(CAGE_GRIP["p"], float) * GUN_SCALE, CAGE_GRIP["n"], CAGE_GRIP["phi"])
    return _K["k"]


def _cage_cam_scale():
    W = _G_rl(RL["seat"]) @ cage_key_path(RL["seat"])
    return float(np.linalg.norm(W[:3, 0]))


CAGE_CAM_S = _cage_cam_scale()


def cage_display_fp_new(t, G_of_t=_G_rl):
    """FP new cage between its appearance (off screen, in the dropped hand) and the pick-up key: carried by the hand."""
    A_ = normalized(WL_DROP) @ np.linalg.inv(k_cage())                      # rigid cage frame in the dropped hand
    B_ = normalized(G_of_t(RL_ARM["pick"]) @ cage_key_path(RL_ARM["pick"], G_of_t))
    u = ease((t - RL_ARM["appear"]) / (RL_ARM["pick"] - RL_ARM["appear"]), "io")
    M = blend_frames(A_, B_, u)
    M[:3, :3] = M[:3, :3] * CAGE_CAM_S
    return np.linalg.inv(G_of_t(t)) @ M


def reload_left(t):
    """FP left hand of the cage swap: on the cage (pull it down, throw it), then the whole arm slides down UNDER THE
    VIEW, takes the new cage there (it appears off screen), comes back up with it and pushes it in."""
    if t < RL["h1"]: return ("jb", 0.0, RL["h1"])
    if RL_ARM["letgo"] <= t < RL_ARM["down"]: return ("jb", RL_ARM["letgo"], RL_ARM["down"])
    if RL_ARM["down"] <= t < RL_ARM["appear"]:
        g = ease((t - (RL_ARM["appear"] - 0.08)) / 0.08, "io") if t > RL_ARM["appear"] - 0.08 else 0.0
        return ("pose", LEFT_DROP, {k: OPEN + (CAGE_CURLS[k] - OPEN) * g for k in CAGE_CURLS})
    if RL_ARM["appear"] <= t < RL_ARM["pick"]: return ("jb", RL_ARM["appear"], RL_ARM["pick"])
    if t < RL["rel"]:
        c = ease((t - RL["h1"]) / (RL["grab"] - RL["h1"]), "io")
        o = ease((t - RL["seat"]) / (RL["rel"] - RL["seat"]), "io") if t > RL["seat"] else 0.0
        r = ease((t - RL["release"]) / 0.05, "out") if t > RL["release"] else 0.0            # lets the empty cage go
        g = 1.0 if t >= RL_ARM["pick"] else 0.0                                              # holds the new one
        hold = c * (1 - r + r * g) * (1 - o)
        curls = {k: OPEN + (CAGE_CURLS[k] - OPEN) * hold for k in CAGE_CURLS}
        return ("contact", lambda Wn, st, t=t: cage_grip_target(Wn["Root"] @ cage_hand_at(t)), curls)
    if t < RL["ret"]: return ("jb", RL["rel"], RL["ret"])
    return ("grip",)


def reload_state(t, deck="loaded", sled=1.0):
    cg = cage_local_at(t)
    return dict(sled=sled, flex=sled, deck=deck, hand=None, cage=cg, cage_n=wd.CAGE_SLOTS if t >= RL_ARM["appear"] else 0)


def reload_def():
    return ClipDef(RL["end"], 60, False, reload_place, lambda t: reload_state(t), reload_left)


def reload_empty_def():
    c0 = RL["rel"] + 0.20 - CY["h1"]          # the cycle's handle contact 0.20 s after the cage is released

    def pl(t):
        if t < RL["seat"]:
            return reload_place(t)
        w = ease((t - RL["seat"]) / 0.24, "io")
        a = vec_place(RL_GUN(min(t, RL["rel"] + 0.1)) * (1 - w))
        b = vec_place(CY_GUN(max(0.0, t - c0)) * w)
        k = float(SEAT_JOLT(t))
        return place(HOLD, add(a, b, dict(grip=(0.0, -0.004 * k, 0.0), pitch=-1.2 * k)))

    def st(t):
        if t < c0 + CY["grab"]:
            s = reload_state(t, deck=None, sled=0.0)
            return s
        s = cycle_state(t - c0); s["cage_n"] = wd.CAGE_SLOTS
        return s

    def left(t):
        if t < RL["rel"]: return reload_left(t)
        if t < c0 + CY["h1"]: return ("jb", RL["rel"], c0 + CY["h1"])
        L = cycle_left(t - c0)
        if L[0] == "jb": return ("jb", L[1] + c0, L[2] + c0)
        return L

    return ClipDef(c0 + CY["end"], 60, False, pl, st, left)


# ---------------------------------------------------------------- inspect (two-handed): the left side, then the top
INSPECT_GUN = Track([(0, np.zeros(6)),
                     (0.30, [0.004, -0.004, 0.0, -2.0, -1.0, 4.0], "io"),
                     (0.95, [-0.060, 0.045, 0.070, 30.0, 6.0, -12.0], "io"),
                     (1.60, [-0.063, 0.048, 0.072, 36.0, 4.0, -18.0], "io"),
                     (2.25, [-0.040, 0.060, 0.030, -6.0, -26.0, 10.0], "io"),
                     (2.75, [-0.038, 0.058, 0.030, -8.0, -30.0, 14.0], "io"),
                     (3.30, np.zeros(6), "io"),
                     (3.60, np.zeros(6), "io")])


def inspect_def(loaded=True):
    def pl(t):
        v = INSPECT_GUN(t)
        wob = dict(pitch=0.6 * noise1(t, 11, 3.0), roll=0.8 * noise1(t, 12, 2.6)) if 0.9 < t < 2.9 else {}
        return place(HOLD, add(vec_place(v), wob))
    st = (lambda t: {}) if loaded else (lambda t: dict(sled=0.0, deck=None))
    return ClipDef(3.6, 60, False, pl, st)


# ---------------------------------------------------------------- equip / unequip (the left hand joins the foregrip)
EQUIP_GUN = Track([(0, [0.04, -0.21, 0.07, 10.0, -42.0, 32.0]), (0.40, [0.0, 0.006, 0.0, 0.0, 2.5, -1.5], "out"),
                   (0.55, np.zeros(6), "io")])
UNEQUIP_GUN = Track([(0, np.zeros(6)), (0.35, [0.04, -0.22, 0.07, 10.0, -42.0, 32.0], "in2")])
_REST_OFF = np.array([-0.12, -0.24, 0.10])


def _load_left_idle(path="fp_left_idle.json"):
    """Left arm hanging along the body, out of the FP view (solved for the Water FAMAS on the same common arms,
    fp_idle_left.py): the start of the equip and the end of the unequip."""
    js = json.load(open(path))
    return {b: (np.array(js[b]["t"], float), np.array(js[b]["q"], float), np.array(js[b]["s"], float)) for b in L_BONES}, float(js["curl"])


LEFT_HANG, LEFT_HANG_CURL = _load_left_idle()
HANG_CURLS = {n: LEFT_HANG_CURL for n in FINGERS_L}


def equip_def():
    def left(t):
        if t < 0.12: return ("pose", LEFT_HANG, HANG_CURLS)
        if t < 0.42: return ("jb", 0.12, 0.42)
        return ("grip",)
    return ClipDef(0.55, 60, False, lambda t: place(HOLD, vec_place(EQUIP_GUN(t))), lambda t: {}, left)


def unequip_def():
    def left(t):
        if t < 0.24: return ("jb", 0.0, 0.24)
        return ("pose", LEFT_HANG, HANG_CURLS)
    return ClipDef(0.35, 60, False, lambda t: place(HOLD, vec_place(UNEQUIP_GUN(t))), lambda t: {}, left)


# ---------------------------------------------------------------- clip table
CLIPS = {
    "FP_FrisbeeLauncher_Hold": lambda: hold_def(clip_hold, 2.0, 30, True),
    "FP_FrisbeeLauncher_Run": lambda: hold_def(clip_run, 0.8, 30, True),
    "FP_Aim_FrisbeeLauncher": lambda: hold_def(clip_aim, 2.0, 30, True),
    "FP_Raise_FrisbeeLauncher": lambda: hold_def(clip_raise, 0.3, 120, False),
    "FP_Lower_FrisbeeLauncher": lambda: hold_def(clip_lower, 0.3, 120, False),
    "FP_Fire_FrisbeeLauncher": lambda: fire_def(),
    "FP_FireAim_FrisbeeLauncher": lambda: fire_def(aim=True),
    "FP_FireLast_FrisbeeLauncher": lambda: fire_def(cycle=False),
    "FP_FireLastAim_FrisbeeLauncher": lambda: fire_def(aim=True, cycle=False),
    "FP_Reload_FrisbeeLauncher": lambda: reload_def(),
    "FP_ReloadEmpty_FrisbeeLauncher": lambda: reload_empty_def(),
    "FP_Inspect_FrisbeeLauncher": lambda: inspect_def(),
    "FP_Equip_FrisbeeLauncher": lambda: equip_def(),
    "FP_Unequip_FrisbeeLauncher": lambda: unequip_def(),
}


if __name__ == "__main__":
    names = sys.argv[1:] or list(CLIPS)
    OUT = os.environ.get("OUT", "fp_clips.pkl")
    try:
        out = pickle.load(open(OUT, "rb"))
    except Exception:
        out = {}
    for nm in names:
        out[nm] = bake_def(nm, CLIPS[nm]())
        out["_meta"] = dict(mount=M_FP, hold=HOLD, aim=AIM, channels=CHANNELS, cy=CY, rl=RL, shot=SHOT)
        pickle.dump(out, open(OUT, "wb"))
