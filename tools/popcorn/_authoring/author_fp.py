"""FP pose-library authoring for the Popcorn Shotgun (IK-driven, same channel set as the HexSniper).

Every frame: the weapon placement is authored in CAMERA space, the right arm is solved so Weapon_R
carries the weapon there (the weapon is parented to Weapon_R at runtime, so it follows exactly), then
the left arm is solved against the ACTUAL weapon/pump/lid transforms of that frame (hand glued).
"""
import pickle, sys
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from fp_common import arms, hold_ref, mount_from, weapon_root_world, S_ROOT, render
import weapon_def as wd
import weapon_parts as wp
from ik import ChainIK
from anim_util import Track, ease, normalized, frame_from, blend_frames, rotz, rotx, roty, noise1
from rig import trs, qaxis, qmul, quat_to_mat3, mat3_to_quat, qnorm

# ---------------------------------------------------------------- setup
MOUNT_OFFSET = (0.04, -0.24, 0.0)
M_FP = mount_from(offset_local=MOUNT_OFFSET)
GUN_SCALE = wd.ROOT_SCALE * float(np.linalg.norm(M_FP[:3, 0]))  # world metres per weapon unit (≈0.076)
HOLD = dict(grip=np.array([0.254, -0.281, -0.508]), yaw=12.0, pitch=0.0, roll=0.0)   # v2: HexSniper hold framing
AIM = dict(grip=np.array([0.20, -0.276, -0.495]), yaw=0.0, pitch=0.0, roll=0.0)    # v2: HexSniper straight (ADS) framing


def offhand_frame(roll_deg=35, x_off=-0.06, below=0.08):
    y = np.array([-1.0, 0, 0])
    a = np.radians(roll_deg)
    x = np.array([0, np.cos(a), -np.sin(a)])
    z = np.cross(x, y)
    F = np.eye(4); F[:3, :3] = np.stack([x, y, z], axis=1); F[:3, 3] = -x * below + np.array([x_off, 0, 0])
    return F


HEX = hold_ref()


def hex_offhand_frame(dx=0.0, dy=0.0, dz=0.0):
    """v2 — the left palm keeps EXACTLY the HexSniper hold orientation relative to the weapon (palm up,
    forearm coming from below-left): the pump was moved/thickened to sit where the Potato's left hand
    naturally rests, so only a small translation remains (object centre on the pump axis)."""
    W = arms.world(HEX)
    G = W["Weapon_R"] @ M_FP @ S_ROOT
    L = np.linalg.inv(G) @ W["Weapon_L"]
    F = np.eye(4)
    F[:3, :3] = L[:3, :3] / np.linalg.norm(L[:3, :3], axis=0)
    F[:3, 3] = [L[0, 3] - wd.PUMP_ORIGIN[0] + dx, dy, dz]
    return F


# v3 — pump grip FITTED on the real hand mesh (grip_fit.py): palm under the pump, fingers closed until
# they touch the far side, thumb along the near side (never clawing over the top), no penetration.
import json as _json
_GRIP = _json.load(open("pump_grip.json"))
GRIP_ROLL = -25.0          # v4: hand rolled 25° around the pump axis (palm toward the player side) -> straight arm


def _rx4(deg):
    M = np.eye(4); c, s_ = np.cos(np.radians(deg)), np.sin(np.radians(deg)); M[1:3, 1:3] = [[c, -s_], [s_, c]]; return M


OFFHAND_FIT = np.array(_GRIP["offhand_local"], float)
wd.OFFHAND_LOCAL = _rx4(GRIP_ROLL) @ OFFHAND_FIT
PUMP_CURLS = {k: float(v) for k, v in _GRIP["curls"].items()}


def gripmix(w_pump, s_other):
    """Finger curls blended between the fitted pump grip (w_pump=1) and a uniform curl."""
    w = float(np.clip(w_pump, 0, 1))
    return {n: PUMP_CURLS[n] * w + s_other * (1 - w) for n in PUMP_CURLS}
V0 = HEX["FP_Viewmodel"]
ikR = ChainIK(arms, ["Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R"], "Weapon_R",
              rot_bones=["UpperArm_R", "LowerArm_R", "Hand_R"], trans_bones=["Shoulder_R"])
