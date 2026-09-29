"""TP pose library for the Water FAMAS on Potato_TP_Character (v5 skin) — ONE-HANDED.

The right hand holds the pistol grip (same mount as the Paintball Rifle / HexSniper), the FAMAS points STRAIGHT ahead
(character +Z, level) in every clip; the right arm is solved per frame (ChainIK, natural-range limits). The left arm
hangs relaxed against the side of the belly (solved once, position only, then carried by the chest), swings a little
in the run, and only comes to the weapon for the reload (claw on the cap, bottle taken from the belt, pour, screw).
Same reload timeline as FP (author_fp.RL), same weapon-node tracks (cap turn, hinge, level)."""
import sys, json, pickle, os
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from rig import trs, qaxis, qmul, qnorm, mat3_to_quat, slerp
import weapon_def as wd
import author_fp as A
from anim_util import Track, ease, normalized, blend_frames, noise1
from ik import ChainIK
from twist import swing_twist
from tp_rig import ch, hexp

prof = json.load(open("WeaponProfile_HexSniper.json"))
M_HEX_TP = np.array(prof["mounts"]["tp"]["matrixColumnMajor"]).reshape(4, 4).T
S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)
HEX_GRIP = np.array([1.47, -0.17, 0.0])
M_TP = M_HEX_TP @ trs(wd.ROOT_SCALE * (HEX_GRIP - wd.GRIP + np.array(A.MOUNT_OFFSET)))
REST = ch.rest_pose()
S_TP = wd.ROOT_SCALE * float(np.linalg.norm(M_TP[:3, 0]))          # metres per weapon unit in TP (0.0665)
S_FP = A.GUN_SCALE                                                   # metres per weapon unit in FP (0.076)
BOTTLE_SCALE_TP = S_FP / S_TP                                        # TP bottle node scale: same metric size as in FP

ARM = {s: [f"Shoulder_{s}", f"UpperArm_{s}", f"LowerArm_{s}", f"Hand_{s}"] for s in "LR"}
ikR = ChainIK(ch, ARM["R"], "Weapon_R", rot_bones=ARM["R"])
ikL = ChainIK(ch, ARM["L"], "Weapon_L", rot_bones=ARM["L"])
FINGERS_L, FINGERS_R = A.FINGERS_L, A.FINGERS_R


def channel_set(hex_clip):
    return sorted(hexp.clips[hex_clip]["channels"].keys())


HOLD_CH = channel_set("TP_Hold_HexSniper")
RUN_CH = channel_set("TP_Run_HexSniper")
RAISE_CH = sorted(set(channel_set("TP_Raise_HexSniper")) | {("Spine_1", "rotation"), ("Plant_Root", "rotation")})


def hex_pose(clip, t):
    return ch.pose_from_clip(hexp.clips[clip], t)


HEX_HOLD0 = hex_pose("TP_Hold_HexSniper", 0.0)
HEX_AIM = dict(REST, **hex_pose("TP_Aim_HexSniper", 0.0))


def finger_q(name, s, ref=None):
    """Curl a finger (either hand) along the HexSniper TP hold curl: s=0 rest, 1 = HexSniper grip."""
    rq = REST[name][1]; hq = HEX_HOLD0[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


# ---------------------------------------------------------------- left-hand sockets (TP): same metric relation as FP
def cap_grab_local_tp(phi_deg=0.0, lift=0.0):
    """A.cap_grab_local with the TP metres-per-unit (the hand keeps its size, the gun is 12 % smaller in TP)."""
    saved = A.U_FP
    A.U_FP = S_TP
    try:
        return A.cap_grab_local(phi_deg, lift)
    finally:
        A.U_FP = saved


CAP_GRAB_TP = cap_grab_local_tp(0.0)
BOTTLE_GRAB_TP = wd.BOTTLE_GRAB_LOCAL.copy()          # the TP bottle node is scaled by S_FP/S_TP -> same local socket


def cap_hand(phi, lift=0.0):
    return lambda Wn: Wn["Cap"] @ cap_grab_local_tp(phi, lift)


def cap_push(phi, lift=0.0):
    def fn(Wn):
        Cc = Wn["Tank"] @ wd.node_locals()["CapHinge"] @ wd.node_locals()["Cap"]
        M = Cc @ cap_grab_local_tp(phi, lift)
        M = M.copy(); M[:3, 3] += Wn["Cap"][:3, 3] - Cc[:3, 3]
        return M
    return fn


def bottle_hand(Wn):
    return Wn["Bottle"] @ BOTTLE_GRAB_TP


# ---------------------------------------------------------------- weapon placement (character space)
R_STRAIGHT = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])   # weapon -X (muzzle) -> +Z (char fwd)


