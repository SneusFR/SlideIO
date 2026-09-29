"""FP reload v2 of the Water FAMAS — natural arms (no twisted wrist, no hooked arm).

What changed vs v1 (author_fp.clip_reload):
- both arms are solved under fp_natural limits: hand twist <= 12°, forearm twist <= 25° (measured from the rest pose,
  i.e. what the skin sees), elbows pointing down / outward, shoulder slide <= 10 cm, the left upper arm always enters
  from the bottom edge of the screen;
- the gun poses were SEARCHED for those limits (opt/refine_uns2.py, opt/refine_pour.py): unscrew = gun turned to the
  right, low in the centre, cap facing the left hand; pour = same gun tipped nose-down, opening up, bottle from the left;
- the unscrew is shared between the hands: each 90° stroke = the left hand turns 45° while the right hand counter-rolls
  the gun 45° about the tank axis (like opening a jar), then both let go / come back;
- every free-air move of the left arm (to the cap, down to fetch the bottle, back up with it, away) is blended in JOINT
  space between two solved contact poses: natural arcs, no IK fight mid-air.
Same timeline (author_fp.RL) and weapon tracks as v1: the TP reload and the runtime events are unchanged.
"""
import os, sys, pickle
import numpy as np
from scipy.spatial.transform import Rotation as Rot
import author_fp as A
import fp_natural as N
import weapon_def as wd
from fp_common import arms, weapon_root_world, S_ROOT
from anim_util import Track, ease, normalized, blend_frames
from rig import slerp

RL = A.RL
S1, S2 = A.S1, A.S2
SPLIT = 0.5                                                       # share of each stroke done by the gun (right hand)

# searched poses: [node position (camera space), yaw, pitch, roll offsets from HOLD]
UNS_V = [0.0851, -0.1509, -0.5645, -79.493, -8.4928, -9.4514]     # node = Cap (closed)
CAP_PHI2 = -87.7432                                               # claw orientation about the cap axis (stroke centre)
POUR_V = [0.12, -0.1671, -0.5949, -83.564, -41.2545, -9.0722]     # node = Opening (cap open)
BOTTLE_AZ, BOTTLE_EL, BOTTLE_ROLL = -9.3735, -26.7487, 84.3164     # pour0 bottle axis (nozzle direction) + roll


def _place_for(v, node, ws=(0.0, 0.0, 0.0)):
    pl = A.place(A.HOLD, dict(yaw=v[3], pitch=v[4], roll=v[5]))
    G = A.gun_matrix(pl["grip"], pl["yaw"], pl["pitch"], pl["roll"])
    pl["grip"] = pl["grip"] + (np.asarray(v[:3]) - wd.world_nodes(G, *ws)[node][:3, 3])
    return pl


PL_UNS = _place_for(UNS_V, "Cap")
PL_POUR = _place_for(POUR_V, "Opening", (0.0, 0.5, 1.0))


def _vec(pl):
    return np.r_[pl["grip"], pl["yaw"], pl["pitch"], pl["roll"]]


HOLD6, UNS6, POUR6 = _vec(A.HOLD), _vec(PL_UNS), _vec(PL_POUR)
GUN_T = Track([(0, HOLD6), (0.24, UNS6, "io"), (0.88, UNS6, "lin"), (1.22, POUR6, "io"), (2.06, POUR6, "lin"),
               (2.36, UNS6, "io"), (2.95, UNS6, "lin"), (RL["end"], HOLD6, "io")])
COUNTER_W = Track([(0, 0.0), (0.24, 1.0, "io"), (0.70, 1.0, "lin"), (0.88, 0.0, "io"), (2.36, 0.0, "lin"),
                   (2.48, 1.0, "io"), (2.95, 1.0, "lin"), (RL["end"], 0.0, "io")])


def gun_at(t):
    """Weapon root (camera space) at t: the placement track + the counter-roll about the tank axis."""
    v = GUN_T(t)
    G = A.gun_matrix(v[:3], v[3], v[4], v[5])
    w = float(COUNTER_W(t))
    if w > 1e-6:
        h, _ = A.claw_state(t)
        Wn = wd.world_nodes(G)
        ax = normalized(Wn["Tank"])[:3, 0]; cc = Wn["Cap"][:3, 3]
        R = Rot.from_rotvec(ax * np.radians(-SPLIT * h * w)).as_matrix()
        M = np.eye(4); M[:3, :3] = R; M[:3, 3] = cc - R @ cc
        G = M @ G
    return G