ikL = ChainIK(arms, ["Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L"], "Weapon_L",
              rot_bones=["UpperArm_L", "LowerArm_L", "Hand_L"], trans_bones=["Shoulder_L"])

FINGERS_L = ["Index_L_1", "Middle_L_1", "Ring_L_1", "Thumb_L_1"]
FINGERS_R = ["Index_R_1", "Middle_R_1", "Ring_R_1", "Thumb_R_1"]
REST = arms.rest_pose()

# The exported channel set (identical to the HexSniper FP clips).
CHANNELS = [("FP_Viewmodel", "translation"), ("FP_Viewmodel", "rotation"), ("Hips", "translation"), ("Hips", "rotation"),
            ("Shoulder_L", "translation"), ("Shoulder_R", "translation")] + \
           [(b, "rotation") for b in ["UpperArm_L", "LowerArm_L", "Hand_L", "UpperArm_R", "LowerArm_R", "Hand_R"]
            + FINGERS_L + FINGERS_R]


def finger_q(name, s):
    """Curl a finger: s=0 rest (open), s=1 HexSniper grip curl, s>1 tighter."""
    rq = REST[name][1]
    hq = HEX[name][1]
    d = Rot.from_quat(qmul(np.array([-rq[0], -rq[1], -rq[2], rq[3]]), hq)).as_rotvec()
    return qnorm(qmul(rq, Rot.from_rotvec(d * s).as_quat()))