def gun_matrix(p, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon ROOT world matrix (incl. the 0.19 root scale) with the GRIP at p. yaw + = muzzle to the character's
    left (+X), pitch + = muzzle up, roll + = top to the character's right."""
    R = Rot.from_euler("YXZ", [yaw, -pitch, -roll], degrees=True).as_matrix() @ R_STRAIGHT
    G = np.eye(4); G[:3, :3] = R * S_TP; G[:3, 3] = np.asarray(p) - R * S_TP @ wd.GRIP
    return G


# ---------------------------------------------------------------- natural-range limits (from bone worlds)
def _nrm(M):
    return M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0)


REST_LQ = {b: REST[b][1] for s in "LR" for b in ARM[s]}


def delta_st_w(Wparent, Wb, b):
    """swing / twist (deg) of bone b relative to its REST local rotation, from world matrices."""
    q = mat3_to_quat(_nrm(Wparent).T @ _nrm(Wb))
    d = Rot.from_quat(REST_LQ[b]).inv() * Rot.from_quat(q)
    return swing_twist(d.as_quat())


def delta_st(pose, b):
    d = Rot.from_quat(REST[b][1]).inv() * Rot.from_quat(pose[b][1])
    return swing_twist(d.as_quat())


REF_ST_R = {b: delta_st(dict(REST, **HEX_HOLD0), b) for b in ARM["R"]}
REF_ST_L = {b: (0.0, 0.0) for b in ARM["L"]}                      # the hanging arm: close to the rest twists
DEAD = {"Shoulder": 6, "UpperArm": 30, "LowerArm": 14, "Hand": 8}


def limits(side, Wp, ref_st=None, w=1.0, elbow_min=12.0):
    ref_st = ref_st or (REF_ST_R if side == "R" else REF_ST_L)
    bones = ARM[side]

    def fn(wl):
        r = []
        par = Wp
        for b in bones:
            sw, tw = delta_st_w(par, wl[b], b); par = wl[b]
            sw0, tw0 = ref_st[b]
            r.append(max(0.0, abs(tw - tw0) - DEAD[b[:-2]]) * 0.6 * w)
            if b.startswith("Shoulder"): r.append(max(0.0, sw - 32.0) * 1.0 * w)
            if b.startswith("Hand"): r.append(max(0.0, sw - 50.0) * 0.6 * w)
            if b.startswith("LowerArm"): r.append(max(0.0, elbow_min - sw) * 0.5 * w)
        # wrist above the elbow line is fine; the hand must not fold back under the forearm
        r.append(max(0.0, wl[f"LowerArm_{side}"][1, 3] - wl[f"Hand_{side}"][1, 3] + 0.01) * 400 if side == "R" else 0.0)
        return np.array(r)
    return fn


# ---------------------------------------------------------------- body (for the key checks and previews)
_body = np.load("tp_body_aim.npy")


def spine_pose(base, yaw, lean):
    p = dict(base)
    T_, R_, S_ = base["Spine_1"]
    q = (Rot.from_quat(R_) * Rot.from_euler("YX", [yaw, lean], degrees=True)).as_quat()
    p["Spine_1"] = (T_, q, S_)
    return p


# ---------------------------------------------------------------- per-frame solve
KEY = dict(p=np.array([-0.075, 0.43, 0.27]), spine=(-6.0, 3.0), left=np.array([0.265, 0.205, 0.045]))
REF_R = None            # right-arm reference pose (key)
LEFT_RELAX = None       # left-arm local rotations (key)


def solve_right(base, G, x0=None, ref=None):
    base = dict(base); base["Weapon_R"] = REST["Weapon_R"]
    Wb = ch.world(base)
    tR = normalized(G @ np.linalg.inv(S_ROOT) @ np.linalg.inv(M_TP))
    ref = ref if ref is not None else (REF_R if REF_R is not None else HEX_AIM)
    pose, x, e, r = ikR.solve(base, Wb, tR, ref, w_rot=1.0, reg_rot=[0.05, 0.02, 0.02, 0.02], x0=x0,
                              extra=limits("R", Wb[ikR.parent_of_root]))
    return pose, x, e, r


def solve_left(pose, target, x0=None, ref=None, w_rot=0.8, reg=(0.05, 0.02, 0.02, 0.02)):
    W = ch.world(pose)
    ref = ref if ref is not None else (dict(pose, **LEFT_RELAX) if LEFT_RELAX is not None else REST)
    p2, x, e, r = ikL.solve(pose, W, normalized(target), ref, w_rot=w_rot, reg_rot=list(reg), x0=x0,
                            extra=limits("L", W[ikL.parent_of_root]))
    return p2, x, e, r


