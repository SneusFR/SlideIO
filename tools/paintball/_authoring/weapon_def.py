"""Paintball Rifle — node hierarchy + geometry (read from the Blender model dump), shared by the exporter,
the pose authors and the previews. Weapon-local units, forward -X, up +Y, +Z = gun's left side."""
import json, os
import numpy as np
from rig import trs, qaxis
from geom import MeshBuilder

ROOT_SCALE = 0.19
DUMP = os.environ.get("PB_DUMP", "pb_dump.json")

# ---- key points: read from the Blender dump (the model is scaled x1.4 about the grip point inside Blender)
_META = json.load(open(DUMP))["meta"]
_OBJ = json.load(open(DUMP))["objects"]
SCALE = _META["scale"]
PXU = _META["px_to_unit"]["pxu"]
GRIP = np.array(_META["grip"])                                 # = Popcorn Shotgun GripSocket (same right-hand mount)
OX, OY = 619.6, 275.9                                          # reference image px of the weapon origin (x1.4 model)
def X(px): return (px - OX) / PXU
def Y(py): return -(py - OY) / PXU

YA = _META["ya"]
BARREL_R = _META["barrel_r"]
TRIGGER_PIVOT = np.array(_OBJ["Trigger"]["location"])
MUZZLE = np.array(_OBJ["Muzzle"]["location"])
HOPPER_C = np.array(_OBJ["Hopper"]["location"])
CH_REST = np.array(_OBJ["ChargingHandle"]["location"])
CH_TRAVEL = _META["ch_travel"]
FOREGRIP_X = _META["foregrip"]["x"]
FOREGRIP_Y0, FOREGRIP_Y1 = _META["foregrip"]["y0"], _META["foregrip"]["y1"]
FOREGRIP_HALF = tuple(_META["foregrip"]["half"])               # half depth (x) / half width (z)
BALL_R = _META["ball_r"]
TUBE_R = _META["tube_r"]                                       # glass outer (octagon apothem)
# hopper physics (Hopper-local units): horizontal cylinder + shallow V floor toward the feed hole
INNER_R = 0.243 * SCALE
INNER_X = (-1.11 * SCALE, 1.09 * SCALE)
FEED_X_LOCAL = -0.274 * SCALE
BODY_OFFSET = np.array(_OBJ["Body"]["location"])               # Body mesh local -> root (baked at export)
FEED = np.array([-0.383, 0.872, 0.0])                          # top of the pedestal (hopper foot seat)

# Left-palm (Weapon_L) frame relative to the ROOT on the foregrip, set by the grip fit / author scripts.
OFFHAND_LOCAL = None
# Left-palm frame relative to the Hopper node (reload grab), set by the author scripts.
HOPPER_GRAB_LOCAL = None
# Left-palm frame relative to the ChargingHandle node (charging), set by the author scripts.
CHARGE_LOCAL = None


def _mb(name, rec, origin=None):
    mb = MeshBuilder(name)
    P = np.asarray(rec["pos"], float); N = np.asarray(rec["nrm"], float); C = np.asarray(rec["col"], float)
    mb.pos = list(P); mb.nrm = list(N); mb.col = list(C)
    return mb


_parts = None
_dump = None


def dump():
    global _dump
    if _dump is None:
        _dump = json.load(open(DUMP))["objects"]
    return _dump


def parts():
    """name -> MeshBuilder in the node's LOCAL frame (Blender object local = glTF node local)."""
    global _parts
    if _parts is None:
        d = dump()
        _parts = {n: _mb(n, d[n]) for n in ("Body", "Trigger", "ChargingHandle", "HopperFrame", "HopperGlass", "Ball_Template")}
        _parts["Body"].pos = [p + BODY_OFFSET for p in _parts["Body"].pos]
    return _parts


def node_locals(trig_deg=0.0, charge=0.0, hopper=None):
    """Local matrices of the animated nodes (weapon-local, pre root scale). hopper: 4x4 local matrix of the
    Hopper node relative to the root (None = seated)."""
    return {
        "Trigger": trs(TRIGGER_PIVOT, qaxis([0, 0, 1], np.radians(trig_deg))),
        "ChargingHandle": trs(CH_REST + np.array([charge * CH_TRAVEL, 0, 0])),
        "Hopper": trs(HOPPER_C) if hopper is None else hopper,
    }


def world_nodes(G, trig_deg=0.0, charge=0.0, hopper=None):
    """G = weapon ROOT world matrix (includes the 0.19 root scale)."""
    L = node_locals(trig_deg, charge, hopper)
    Wn = {"Root": G, "Body": G}
    Wn["Trigger"] = G @ L["Trigger"]
    Wn["ChargingHandle"] = G @ L["ChargingHandle"]
    Wn["Hopper"] = G @ L["Hopper"]
    Wn["HopperFrame"] = Wn["Hopper"]; Wn["HopperGlass"] = Wn["Hopper"]
    Wn["Muzzle"] = G @ trs(MUZZLE)
    Wn["Grip"] = G @ trs(GRIP)
    Wn["Feed"] = G @ trs(FEED)
    if OFFHAND_LOCAL is not None:
        Wn["Offhand"] = G @ OFFHAND_LOCAL
    if HOPPER_GRAB_LOCAL is not None:
        Wn["HopperGrab"] = Wn["Hopper"] @ HOPPER_GRAB_LOCAL
    if CHARGE_LOCAL is not None:
        Wn["Charge"] = Wn["ChargingHandle"] @ CHARGE_LOCAL
    return Wn


def ball_layout():
    """Preview balls (Hopper-local positions + colour index) from the Blender dump."""
    d = dump()
    out = []
    for k in range(64):
        rec = d.get(f"Ball_{k:02d}")
        if rec is None: break
        out.append(rec["location"])
    return np.array(out)


def draw_weapon(r, Wn, balls=None, glass_alpha=0.28, hide=()):
    """balls: list of (4x4 in HOPPER space, rgb)."""
    for name, mb in parts().items():
        if name == "Ball_Template" or name in hide: continue
        M = Wn[name]
        p, n, c = mb.arrays()
        v = (M[:3, :3] @ p.T).T + M[:3, 3]
        f = np.arange(len(v)).reshape(-1, 3)
        r.draw(v, f, c, alpha=glass_alpha if name == "HopperGlass" else 1.0)
    if balls is not None and "Hopper" not in hide:
        p, n, c = parts()["Ball_Template"].arrays()
        f0 = np.arange(len(p)).reshape(-1, 3)
        for Mi, rgb in balls:
            M = Wn["Hopper"] @ Mi
            v = (M[:3, :3] @ p.T).T + M[:3, 3]
            r.draw(v, f0, np.tile(np.asarray(rgb, np.float32), (len(v), 1)))


BALL_RGB = [np.array(c) for c in ((0.815, 0.117, 0.093), (0.905, 0.63, 0.052), (0.027, 0.47, 0.49))]


def preview_balls():
    L = ball_layout()
    d = dump()
    out = []
    for k, p in enumerate(L):
        M = trs(p, s=(BALL_R,) * 3)
        col = d[f"Ball_{k:02d}"].get("color", [1, 1, 1])[:3]
        out.append((M, col))
    return out