def gun_matrix(grip_pos, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon ROOT world matrix with the GRIP point at grip_pos (camera space).
    yaw +: muzzle to the left; pitch +: muzzle up; roll +: top to the right."""
    base = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]]).T
    R = roty(yaw) @ rotx(pitch) @ quat_to_mat3(qaxis([0, 0, 1], np.radians(-roll))) @ base
    G = np.eye(4); G[:3, :3] = R * GUN_SCALE   # root 0.19 × FP mount 0.4
    G[:3, 3] = np.asarray(grip_pos) - G[:3, :3] @ wd.GRIP
    return G


def place(base, d=None):
    """Apply an additive offset dict to a placement dict."""
    d = d or {}
    return dict(grip=base["grip"] + np.asarray(d.get("grip", (0, 0, 0))), yaw=base["yaw"] + d.get("yaw", 0.0),
                pitch=base["pitch"] + d.get("pitch", 0.0), roll=base["roll"] + d.get("roll", 0.0))


def lerp_place(a, b, u):
    return dict(grip=a["grip"] * (1 - u) + b["grip"] * u, yaw=a["yaw"] * (1 - u) + b["yaw"] * u,
                pitch=a["pitch"] * (1 - u) + b["pitch"] * u, roll=a["roll"] * (1 - u) + b["roll"] * u)


# ---------------------------------------------------------------- arm aesthetics (soft constraints)
def _hinge(v):
    return np.maximum(v, 0.0)


def keep_left(wl):
    """The long FP sleeve hangs from UpperArm_L: keep its root left of / below the hand so the
    arm always enters from the bottom-left and never crosses in front of the tank."""
    ua = wl["UpperArm_L"][:3, 3]; h = wl["Weapon_L"][:3, 3]; sh = wl["Shoulder_L"][:3, 3]
    return 1000.0 * 0.6 * np.array([_hinge(ua[0] - (h[0] - 0.10)), _hinge(ua[1] - (h[1] - 0.05)),
                                    _hinge(sh[0] - (h[0] + 0.02)), _hinge(sh[1] - (h[1] - 0.03))])


from twist import swing_twist as _swing_twist


def _local_q(wl, parent, child):
    Mp = wl[parent][:3, :3] / np.linalg.norm(wl[parent][:3, :3], axis=0)
    Mc = wl[child][:3, :3] / np.linalg.norm(wl[child][:3, :3], axis=0)
    return mat3_to_quat(Mp.T @ Mc)


# Soft joint limits (degrees, bone-local swing / twist about the bone axis). They stop the IK from
# solving a target with a corkscrewed wrist (candy-wrapper skinning) — v3 fix of the reload.
LIMITS = {"Hand": (72.0, 32.0), "LowerArm": (125.0, 40.0)}


def joint_limits(wl, side):
    out = []
    for parent, child, key in ((f"LowerArm_{side}", f"Hand_{side}", "Hand"), (f"UpperArm_{side}", f"LowerArm_{side}", "LowerArm")):
        sw, tw = _swing_twist(_local_q(wl, parent, child))
        smax, tmax = LIMITS[key]
        out += [max(0.0, sw - smax) * 4.0, max(0.0, abs(tw) - tmax) * 6.0]
    return np.array(out)


SLEEVE_LEN = 0.45            # the FP sleeve runs ~0.5 m behind the shoulder joint: its end must stay off screen
_F65 = 1 / np.tan(np.radians(65) / 2)


def sleeve_offscreen(wl, side="L"):
    """v4: the sleeve end (UpperArm joint - 0.45 m along the upper arm) must stay below the bottom edge of the
    screen (or behind the camera) — no telescopic tube entering from the side of the screen."""
    ua = wl[f"UpperArm_{side}"][:3, 3]; el = wl[f"LowerArm_{side}"][:3, 3]
    d = (el - ua) / np.linalg.norm(el - ua)
    end = ua - d * SLEEVE_LEN
    mid = ua - d * SLEEVE_LEN * 0.5
    out = []
    for p in (mid, end):
        if p[2] > -0.03:
            out.append(0.0); continue
        ndc_y = _F65 * p[1] / -p[2]
        out.append(max(0.0, ndc_y + 1.08) * 60.0)
    return np.array(out)


def keep_left_limited(wl):
    return np.concatenate([keep_left(wl), joint_limits(wl, "L"), sleeve_offscreen(wl, "L")])


def keep_right_limited(wl):
    return np.concatenate([keep_right(wl), joint_limits(wl, "R")])


from straight import straight_residual


def left_extra(w_straight=0.6):
    """v4: joint limits + sleeve side + STRAIGHT ARM ON SCREEN (elbow/wrist bends ~0, hex-like twists)."""
    if w_straight <= 0:
        return keep_left_limited
    return lambda wl: np.concatenate([keep_left_limited(wl), straight_residual(wl, w_bend=w_straight), upper_arm_rises(wl)])


def upper_arm_rises(wl, a_min=38.0, a_max=100.0, w=0.8):
    """v4: the upper arm comes UP from the bottom of the screen (screen angle between a_min and a_max degrees);
    stops the straight-arm objective from laying the arm flat when the hand direction turns horizontal."""
    from straight import screen_angles
    a = screen_angles(wl, "L")[0]
    return np.array([max(0.0, a_min - a) * w, max(0.0, a - a_max) * w])


def keep_right(wl):
    ua = wl["UpperArm_R"][:3, 3]; h = wl["Weapon_R"][:3, 3]
    return 1000.0 * 0.6 * np.array([_hinge((h[0] - 0.02) - ua[0]), _hinge(ua[1] - (h[1] - 0.12))])


# ---------------------------------------------------------------- reference hold solve
def solve_pose(spec, xR=None, xL=None, ref=None, base_pose=None):
    """spec: dict(place, pump, lid, trig, lh(Wn)->4x4, lf, rf, rfi). Returns (pose, wstate, xR, xL, err)."""
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
    Wn = wd.world_nodes(Ga, spec.get("pump", 0.0), spec.get("lid", 0.0), spec.get("trig", 0.0))
    tgtL = normalized(spec["lh"](Wn))
    pose0 = pose
    exL = left_extra(spec.get("straight", 0.6))
    pose, xL1, eL, rL = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 0.5),
                                  reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=xL, extra=exL)
    on_pump = spec.get("on_pump", spec["lh"] is pump_hand)
    if (on_pump and rL > 1.0 or rL > 4.0) and xL is not None:
        # joint limits make the landscape non-convex: back on the pump, re-solve from the Hold basin
        p2, x2, e2, r2 = ikL.solve(pose0, W, tgtL, ref, w_rot=spec.get("wrotL", 0.5),
                                   reg_rot=spec.get("regL", [0.12, 0.02, 0.02]), reg_trans=0.02, x0=None, extra=exL)
        if r2 < rL:
            pose, xL1, eL, rL = p2, x2, e2, r2
    xL = xL1
    # fingers
    lf = spec.get("lf", PUMP_CURLS)
    lfs = lf if isinstance(lf, dict) else {n: lf for n in FINGERS_L}
    for n in FINGERS_L:
        pose[n] = (REST[n][0], finger_q(n, lfs.get(n, 1.0)), REST[n][2])
    rf = spec.get("rf", 1.0)
    for n in FINGERS_R:
        s = spec.get("rfi", rf) if n == "Index_R_1" else rf
        pose[n] = (REST[n][0], finger_q(n, s), REST[n][2])
    return pose, (spec.get("pump", 0.0), spec.get("lid", 0.0), spec.get("trig", 0.0)), xR, xL, (eR, rR, eL, rL)


def pump_hand(Wn):
    return Wn["Offhand"]


REF = None
_p, _, _, _, _ = solve_pose(dict(place=HOLD, lh=pump_hand), ref=HEX, base_pose=HEX)
REF = _p
W_REF = arms.world(REF)
REF_WL = normalized(W_REF["Weapon_L"])


def rest_hand(_Wn=None):
    """Left hand dropped out of the way (one-handed inspect / equip)."""
    M = np.eye(4)
    M[:3, :3] = REF_WL[:3, :3]                        # v3: same (natural) orientation as the grip
    M[:3, 3] = REF_WL[:3, 3] + np.array([-0.13, -0.26, 0.12])
    return M


# ---------------------------------------------------------------- lid / tank hand frames
# Hand frames are authored in WEAPON units and applied through the (0.19-scaled) node matrices;
# solve_pose() normalizes the result before the IK.
def lid_lift(Wn):
    """Hand on the LEFT side of the tank at the rear corner, palm toward the tank, fingertips under the
    lid's rear-left corner: flicks it up (the arm stays left of the tank, never across the view)."""
    f = np.array([-0.35, 1.0, -0.15]); f /= np.linalg.norm(f)          # finger direction (lid-local)
    n = np.array([0.0, 0.0, -1.0])                                    # palm faces the tank side
    tip = np.array([wd.LID_LEN - 0.10, -0.04, 0.60])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, 3] = tip - f * 0.55 - F[:3, 0] * 0.13
    return Wn["TankLid"] @ F