def solve_left_relaxed(pose, pos):
    """Position-only hanging arm (reference = rest: minimal twist), then its hand orientation is kept."""
    W = ch.world(pose)
    T = np.eye(4); T[:3, 3] = pos
    p2, x, e, r = ikL.solve(pose, W, T, REST, w_rot=0.0, reg_rot=[0.08, 0.03, 0.03, 0.05],
                            extra=limits("L", W[ikL.parent_of_root], w=1.5, elbow_min=18.0))
    return p2, e


def body(clip, t, s=1.0):
    return spine_pose(hex_pose(clip, t), KEY["spine"][0] * s, KEY["spine"][1] * s)


def base_pose(clip="TP_Aim_HexSniper", t=0.0, s=1.0):
    b = dict(REST); b.update(body(clip, t, s)); return b


def init_key():
    """Right arm on the gun at KEY p, left arm hanging at KEY left: sets REF_R / LEFT_RELAX."""
    global REF_R, LEFT_RELAX
    b = base_pose()
    G = gun_matrix(KEY["p"])
    pose, xR, eR, rR = solve_right(b, G, ref=HEX_AIM)
    REF_R = {k: pose[k] for k in ARM["R"]}
    pose, eL = solve_left_relaxed(pose, KEY["left"])
    LEFT_RELAX = {k: pose[k] for k in ARM["L"]}
    return pose, (eR, rR, eL)


def apply_fingers(pose, lf=0.35, rf=1.0, rfi=1.0):
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    for n in FINGERS_L:
        pose[n] = (REST[n][0], finger_q(n, lfs.get(n, 1.0)), REST[n][2])
    for n in FINGERS_R:
        s = rfi if n == "Index_R_1" else rf
        pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
    pose["Weapon_R"] = REST["Weapon_R"]
    return pose


# ---------------------------------------------------------------- relaxed left arm (hold / run / fire)
def _rx(deg):
    return Rot.from_euler("X", deg, degrees=True).as_matrix()


def left_relaxed(pose, swing=0.0, flex=0.0, out=0.0):
    """LEFT_RELAX carried by the current chest, + a swing about the character's lateral axis (+ = back),
    + elbow flex (+ = more bent, forearm forward), + abduction (out, deg: arm away from the belly)."""
    p = dict(pose)
    for b in ARM["L"]: p[b] = LEFT_RELAX[b]
    if swing == 0.0 and flex == 0.0 and out == 0.0:
        return p
    W = ch.world(p)
    Rz = Rot.from_euler("Z", out, degrees=True).as_matrix()
    for b, Rw in (("UpperArm_L", _rx(swing) @ Rz), ("LowerArm_L", _rx(-flex))):
        par = ch.names[ch.parent[ch.idx[b]]]
        Wp = _nrm(W[par]); Wb = _nrm(W[b])
        Rl = Wp.T @ Rw @ Wb
        T_, _, S_ = p[b]
        p[b] = (T_, mat3_to_quat(Rl), S_)
        W = ch.world(p)
    return p


# ---------------------------------------------------------------- per-frame baker
class JB:
    """Left-arm transition blended in JOINT space between two contact poses (a / b: target fn (Wn, pose) -> 4x4,
    or "relaxed"): natural arm swing, no IK fight in mid-air. key: warm-start cache id of the segment."""
    def __init__(self, a, b, u, key):
        self.a, self.b, self.u, self.key = a, b, float(u), key


_POSE_AT = {}


def left_pose_at(t):
    """Left-arm local rotations of the reload at time t (contact pose, solved once): endpoints of the JB blends."""
    if t not in _POSE_AT:
        pose, _, err = c_reload(t, Baker())
        _POSE_AT[t] = {b: pose[b] for b in ARM["L"]}
    return _POSE_AT[t]