# ---------------------------------------------------------------- bottle (root-local keys, from the pour gun pose)
def _axis(az, el):
    az, el = np.radians(az), np.radians(el)
    return np.array([np.cos(el) * np.cos(az), np.sin(el), np.cos(el) * np.sin(az)])


def _bottle_frame(nozzle, axis, roll):
    y = np.asarray(axis, float); y /= np.linalg.norm(y)
    x = np.cross(y, [0.0, 0.0, 1.0]); x /= np.linalg.norm(x); z = np.cross(x, y)
    R = np.stack([x, y, z], 1) @ Rot.from_euler("Y", roll, degrees=True).as_matrix()
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = np.asarray(nozzle) - R[:, 1] * wd.BOTTLE_NOZZLE[1] * A.GUN_SCALE
    return M


def _to_local(G, B):
    Bs = B.copy(); Bs[:3, :3] = Bs[:3, :3] * A.GUN_SCALE
    return np.linalg.inv(G) @ Bs


_GP = A.gun_matrix(PL_POUR["grip"], PL_POUR["yaw"], PL_POUR["pitch"], PL_POUR["roll"])
_WP = wd.world_nodes(_GP, 0.0, 0.5, 1.0)
_OP = _WP["Opening"][:3, 3]; _N = normalized(_WP["Opening"])[:3, 0]
BOTTLE_KEYS_L = [   # (t, root-local bottle matrix)
    (RL["arrive"], _to_local(_GP, _bottle_frame(_OP + _N * 0.075, _axis(BOTTLE_AZ, BOTTLE_EL + 38.0), BOTTLE_ROLL))),
    (RL["pour0"], _to_local(_GP, _bottle_frame(_OP + _N * 0.035, _axis(BOTTLE_AZ, BOTTLE_EL), BOTTLE_ROLL))),
    (RL["pour1"], _to_local(_GP, _bottle_frame(_OP + _N * 0.028, _axis(BOTTLE_AZ, BOTTLE_EL - 18.0), BOTTLE_ROLL))),
    (RL["untip"], _to_local(_GP, _bottle_frame(_OP + _N * 0.075, _axis(BOTTLE_AZ, BOTTLE_EL + 38.0), BOTTLE_ROLL))),
]


def bottle_local_keyed(t):
    ks = BOTTLE_KEYS_L
    if t <= ks[0][0]: return ks[0][1]
    for (t0, A0), (t1, A1) in zip(ks, ks[1:]):
        if t <= t1:
            u = ease((t - t0) / (t1 - t0), "io")
            s0 = np.linalg.norm(A0[:3, 0]); M = blend_frames(normalized(A0), normalized(A1), u); M[:3, :3] *= s0
            if RL["pour0"] < t < RL["pour1"]:                        # little shake while pouring (units)
                M = M.copy(); M[:3, 3] += np.array([0.02 * np.sin(t * 38), 0.013 * np.sin(t * 29 + 1), 0.0])
            return M
    return ks[-1][1]


_GRAB_M = wd.BOTTLE_GRAB_LOCAL.copy(); _GRAB_M[:3, 3] *= A.GUN_SCALE          # grab socket in metres (bottle frame)


def bottle_from_hand(WL, G):
    """Bottle root-local matrix when the bottle simply rides in the left fist (Weapon_L world frame WL)."""
    B = normalized(WL) @ np.linalg.inv(_GRAB_M)
    return _to_local(G, B)


def bottle_hand_target(G, bl):
    Wb = G @ bl
    return normalized(Wb @ wd.BOTTLE_GRAB_LOCAL)


# ---------------------------------------------------------------- left-hand schedule
def claw(h, lift=0.0):
    return lambda Wn: A.cap_push(CAP_PHI2 + h, lift)(Wn)


LEFT_KEYS = {}                  # t -> left-arm locals of a solved contact pose (endpoints of the joint blends)
L_BONES = ("Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L")


def _left_down_locals():
    return {b: A.LEFT_IDLE[b] for b in L_BONES}                 # hanging along the body (fp_idle_left.py)