def lid_hook(Wn):
    """Hand on the inner face of the OPEN lid, fingers hooked over its free edge (top-left corner)."""
    f = np.array([1.0, 0.25, -0.2]); f /= np.linalg.norm(f)
    n = np.array([-0.25, 1.0, 0.0]); n /= np.linalg.norm(n)
    edge = np.array([wd.LID_LEN, 0.0, 0.42])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, 3] = edge - f * 0.52 - F[:3, 0] * 0.14
    return Wn["TankLid"] @ F


def lid_press(Wn, t=0.0, bounce=0.0):
    """Palm flat on top of the (closing / closed) lid, rear-left area, fingers toward the muzzle."""
    f = np.array([-1.0, 0.0, -0.45]); f /= np.linalg.norm(f)
    n = np.array([0.0, -1.0, 0.0])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, 3] = np.array([wd.LID_LEN * 0.78, 0.2226 + 0.12 + bounce, 0.30])
    return Wn["TankLid"] @ F


def sprinkle(Wn, t=0.0, amp=1.0):
    """Fist above the open tank (left half), palm down, shaking kernels in."""
    f = np.array([0.15, 0.0, -1.0]); f /= np.linalg.norm(f)
    n = np.array([0.0, -1.0, 0.0])
    w = 2 * np.pi * 9
    sh = amp * np.array([0.10 * np.sin(t * w), 0.07 * abs(np.sin(t * w)), 0.04 * np.sin(t * w / 2)])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, :3] = F[:3, :3] @ rotx(amp * 12 * np.sin(t * w))
    F[:3, 3] = np.array([0.10, wd.TANK_HALF[1] + 0.95, 0.38]) + sh
    return Wn["Tank"] @ F


def mix(*pairs):
    """Blend a sequence of (weight, fn) — weights are cumulative blend factors applied left→right."""
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
    return dict(place=place(HOLD, breathing(t, 2.0)), lh=pump_hand)


def clip_aim(t):
    return dict(place=place(AIM, breathing(t, 2.0, 0.5)), lh=pump_hand)


RUN_BASE = place(HOLD, dict(grip=(0.012, -0.028, 0.03), yaw=7.0, pitch=-9.0, roll=-17.0))