class Baker:
    def __init__(self):
        self.xR = None; self.xL = None; self.cache = {}

    def frame(self, base, p, off=None, lh=None, ws=None, lf=0.35, rfi=1.0, larm=None, wrotL=1.0):
        off = off or {}
        st = dict(trig=0.0, cap_turn=0.0, hinge=0.0, bottle=None, level=1.0); st.update(ws or {})
        G = gun_matrix(p, off.get("yaw", 0.0), off.get("pitch", 0.0), off.get("roll", 0.0))
        pose, self.xR, eR, rR = solve_right(base, G, x0=self.xR)
        if lh is None:
            pose = left_relaxed(pose, **(larm or {}))
            eL = rL = 0.0; self.xL = None
        elif isinstance(lh, JB):
            locs = []
            for f in (lh.a, lh.b):
                if isinstance(f, str):
                    p_ = left_relaxed(pose); locs.append({b: p_[b] for b in ARM["L"]})
                else:
                    locs.append(left_pose_at(f[1]))
            for b in ARM["L"]:
                T_, qa, S_ = locs[0][b]
                pose[b] = (T_, slerp(np.asarray(qa, float), np.asarray(locs[1][b][1], float), lh.u), S_)
            eL = rL = 0.0; self.xL = None
        else:
            W = ch.world(pose)
            Ga = W["Weapon_R"] @ M_TP @ S_ROOT
            Wn = wd.world_nodes(Ga, st["trig"], st["cap_turn"], st["hinge"], st["bottle"])
            pose, self.xL, eL, rL = solve_left(pose, lh(Wn, pose), x0=self.xL, w_rot=wrotL)
        pose = apply_fingers(pose, lf, 1.0, rfi)
        return pose, st, (eR, rR, eL, rL)


def body(clip, t, s=1.0):
    return dict(REST, **spine_pose(hex_pose(clip, t), KEY["spine"][0] * s, KEY["spine"][1] * s))


def breathing(t, period=2.0, amp=1.0):
    ph = 2 * np.pi * t / period
    return np.array([0.0006 * np.sin(ph + 0.6), 0.0016 * np.sin(ph), 0.0005 * np.sin(ph + 2.2)]) * amp, \
        dict(pitch=0.5 * amp * np.sin(ph + 1.1), roll=0.4 * amp * np.sin(ph + 2.0), yaw=0.25 * amp * np.sin(ph + 0.4))


def idle_arm(t, period=2.0):
    ph = 2 * np.pi * t / period
    return dict(swing=1.2 * np.sin(ph + 0.9), flex=1.0 * np.sin(ph + 2.1), out=0.6 * np.sin(ph + 0.3))


AIM_D = np.array([0.004, 0.006, 0.012])                            # aim: a bit higher / further out / toward the centre


def c_hold(t, bk):
    dp, dr = breathing(t)
    return bk.frame(body("TP_Aim_HexSniper", t), P0 + dp, dr, larm=idle_arm(t))


def c_aim(t, bk):
    dp, dr = breathing(t, amp=0.5)
    return bk.frame(body("TP_Aim_HexSniper", t), P0 + AIM_D + dp, dr, larm=idle_arm(t))


def c_raise(t, bk, dur=0.25):
    u = ease(t / dur, "io")
    return bk.frame(body("TP_Aim_HexSniper", 0.0), P0 + AIM_D * u)


def c_lower(t, bk, dur=0.25):
    u = ease(t / dur, "io")
    return bk.frame(body("TP_Aim_HexSniper", 0.0), P0 + AIM_D * (1 - u))


_CH0 = None


def c_run(t, bk):
    global _CH0
    if _CH0 is None: _CH0 = ch.world(body("TP_Aim_HexSniper", 0.0))["Chest"][:3, 3]
    b = body("TP_Run_HexSniper", t)
    chest = ch.world(b)["Chest"][:3, 3]
    ph = 2 * np.pi * t / 0.8
    dp = (chest - _CH0) * np.array([0.8, 1.0, 0.6]) + np.array([0.004 * np.sin(ph), 0.006 * np.cos(2 * ph), 0.0])
    arm = dict(swing=16.0 * np.cos(ph), flex=6.0 + 6.0 * np.cos(ph + np.pi), out=2.0 + 1.5 * np.cos(2 * ph))
    return bk.frame(b, P0 + dp, dict(yaw=1.5 * np.sin(ph), pitch=1.5 * np.cos(2 * ph + 0.4), roll=2.0 * np.sin(ph + 0.3)), larm=arm)


def _kick_body(base, k):
    b2 = dict(base)
    Tq, Rq, Sq = base["Spine_1"]
    b2["Spine_1"] = (Tq, (Rot.from_quat(Rq) * Rot.from_euler("X", -1.6 * k, degrees=True)).as_quat(), Sq)
    return b2