def _contact(t, cache):
    """Left-hand spec at t for the contact phases: (target fn(Wn, G) -> 4x4, finger curls, bottle local or None)."""
    h, lift = A.claw_state(t)
    if RL["reach"] <= t < RL["grab"]:
        u = ease((t - RL["reach"]) / (RL["grab"] - RL["reach"]), "io")
        return (lambda Wn, G: blend_frames(normalized(claw(-S1, 0.45)(Wn)), normalized(claw(-S1, 0.0)(Wn)), u)), 0.9 + 0.3 * u, None
    if RL["grab"] <= t < RL["open0"]:
        return (lambda Wn, G: claw(h, lift)(Wn)), 1.25 - 3.0 * lift, None
    if RL["open0"] <= t <= RL["open1"]:
        u = (t - RL["open0"]) / (RL["open1"] - RL["open0"])
        k = ease(max(0.0, (u - 0.55) / 0.45), "io")
        return (lambda Wn, G: blend_frames(normalized(claw(h)(Wn)), normalized(claw(h, 0.6)(Wn)), k)), 1.2 - 0.5 * u, None
    if RL["arrive"] <= t <= RL["untip"]:
        return (lambda Wn, G: bottle_hand_target(G, bottle_local_keyed(t))), A.BOTTLE_CURLS, "keyed"
    if RL["back"] <= t < RL["close1"]:
        u = ease((t - RL["back"]) / (RL["close1"] - RL["back"]), "io")
        return (lambda Wn, G: blend_frames(normalized(claw(S1, 0.3)(Wn)), normalized(claw(S1, 0.0)(Wn)), u)), 1.0 + 0.15 * u, None
    if RL["close1"] <= t <= RL["screw1"]:
        return (lambda Wn, G: claw(h, lift)(Wn)), 1.2 - 3.0 * lift, None
    return None


# joint-space blends: (t0, t1, endpoint A, endpoint B, bottle rides in the hand?) — "down" = the hanging arm off screen
JB = [(0.0, RL["reach"], "down", RL["reach"], False),
      (RL["open1"], RL["bottle_in"], RL["open1"], "down", False),
      (RL["bottle_in"], RL["arrive"], "down", RL["arrive"], True),
      (RL["untip"], RL["bottle_out"], RL["untip"], "down", True),
      (RL["bottle_out"], RL["back"], "down", RL["back"], False),
      (RL["screw1"], RL["leave"] + 0.2, RL["screw1"], "down", False)]


DIP = np.array([-0.04, -0.20, 0.0])          # camera space: how far the shoulder path sags between "down" and a contact


def _curls_of(spec_lf):
    return spec_lf if isinstance(spec_lf, dict) else {n: spec_lf for n in A.FINGERS_L}


def _mix_curls(a, b, u):
    a, b = _curls_of(a), _curls_of(b)
    return {n: a.get(n, 1.0) * (1 - u) + b.get(n, 1.0) * u for n in A.FINGERS_L}