def clip_run(t):
    ph = 2 * np.pi * t / 0.8
    d = dict(grip=(0.008 * np.sin(ph), 0.010 * np.cos(2 * ph) - 0.002, 0.004 * np.cos(2 * ph)),
             yaw=1.8 * np.sin(ph), pitch=2.2 * np.cos(2 * ph + 0.4), roll=3.0 * np.sin(ph + 0.3))
    return dict(place=place(RUN_BASE, d), lh=pump_hand)


def clip_raise(t, dur=0.3):
    u = ease(t / dur, "io")
    return dict(place=lerp_place(HOLD, AIM, u), lh=pump_hand)


def clip_lower(t, dur=0.3):
    u = ease(t / dur, "io")
    return dict(place=lerp_place(AIM, HOLD, u), lh=pump_hand)


# --- fire
KICK = Track([(0, 0), (0.045, 1.0, "out"), (0.17, 0.30, "io"), (0.30, -0.04, "io"), (0.42, 0.0, "io")])
PUMP_FIRE = Track([(0, 0), (0.26, 0), (0.39, 1.0, "io"), (0.42, 1.0, "lin"), (0.54, 0.0, "in2")])
TRIG_FIRE = Track([(0, 0), (0.025, 18.0, "out"), (0.10, 18.0, "lin"), (0.18, 0.0, "io")])
INDEX_FIRE = Track([(0, 1.0), (0.025, 1.35, "out"), (0.10, 1.35, "lin"), (0.18, 1.0, "io")])


def pump_body(t, t0, t_back, t_hold, t_fwd, amp=1.0):
    """Gun reaction while racking: cant toward the left hand, then a small slam jolt."""
    b = Track([(t0, 0), (t_back, 1.0, "io"), (t_hold, 1.0, "lin"), (t_fwd, 0.0, "io")])(t)
    slam = Track([(t_fwd - 0.001, 0), (t_fwd + 0.03, 1.0, "out"), (t_fwd + 0.14, 0.0, "io")])(t) if t > t_fwd - 0.001 else 0.0
    return dict(grip=amp * np.array([-0.006 * b, -0.004 * b, -0.004 * b - 0.004 * slam]),
                roll=amp * (-5.0 * b), pitch=amp * (-2.5 * b + 1.2 * slam), yaw=amp * (1.5 * b))


def add(*ds):
    out = dict(grip=np.zeros(3), yaw=0.0, pitch=0.0, roll=0.0)
    for d in ds:
        out["grip"] = out["grip"] + np.asarray(d.get("grip", (0, 0, 0)))
        for k in ("yaw", "pitch", "roll"):
            out[k] += d.get(k, 0.0)
    return out


def kick_offsets(k):
    return dict(grip=(0.004 * k, 0.012 * k, 0.044 * k), pitch=13.0 * k, roll=3.0 * k, yaw=-1.5 * k)


def clip_fire(t):
    k = KICK(t)
    d = add(kick_offsets(k), pump_body(t, 0.24, 0.39, 0.42, 0.54))
    return dict(place=place(HOLD, d), pump=float(PUMP_FIRE(t)), trig=float(TRIG_FIRE(t)), rfi=float(INDEX_FIRE(t)),
                lh=pump_hand)


def clip_fire_last(t):
    k = KICK(t)
    return dict(place=place(HOLD, kick_offsets(k)), trig=float(TRIG_FIRE(t)), rfi=float(INDEX_FIRE(t)), lh=pump_hand)


# --- reload (2.2 s) — v4: the v2 choreography the user liked (flick the lid open, sprinkle kernels, hook
# the lid shut, pops, rack) — but the GUN comes to the left hand (key placements solved jointly with both
# arms by keypose.py: straight arm on screen, wrist twist ~-5°, forearm twist ~7°).
RL = dict(lift0=0.06, lift1=0.24, flick1=0.32, spr0=0.44, spr1=0.64, hook0=0.72, pull1=0.80, slam=0.88,
          ret1=1.08, pop0=0.92, pop1=1.75, rack0=1.80, rack_b=1.90, rack_h=1.93, rack_f=2.03, end=2.20)