def c_fire(t, bk):
    """One trigger pull = a 3-jet burst (0 / 0.075 / 0.15 s), 0.42 s, same curves as FP_Fire_WaterFamas."""
    k = float(A._kick(t)); s = float(A.BURST_PUSH(t))
    base = _kick_body(body("TP_Aim_HexSniper", 0.0), 0.35 * s + 0.3 * k)
    off = dict(pitch=0.9 * s + 1.3 * k, roll=0.3 * s + 0.35 * k, yaw=-0.2 * s - 0.15 * k)
    dp = AIM_D * 0.5 + np.array([0.0, 0.0012 * s + 0.0012 * k, -0.004 * s - 0.004 * k])
    arm = dict(swing=-1.5 * s - 1.0 * k, flex=1.5 * s)
    return bk.frame(base, P0 + dp, off, ws=dict(trig=float(A.TRIG_BURST(t))), rfi=float(A.INDEX_BURST(t)), larm=arm)


# ---------------------------------------------------------------- reload (same timeline as FP)
RL = A.RL
UNS_TP = [0.03, -0.02, 0.02, -25.0, -5.0, -5.0]            # cap toward the left hand, in front of the chest
POUR_TP = [0.05, -0.08, 0.0, -25.0, -35.0, -5.0]           # nose down, filler hole up (grid search: right arm 2 mm / 3 deg)
CAP_PHI_TP = -45.0                                          # centre of the claw strokes
TP_RELOAD_GUN = None


def build_reload_gun():
    global TP_RELOAD_GUN
    TP_RELOAD_GUN = Track([(0, np.zeros(6)), (0.24, UNS_TP, "io"), (0.88, UNS_TP, "lin"), (1.22, POUR_TP, "io"),
                           (2.06, POUR_TP, "lin"), (2.36, UNS_TP, "io"), (2.95, UNS_TP, "lin"), (RL["end"], np.zeros(6), "io")])


def reload_gun_tp(t):
    v = TP_RELOAD_GUN(t)
    return P0 + v[:3], dict(yaw=v[3], pitch=v[4], roll=v[5])


def _G(t):
    p, off = reload_gun_tp(t)
    return gun_matrix(p, off["yaw"], off["pitch"], off["roll"])


def bottle_frame(nozzle, axis, roll=0.0, scale=BOTTLE_SCALE_TP):
    """Bottle world frame (character space): +Y = axis toward the nozzle, nozzle tip at `nozzle` (m); roll (deg)
    turns the bottle about its own axis (chooses how the fist sits on it)."""
    y = np.asarray(axis, float); y /= np.linalg.norm(y)
    x = np.cross(y, [0.0, 0.0, 1.0])
    if np.linalg.norm(x) < 1e-6: x = np.cross(y, [1.0, 0.0, 0.0])
    x /= np.linalg.norm(x); z = np.cross(x, y)
    R = np.stack([x, y, z], 1) @ Rot.from_euler("Y", roll, degrees=True).as_matrix()
    M = np.eye(4); M[:3, :3] = R
    M[:3, 3] = np.asarray(nozzle, float) - y * wd.BOTTLE_NOZZLE[1] * S_TP * scale
    return M


def bottle_at_hand(hand_pos, axis, roll=0.0, scale=BOTTLE_SCALE_TP):
    """Rigid bottle frame whose grab socket (the fist, Weapon_L) lands at hand_pos."""
    B = bottle_frame([0.0, 0.0, 0.0], axis, roll, scale)
    B[:3, 3] = np.asarray(hand_pos, float) - B[:3, :3] @ (BOTTLE_GRAB_TP[:3, 3] * S_TP * scale)
    return B


BOTTLE_KEYS_TP = None
# pour geometry (character space): where the bottle body lies from the nozzle, nozzle offsets from the filler hole
POUR_DIR = np.array([0.80, 0.42, 0.12])
HIP_AXIS = np.array([0.05, 1.0, 0.25])
BOTTLE_ROLL = dict(hip=-165.0, arrive=150.0, pour0=170.0, pour1=180.0, untip=150.0)   # from tune_bottle(), made continuous


def bottle_key_frames(roll=None):
    roll = dict(BOTTLE_ROLL, **(roll or {}))
    Wp = wd.world_nodes(_G(1.6), 0.0, 0.5, 1.0)
    op = Wp["Opening"][:3, 3]; n = _nrm(Wp["Opening"])[:, 0]
    hip = LEFT_REST_POS + np.array([-0.005, 0.03, 0.03])
    d = POUR_DIR / np.linalg.norm(POUR_DIR)
    up = d * 0.4 + np.array([0.0, 1.0, 0.0])
    return [
        ("hip", RL["bottle_in"], bottle_at_hand(hip, HIP_AXIS, roll["hip"])),
        ("arrive", RL["arrive"], bottle_frame(op + n * 0.05 + d * 0.035, -d * 0.3 + np.array([0, 1.0, 0]), roll["arrive"])),
        ("pour0", RL["pour0"], bottle_frame(op + n * 0.026, -d + np.array([0.0, -0.05, 0.0]), roll["pour0"])),
        ("pour1", RL["pour1"], bottle_frame(op + n * 0.022, -d + np.array([0.0, -0.30, 0.0]), roll["pour1"])),
        ("untip", RL["untip"], bottle_frame(op + n * 0.055 + d * 0.04, -d * 0.3 + np.array([0, 1.0, 0]), roll["untip"])),
        ("hip", RL["bottle_out"], bottle_at_hand(hip, HIP_AXIS, roll["hip"])),
    ]