class Baker:
    def __init__(self):
        self.xR = None; self.xL = None; self.keys = {}

    def right(self, G):
        pose, self.xR, (eR, rR), sR = N.solve_right(dict(A.REF), G, x0=self.xR)
        return pose, eR, rR

    def contact_pose(self, t):
        """Solve the full frame at a contact time (used for the joint-blend endpoints)."""
        if t in self.keys: return self.keys[t]
        G = gun_at(t)
        pose, eR, rR = self.right(G)
        Ga = weapon_root_world(arms.world(pose), A.M_FP)
        Wn = wd.world_nodes(Ga, 0.0, A.cap_turn_at(t), float(A.HINGE_T(t)))
        fn, lf, bmode = _contact(t, None)
        p2, x, (e, r), s = N.solve_left(pose, normalized(fn(Wn, Ga)))
        self.keys[t] = ({b: p2[b] for b in L_BONES}, lf)
        return self.keys[t]

    def frame(self, t):
        G = gun_at(t)
        pose, eR, rR = self.right(G)
        Ga = weapon_root_world(arms.world(pose), A.M_FP)
        ct = A.cap_turn_at(t); hg = float(A.HINGE_T(t))
        Wn = wd.world_nodes(Ga, 0.0, ct, hg)
        bottle = None; eL = rL = 0.0; lf = A.LEFT_IDLE_CURL
        seg = next((j for j in JB if j[0] <= t < j[1]), None)
        if seg is not None:
            t0, t1, a, b, rides = seg
            x = (t - t0) / (t1 - t0)
            u = ease(x, "io")
            # from / to the hanging arm: the long FP sleeve must never sweep through the view, so the arm turns while
            # its shoulder is still beside the eye and only then slides to the contact place (reverse order going down)
            if a == "down":
                ur = ease(min(1.0, x / 0.55), "io"); ut = ease(min(1.0, max(0.0, (x - 0.35) / 0.65)), "io")
            elif b == "down":
                ut = ease(min(1.0, x / 0.65), "io"); ur = ease(min(1.0, max(0.0, (x - 0.45) / 0.55)), "io")
            else:
                ur = ut = u
            La, fa = (_left_down_locals(), A.LEFT_IDLE_CURL) if a == "down" else self.contact_pose(a)
            Lb, fb = (_left_down_locals(), A.LEFT_IDLE_CURL) if b == "down" else self.contact_pose(b)
            if rides:
                fa = A.BOTTLE_CURLS if a == "down" else fa
                fb = A.BOTTLE_CURLS if b == "down" else fb
            dip = np.zeros(3)
            if "down" in (a, b):                    # the shoulder path sags below the view (no bottle / hand near the lens)
                Wc = arms.world(pose)[arms.names[arms.parent[arms.idx["Shoulder_L"]]]]
                dip = np.linalg.inv(Wc)[:3, :3] @ (DIP * 4.0 * ut * (1.0 - ut))
            for bn in L_BONES:
                Ta, qa, Sa = La[bn]; Tb, qb, Sb = Lb[bn]
                T = np.asarray(Ta) * (1 - ut) + np.asarray(Tb) * ut + (dip if bn == "Shoulder_L" else 0.0)
                pose[bn] = (T, slerp(np.asarray(qa, float), np.asarray(qb, float), ur), Sa)
            lf = _mix_curls(fa, fb, u)
            self.xL = None
            if rides and A.bottle_visible(t):
                bottle = bottle_from_hand(arms.world(pose)["Weapon_L"], Ga)
        else:
            spec = _contact(t, None)
            if spec is None:
                for bn, v in _left_down_locals().items(): pose[bn] = v
                self.xL = None
            else:
                fn, lf, bmode = spec
                if bmode == "keyed": bottle = bottle_local_keyed(t)
                Wn = wd.world_nodes(Ga, 0.0, ct, hg, bottle)
                pose, self.xL, (eL, rL), s = N.solve_left(pose, normalized(fn(Wn, Ga)), x0=self.xL)
        lfs = _curls_of(lf)
        for n in A.FINGERS_L: pose[n] = (A.REST[n][0], A.finger_q(n, lfs.get(n, 1.0)), A.REST[n][2])
        for n in A.FINGERS_R:
            s = 0.9 if n == "Index_R_1" else 1.0
            pose[n] = (A.REST[n][0], A.finger_q(n, s), A.REST[n][2])
        pose["FP_Viewmodel"] = A.V0; pose["Hips"] = A.HEX["Hips"]
        ws = dict(trig=0.0, cap_turn=ct, hinge=hg, bottle=bottle, level=float(A.LEVEL_T(t)))
        return pose, ws, (eR, rR, eL, rL)


def bake(fps=60, verbose=True):
    dur = RL["end"]
    n = int(round(dur * fps)) + 1
    bk = Baker()
    frames, wstate, errs = [], [], []
    for i in range(n):
        t = min(i / fps, dur)
        pose, ws, err = bk.frame(t)
        frames.append({b: pose[b] for b in sorted(set(c[0] for c in A.CHANNELS))})
        wstate.append(dict(trig=ws["trig"], cap_turn=ws["cap_turn"], hinge=ws["hinge"],
                           bottle=None if ws["bottle"] is None else np.array(ws["bottle"]), level=ws["level"]))
        errs.append(err)
    errs = np.array(errs)
    if verbose:
        print(f"FP_Reload_WaterFamas (v2) frames={n} maxL={errs[:, 2].max()*1000:.2f}mm/{errs[:, 3].max():.2f}deg "
              f"maxR={errs[:, 0].max()*1000:.2f}mm/{errs[:, 1].max():.2f}deg", flush=True)
    return dict(name="FP_Reload_WaterFamas", fps=fps, duration=dur, loop=False, frames=frames, weapon=wstate, errors=errs)


if __name__ == "__main__":
    OUT = os.environ.get("OUT", "fp_clips.pkl")
    out = pickle.load(open(OUT, "rb"))
    out["FP_Reload_WaterFamas"] = bake()
    pickle.dump(out, open(OUT, "wb"))