RELOAD_LID = Track([(0, 0), (RL["lift1"], 0), (RL["flick1"], 60, "lin"), (0.42, 105, "out"), (0.46, 98, "io"), (0.51, 105, "io"),
                    (RL["hook0"], 105, "lin"), (RL["pull1"], 45, "io"), (RL["slam"], 0, "in2")])
RELOAD_PUMP = Track([(0, 0), (RL["rack0"], 0), (RL["rack_b"], 1.0, "io"), (RL["rack_h"], 1.0, "lin"), (RL["rack_f"], 0.0, "in2")])
import json as _json2
_RK = _json2.load(open("reload_keys_v4b.json"))
_POPD = np.array([0.0, -0.020, 0.0, 6.0, 4.0, -6.0])
#                    grip dx, dy, dz, yaw, pitch, roll  (offsets to HOLD; key values solved by keypose.py)
RELOAD_TILT = Track([(0, np.zeros(6)),
                     (RL["lift1"], _RK["lift"]["d"], "io"),
                     (RL["flick1"] + 0.02, _RK["lift"]["d"], "io"),
                     (RL["spr0"], _RK["sprinkle"]["d"], "io"),
                     (RL["spr1"], _RK["sprinkle"]["d"], "io"),
                     (RL["hook0"], _RK["hook_open"]["d"], "io"),
                     (RL["pull1"], _RK["hook_mid"]["d"], "io"),
                     (RL["slam"], _RK["hook_closed"]["d"], "io"),
                     (RL["ret1"] + 0.04, _POPD, "io"),
                     (1.62, _POPD * 0.8, "io"),
                     (RL["rack0"], [-0.004, 0.004, 0.006, 1.0, 1.5, -3.0], "io"),
                     (RL["end"], np.zeros(6), "io")])
POP_RATE = Track([(RL["pop0"], 0.0), (1.05, 0.5, "io"), (1.30, 1.0, "io"), (1.55, 0.8, "io"), (RL["pop1"], 0.0, "io")])
SPRINKLE_SPIN = _RK["sprinkle"]["phi"]
LIFT_SPIN = _RK["lift"]["phi"]
FLICK_FOLLOW = 28.0          # the fingertips follow the lid only for its first degrees, then let it fly open


def lid_lift_at(Wn, lid_deg):
    """lid_lift evaluated with the lid at `lid_deg` (spun like the solved key pose)."""
    W2 = dict(Wn)
    W2["TankLid"] = Wn["Tank"] @ trs(wd.LID_HINGE - wd.TANK_C, qaxis([0, 0, 1], np.radians(lid_deg)))
    return _spin(lid_lift(W2), LIFT_SPIN)


def _spin(M, phi_deg):
    R = np.eye(4); c, s_ = np.cos(np.radians(phi_deg)), np.sin(np.radians(phi_deg)); R[1:3, 1:3] = [[c, -s_], [s_, c]]
    return normalized(M) @ R


def sprinkle2(Wn, t=0.0, amp=0.0):
    """Fist just above the rear-left rim of the open tank, palm toward the opening, shaking kernels in."""
    pos = np.array([0.30, wd.TANK_HALF[1] + 0.50, 0.40])
    n = -pos.copy(); n[1] = -0.8; n /= np.linalg.norm(n)
    f = np.array([-1.0, 0.0, -0.3]); f /= np.linalg.norm(f)
    w = 2 * np.pi * 9
    sh = amp * np.array([0.08 * np.sin(t * w), 0.06 * abs(np.sin(t * w)), 0.04 * np.sin(t * w / 2)])
    F = frame_from(n, -f, np.zeros(3))
    F[:3, :3] = F[:3, :3] @ rotx(amp * 10 * np.sin(t * w))
    F[:3, 3] = pos + sh
    return _spin(Wn["Tank"] @ F, SPRINKLE_SPIN)