def build_bottle_keys():
    global BOTTLE_KEYS_TP
    BOTTLE_KEYS_TP = [(t, M) for _, t, M in bottle_key_frames()]


def bottle_world_tp(t):
    ks = BOTTLE_KEYS_TP
    if t <= ks[0][0]: return ks[0][1]
    for (t0, A0), (t1, A1) in zip(ks, ks[1:]):
        if t <= t1:
            u = ease((t - t0) / (t1 - t0), "io")
            M = blend_frames(A0, A1, u)
            if (t0, t1) in ((RL["bottle_in"], RL["arrive"]), (RL["untip"], RL["bottle_out"])):
                M[:3, 3] += np.sin(np.pi * u) * BULGE
            if RL["pour0"] < t < RL["pour1"]:
                M = M.copy(); M[:3, 3] += np.array([0.0012 * np.sin(t * 38), 0.0008 * np.sin(t * 29 + 1), 0.0])
            M[:3, :3] = M[:3, :3]
            return M
    return ks[-1][1]


def bottle_local_tp(t, G):
    if not A.bottle_visible(t): return None
    B = bottle_world_tp(t).copy()
    B[:3, :3] = B[:3, :3] * (S_TP * BOTTLE_SCALE_TP)
    return np.linalg.inv(G) @ B


LEFT_REST_POS = None


def _relaxed_target(base):
    p = left_relaxed(base)
    return normalized(ch.world(p)["Weapon_L"])


def mix(*pairs):
    def fn(Wn, pose):
        M = normalized(pairs[0][1](Wn, pose))
        for w, f in pairs[1:]:
            if w > 0: M = blend_frames(M, normalized(f(Wn, pose)), w)
        return M
    return fn


BULGE = np.array([0.045, 0.0, 0.07])          # hand paths between the hip and the gun go AROUND the belly (m, at mid-path)


def arc(f0, f1, u, push=BULGE):
    """Hand target moving from f0 to f1 (u = eased 0..1) on a path pushed out by `push` at mid-way."""
    def fn(Wn, pose):
        M = blend_frames(normalized(f0(Wn, pose)), normalized(f1(Wn, pose)), u)
        M[:3, 3] += np.sin(np.pi * u) * np.asarray(push)
        return M
    return fn


def relaxed(Wn, pose):
    return RELAXED_W


def ch_(f):
    return lambda Wn, pose: f(Wn)


RELAXED_W = None