def clip_reload(t):
    v = RELOAD_TILT(t)
    d = dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])
    slam = Track([(RL["slam"] - 0.001, 0), (RL["slam"] + 0.03, 1.0, "out"), (RL["slam"] + 0.16, 0.0, "io")])(t) if t > RL["slam"] - 0.001 else 0.0
    pr = float(POP_RATE(t))
    jig = dict(grip=(0.0015 * pr * noise1(t, 1, 23), -0.005 * slam + 0.002 * pr * noise1(t, 2, 29), 0.001 * pr * noise1(t, 3, 19)),
               pitch=-1.8 * slam + 1.4 * pr * noise1(t, 4, 26), roll=1.6 * pr * noise1(t, 5, 21))
    rack = pump_body(t, RL["rack0"] - 0.02, RL["rack_b"], RL["rack_h"], RL["rack_f"])
    d = add(d, jig, rack)
    lid = float(RELOAD_LID(t))
    pump = float(RELOAD_PUMP(t))
    spr0 = lambda Wn: sprinkle2(Wn, 0.0, 0.0)
    tr = 0.0                   # 1 = middle of a hand transition: orientation left free (the wrist follows the arm)
    lift = lambda Wn, a=min(lid, FLICK_FOLLOW): lid_lift_at(Wn, a)
    if t < RL["lift0"]:
        lh = pump_hand; lf = PUMP_CURLS; wpv = 1.0
    elif t < RL["lift1"]:
        u = ease((t - RL["lift0"]) / (RL["lift1"] - RL["lift0"]), "io")
        lh = mix((1, pump_hand), (u, lift)); lf = gripmix(1 - u, 0.35); wpv = 1 - u; tr = np.sin(np.pi * u)
    elif t < RL["flick1"]:
        lh = lift; lf = 0.35; wpv = 0.0
    elif t < RL["spr0"]:
        u = ease((t - RL["flick1"]) / (RL["spr0"] - RL["flick1"]), "io")
        lh = mix((1, lift), (u, spr0)); lf = 0.35 + 1.15 * u; wpv = 0.0; tr = np.sin(np.pi * u)
    elif t < RL["spr1"]:
        amp = Track([(RL["spr0"], 0), (RL["spr0"] + 0.04, 1.0, "out"), (RL["spr1"] - 0.03, 1.0, "lin"), (RL["spr1"], 0.0, "io")])(t)
        tt = t - RL["spr0"]
        lh = lambda Wn, tt=tt, amp=amp: sprinkle2(Wn, tt, amp); lf = 1.5; wpv = 0.0
    elif t < RL["hook0"]:
        u = ease((t - RL["spr1"]) / (RL["hook0"] - RL["spr1"]), "io")
        lh = mix((1, spr0), (u, lid_hook)); lf = 1.5 - 0.6 * u; wpv = 0.0; tr = np.sin(np.pi * u)
    elif t < RL["slam"] + 0.03:
        lh = lid_hook; lf = 0.9; wpv = 0.0
    elif t < RL["ret1"]:
        u = ease((t - RL["slam"] - 0.03) / (RL["ret1"] - RL["slam"] - 0.03), "io")
        lh = mix((1, lid_hook), (u, pump_hand)); lf = gripmix(u, 0.9); wpv = u; tr = np.sin(np.pi * u)
    else:
        lh = pump_hand; lf = PUMP_CURLS; wpv = 1.0
    return dict(place=place(HOLD, d), pump=pump, lid=lid, lh=lh, lf=lf, rfi=0.9, wrotL=0.6 * (1.0 - 0.92 * tr),
                on_pump=wpv > 0.999, straight=0.35 + 0.25 * wpv,
                regL=[0.12 * wpv + 0.012 * (1 - wpv), 0.02 * wpv + 0.008 * (1 - wpv), 0.02 * wpv + 0.008 * (1 - wpv)])


# --- inspect (3.6 s, one-handed)
INSPECT_GUN = Track([(0, np.zeros(6)),
                     (0.30, [0.004, -0.004, 0.0, -2.0, -1.0, 4.0], "io"),
                     (0.95, [-0.075, 0.075, 0.100, 36.0, 8.0, -12.0], "io"),
                     (1.60, [-0.078, 0.078, 0.104, 41.0, 6.0, -17.0], "io"),
                     (2.30, [-0.055, 0.070, 0.095, -2.0, 20.0, 36.0], "io"),
                     (2.75, [-0.052, 0.068, 0.092, -4.0, 22.0, 41.0], "io"),
                     (3.30, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0], "io"),
                     (3.60, np.zeros(6), "io")])
INSPECT_LH = Track([(0, 0), (0.12, 0), (0.42, 1.0, "io"), (3.02, 1.0, "lin"), (3.38, 0.0, "io")])