def c_reload(t, bk):
    p, off = reload_gun_tp(t)
    G = gun_matrix(p, off["yaw"], off["pitch"], off["roll"])
    ct = A.cap_turn_at(t); hg = float(A.HINGE_T(t))
    bot = bottle_local_tp(t, G)
    h, lift = A.claw_state(t)                       # same 2-stroke re-grip as FP
    S1, S2 = A.S1, A.S2
    claw = lambda hh, ll=0.0: ch_(cap_push(CAP_PHI_TP + hh, ll))
    bot_h = lambda Wn, pose: bottle_hand(Wn)
    lf = 0.35; wr = 1.0
    if t < RL["reach"]:
        u = ease(t / RL["reach"], "io")
        lh = JB("relaxed", ("at", RL["reach"]), u, "reach"); lf = 0.35 + 0.55 * u
    elif t < RL["grab"]:
        u = ease((t - RL["reach"]) / (RL["grab"] - RL["reach"]), "io")
        lh = mix((1, claw(-S1, 0.45)), (u, claw(-S1, 0.0))); lf = 0.9 + 0.3 * u
    elif t < RL["open1"]:
        if t < RL["open0"]:
            lh = claw(h, lift); lf = 1.25 - 3.0 * lift
        else:
            u = (t - RL["open0"]) / (RL["open1"] - RL["open0"])
            lh = mix((1, claw(h)), (ease(max(0.0, (u - 0.55) / 0.45), "io"), claw(h, 0.6))); lf = 1.2 - 0.5 * u
    elif t < RL["bottle_in"]:
        u = ease((t - RL["open1"]) / (RL["bottle_in"] - RL["open1"]), "io")
        B0 = BOTTLE_KEYS_TP[0][1]
        hip_hand = lambda Wn, pose: _bottle_hand_world(B0)
        lh = JB(("at", RL["open1"] - 1e-4), ("at", RL["bottle_in"]), u, "tohip"); lf = 0.7 + 0.3 * u
    elif t < RL["bottle_out"]:
        lh = bot_h; lf = A.BOTTLE_CURLS
    elif t < RL["back"]:
        u = ease((t - RL["bottle_out"]) / (RL["back"] - RL["bottle_out"]), "io")
        B0 = BOTTLE_KEYS_TP[-1][1]
        hip_hand = lambda Wn, pose: _bottle_hand_world(B0)
        lh = JB(("at", RL["bottle_out"] - 1e-4), ("at", RL["back"]), u, "fromhip"); lf = 0.9 + 0.1 * u
    elif t < RL["close1"]:
        u = ease((t - RL["back"]) / (RL["close1"] - RL["back"]), "io")
        lh = mix((1, claw(S1, 0.3)), (u, claw(S1, 0.0))); lf = 1.0 + 0.15 * u
    elif t < RL["screw1"]:
        lh = claw(h, lift); lf = 1.2 - 3.0 * lift
    elif t < RL["leave"] + 0.2:
        u = ease((t - RL["screw1"]) / (RL["leave"] + 0.2 - RL["screw1"]), "io")
        lh = JB(("at", RL["screw1"] - 1e-4), "relaxed", u, "leave"); lf = 1.15 - 0.8 * u
    else:
        lh = None
    ws = dict(cap_turn=ct, hinge=hg, bottle=bot, level=float(A.LEVEL_T(t)))
    return bk.frame(body("TP_Aim_HexSniper", 0.0), p, off, lh=lh, ws=ws, lf=lf, rfi=0.9, wrotL=wr)


def tune_bottle(step=30):
    """Pick, for each bottle key, the roll about the bottle axis that the left arm reaches best (IK error)."""
    base = body("TP_Aim_HexSniper", 0.0)
    best = {}
    for name, t, _ in bottle_key_frames():
        if name in best: continue
        p, off = reload_gun_tp(t)
        G = gun_matrix(p, off["yaw"], off["pitch"], off["roll"])
        pose, xR, eR, rR = solve_right(base, G)
        W = ch.world(pose); Ga = W["Weapon_R"] @ M_TP @ S_ROOT
        res = []
        for r in range(-180, 180, step):
            B = [M for n_, t_, M in bottle_key_frames({name: float(r)}) if n_ == name][0]
            p2, xL, eL, rL = solve_left(pose, _bottle_hand_world(B), w_rot=1.0)
            res.append((eL * 1000 + rL, r, eL * 1000, rL))
        res.sort()
        best[name] = float(res[0][1])
        print(name, "best roll", res[0][1], f"{res[0][2]:.1f}mm {res[0][3]:.1f}deg", " | ", " ".join(f"{r}:{e:.0f}" for e, r, _, _ in sorted(res, key=lambda x: x[1])), flush=True)
    return best


def _bottle_hand_world(B):
    Bs = B.copy(); Bs[:3, :3] = Bs[:3, :3] * (S_TP * BOTTLE_SCALE_TP)
    M = Bs @ BOTTLE_GRAB_TP
    return normalized(M)


TP_CLIPS = {
    "TP_Hold_WaterFamas": (c_hold, 2.0, 30, True, HOLD_CH),
    "TP_Run_WaterFamas": (c_run, 0.8, 30, True, RUN_CH),
    "TP_Aim_WaterFamas": (c_aim, 2.0, 30, True, HOLD_CH),
    "TP_Raise_WaterFamas": (c_raise, 0.25, 120, False, RAISE_CH),
    "TP_Lower_WaterFamas": (c_lower, 0.25, 120, False, RAISE_CH),
    "TP_Fire_WaterFamas": (c_fire, A.BURST_DUR, 120, False, HOLD_CH),
    "TP_Reload_WaterFamas": (c_reload, RL["end"], 60, False, HOLD_CH),
}


def setup():
    """Key pose + everything derived from it (call once before baking / previewing)."""
    global P0, RELAXED_W, LEFT_REST_POS
    init_key()
    P0 = np.asarray(KEY["p"], float)
    RELAXED_W = _relaxed_target(body("TP_Aim_HexSniper", 0.0))
    LEFT_REST_POS = RELAXED_W[:3, 3].copy()
    build_reload_gun(); build_bottle_keys()


P0 = None