def clip_inspect(t):
    v = INSPECT_GUN(t)
    wob = dict(pitch=0.6 * noise1(t, 11, 3.0), roll=0.8 * noise1(t, 12, 2.6)) if 0.9 < t < 2.9 else {}
    d = add(dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5]), wob)
    u = float(INSPECT_LH(t))
    lh = mix((1, pump_hand), (u, rest_hand))
    lf = gripmix(1 - u, 0.45)
    rfi = 1.0 - 0.45 * float(Track([(0, 0), (0.25, 1.0, "io"), (3.1, 1.0, "lin"), (3.4, 0.0, "io")])(t))
    return dict(place=place(HOLD, d), lh=lh, lf=lf, rfi=rfi, wrotL=0.2 + 0.3 * (1 - u))


# --- equip / unequip
EQUIP_GUN = Track([(0, [0.04, -0.21, 0.07, 10.0, -42.0, 32.0]), (0.40, [0.0, 0.006, 0.0, 0.0, 2.5, -1.5], "out"),
                   (0.55, np.zeros(6), "io")])
EQUIP_LH = Track([(0, 1.0), (0.22, 1.0, "lin"), (0.45, 0.0, "io")])


def clip_equip(t):
    v = EQUIP_GUN(t)
    u = float(EQUIP_LH(t))
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])),
                lh=mix((1, pump_hand), (u, rest_hand)), lf=gripmix(1 - u, 0.5), wrotL=0.2 + 0.3 * (1 - u))


UNEQUIP_GUN = Track([(0, np.zeros(6)), (0.35, [0.04, -0.22, 0.07, 10.0, -42.0, 32.0], "in2")])
UNEQUIP_LH = Track([(0, 0.0), (0.18, 1.0, "io")])


def clip_unequip(t):
    v = UNEQUIP_GUN(t)
    u = float(UNEQUIP_LH(t))
    return dict(place=place(HOLD, dict(grip=v[:3], yaw=v[3], pitch=v[4], roll=v[5])),
                lh=mix((1, pump_hand), (u, rest_hand)), lf=gripmix(1 - u, 0.5), wrotL=0.2 + 0.3 * (1 - u))


CLIPS = {
    # name: (spec fn, duration, fps, loop)
    "FP_PopcornShotgun_Hold": (clip_hold, 2.0, 30, True),
    "FP_PopcornShotgun_Run": (clip_run, 0.8, 30, True),
    "FP_Aim_PopcornShotgun": (clip_aim, 2.0, 30, True),
    "FP_Raise_PopcornShotgun": (clip_raise, 0.3, 120, False),
    "FP_Lower_PopcornShotgun": (clip_lower, 0.3, 120, False),
    "FP_Fire_PopcornShotgun": (clip_fire, 0.9, 60, False),
    "FP_FireLast_PopcornShotgun": (clip_fire_last, 0.55, 60, False),
    "FP_Reload_PopcornShotgun": (clip_reload, 2.2, 60, False),
    "FP_Inspect_PopcornShotgun": (clip_inspect, 3.6, 60, False),
    "FP_Equip_PopcornShotgun": (clip_equip, 0.55, 60, False),
    "FP_Unequip_PopcornShotgun": (clip_unequip, 0.35, 60, False),
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
        wstate.append(ws)
        errs.append(err)
    errs = np.array(errs)
    if verbose:
        print(f"{name:32s} frames={n:4d} maxL={errs[:, 2].max() * 1000:.2f}mm/{errs[:, 3].max():.2f}deg "
              f"maxR={errs[:, 0].max() * 1000:.2f}mm/{errs[:, 1].max():.2f}deg")
    return dict(name=name, fps=fps, duration=dur, loop=loop, frames=frames, weapon=wstate, errors=errs)


if __name__ == "__main__":
    names = sys.argv[1:] or list(CLIPS)
    out = {}
    try:
        out = pickle.load(open("fp_clips.pkl", "rb"))
    except Exception:
        pass
    for nm in names:
        out[nm] = bake(nm)
    out["_meta"] = dict(mount=M_FP, hold=HOLD, aim=AIM, offhand=wd.OFFHAND_LOCAL, channels=CHANNELS)
    pickle.dump(out, open("fp_clips.pkl", "wb"))