def load_key():
    setup()


def bake(name):
    fn, dur, fps, loop, chans = TP_CLIPS[name]
    chans = sorted(set(chans) | {(b, "rotation") for b in FINGERS_L + FINGERS_R + ARM["L"] + ARM["R"] + ["Spine_1"]}
                   | {("Weapon_R", "translation")})
    n = int(round(dur * fps)) + 1
    bk = Baker()
    frames, ws, errs = [], [], []
    for i in range(n):
        t = min(i / fps, dur)
        pose, w, err = fn(t, bk)
        frames.append({b: pose[b] for b in set(c[0] for c in chans)})
        ws.append(dict(trig=w["trig"], cap_turn=w["cap_turn"], hinge=w["hinge"],
                       bottle=None if w["bottle"] is None else np.array(w["bottle"]), level=w["level"]))
        errs.append(err)
    errs = np.array(errs)
    print(f"{name:28s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
          f"maxR={errs[:, 0].max() * 1000:.2f}mm/{errs[:, 1].max():.2f}deg", flush=True)
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=ws, channels=chans, errors=errs)


# ---------------------------------------------------------------- preview
def render_tp(pose, ws, eye, target=(0.0, 0.40, 0.1), size=(420, 420), fov=32, label=None, marks=()):
    from scene import drawables
    from raster import Renderer, look_at
    p = dict(REST); p.update(pose)
    W = ch.world(p)
    G = W["Weapon_R"] @ M_TP @ S_ROOT
    ws = ws or {}
    Wn = wd.world_nodes(G, ws.get("trig", 0.0), ws.get("cap_turn", 0.0), ws.get("hinge", 0.0), ws.get("bottle"))
    r = Renderer(*size, fov=fov)
    r.set_camera(look_at(np.array(eye, float), np.array(target, float)))
    for d in drawables(ch, W): r.draw(*d)
    wd.draw_weapon(r, Wn, water_level=ws.get("level", 1.0))
    return r.image(label=label, markers=list(marks))


VIEWS = ([1.3, 0.75, 1.5], [-1.4, 0.7, 1.2], [0.25, 0.9, 1.8], [1.6, 0.5, -0.4])


def sheet(poses_ws, path, views=VIEWS, labels=None):
    from PIL import Image
    ims = []
    for k, (pose, ws) in enumerate(poses_ws):
        for eye in views:
            ims.append(render_tp(pose, ws, eye, label=(labels[k] if labels else None)))
    nc = len(views)
    out = Image.new("RGB", (420 * nc, 420 * len(poses_ws)))
    for k, im in enumerate(ims): out.paste(im, ((k % nc) * 420, (k // nc) * 420))
    out.save(path)


if __name__ == "__main__" and sys.argv[1:2] == ["key"]:
    pose, err = init_key()
    print("key errors", err)
    for s in "LR":
        print(" | ".join(f"{b}: {delta_st(pose, b)[0]:.0f}/{delta_st(pose, b)[1]:.0f}" for b in ARM[s]))
    pose = apply_fingers(pose)
    sheet([(pose, {})], sys.argv[2] if len(sys.argv) > 2 else "tp_key.png")


if __name__ == "__main__" and sys.argv[1:2] not in (["key"], ["sheet"]):
    setup()
    OUT = os.environ.get("OUT", "tp_clips.pkl")
    todo = sys.argv[1:] or list(TP_CLIPS)
    try:
        out = pickle.load(open(OUT, "rb"))
    except Exception:
        out = {}
    for nm in todo:
        out[nm] = bake(nm)
        out["_meta"] = dict(mount=M_TP, channels=HOLD_CH, key=dict(p=P0, spine=KEY["spine"], left=KEY["left"]),
                            bottle_scale=BOTTLE_SCALE_TP, s_tp=S_TP)
        pickle.dump(out, open(OUT, "wb"))

if __name__ == "__main__" and sys.argv[1:2] == ["sheet"]:
    # python3 author_tp.py sheet out.png clip t1 t2 ...   (renders the clip functions directly, no bake)
    setup()
    fn = TP_CLIPS[sys.argv[3]][0]
    rows = []
    for tt in [float(x) for x in sys.argv[4:]]:
        bk = Baker()
        pose, w, err = fn(tt, bk)
        print(f"t={tt:.2f} eR {err[0]*1000:.1f}mm {err[1]:.1f}deg  eL {err[2]*1000:.1f}mm {err[3]:.1f}deg")
        rows.append((pose, w))
    sheet(rows, sys.argv[2], labels=[f"{sys.argv[3]} t={x}" for x in sys.argv[4:]])
