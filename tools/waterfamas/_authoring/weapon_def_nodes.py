"""Water FAMAS — node hierarchy + geometry (read from the Blender model dump), shared by the exporter, the pose
authors and the previews. Weapon-local units, forward -X, up +Y, +Z = gun's left side.

Nodes: Body, Trigger (pivot +Z), Tank > (TankFrame, TankGlass, Water, CapHinge > Cap), Bottle (reload prop), Muzzle,
GripSocket. The pistol grip / trigger / guard are the Paintball Rifle ones (same right-hand hold, same mounts).
"""
import json, os
import numpy as np
from rig import trs, qaxis
from geom import MeshBuilder

ROOT_SCALE = 0.19
DUMP = os.environ.get("FM_DUMP", "fm_dump.json")
_D = json.load(open(DUMP))
_META, _OBJ = _D["meta"], _D["objects"]

GRIP = np.array(_META["grip"])
TRIGGER_PIVOT = np.array(_OBJ["Trigger"]["location"])
MUZZLE = np.array(_OBJ["Muzzle"]["location"])
YA = _META["ya"]
TANK_C = np.array(_OBJ["Tank"]["location"])
TANK_R = _META["tank_r"]
TANK_X = tuple(_META["tank_x"])
WATER_R = _META["water_r"]
WATER_X = tuple(_META["water_x"])
HINGE = np.array(_OBJ["CapHinge"]["location"])                 # tank-local
CAP_REST = np.array(_OBJ["Cap"]["location"])                   # hinge-local
CAP_X = _META["cap_x"]                                         # tank-local cap centre (on the axis)
CAP_R = _META["cap_r"]
THREAD = 0.06                                                  # cap travel along the axis for 1 turn (units)
HINGE_OPEN_DEG = 118.0                                         # retainer swung open (about +Y, toward +Z / the gun's left)
BOTTLE_PARK = np.array(_OBJ["Bottle"]["location"])

# Left-palm (Weapon_L) frames, set by the author scripts: on the cap (Cap-local), on the bottle (Bottle-local)
CAP_GRAB_LOCAL = None
BOTTLE_GRAB_LOCAL = None
BOTTLE_NOZZLE = np.array([0.0, 1.00, 0.0])                     # bottle-local nozzle tip


def _mb(name, rec):
    mb = MeshBuilder(name)
    mb.pos = list(np.asarray(rec["pos"], float)); mb.nrm = list(np.asarray(rec["nrm"], float))
    mb.col = list(np.asarray(rec["col"], float))
    return mb


_parts = None


def parts():
    """name -> MeshBuilder in the node's LOCAL frame (Blender object local = glTF node local)."""
    global _parts
    if _parts is None:
        _parts = {n: _mb(n, _OBJ[n]) for n in ("Body", "Trigger", "TankFrame", "TankGlass", "Water", "CapHinge", "Cap", "Bottle")}
    return _parts


def node_locals(trig_deg=0.0, cap_turn=0.0, hinge=0.0, bottle=None):
    """Local matrices of the animated nodes (weapon-local units).
    cap_turn: unscrew turns (0 = closed; +0.5 = free: rotated +180° about +X and pulled out by THREAD/2);
    hinge: 0..1 retainer opening; bottle: 4x4 Bottle local matrix (root space) or None = hidden."""
    cap = trs(CAP_REST + np.array([THREAD * cap_turn, 0.0, 0.0]), qaxis([1, 0, 0], 2 * np.pi * cap_turn))   # unscrew = CCW seen from outside
    hin = trs(HINGE, qaxis([0, 1, 0], -np.radians(HINGE_OPEN_DEG) * hinge))
    return {
        "Trigger": trs(TRIGGER_PIVOT, qaxis([0, 0, 1], np.radians(trig_deg))),
        "Tank": trs(TANK_C),
        "CapHinge": hin,
        "Cap": cap,
        "Bottle": bottle if bottle is not None else trs(BOTTLE_PARK, s=(0.0, 0.0, 0.0)),
    }


def world_nodes(G, trig_deg=0.0, cap_turn=0.0, hinge=0.0, bottle=None):
    """G = weapon ROOT world matrix (includes the 0.19 root scale)."""
    L = node_locals(trig_deg, cap_turn, hinge, bottle)
    Wn = {"Root": G, "Body": G}
    Wn["Trigger"] = G @ L["Trigger"]
    Wn["Tank"] = G @ L["Tank"]
    Wn["TankFrame"] = Wn["TankGlass"] = Wn["Water"] = Wn["Tank"]
    Wn["CapHinge"] = Wn["Tank"] @ L["CapHinge"]
    Wn["Cap"] = Wn["CapHinge"] @ L["Cap"]
    Wn["Bottle"] = G @ L["Bottle"]
    Wn["Muzzle"] = G @ trs(MUZZLE)
    Wn["Grip"] = G @ trs(GRIP)
    Wn["Opening"] = Wn["Tank"] @ trs([TANK_X[1] + 0.06, 0.0, 0.0])      # filler hole (rim), tank axis = +X
    if CAP_GRAB_LOCAL is not None:
        Wn["CapGrab"] = Wn["Cap"] @ CAP_GRAB_LOCAL
    if BOTTLE_GRAB_LOCAL is not None:
        Wn["BottleGrab"] = Wn["Bottle"] @ BOTTLE_GRAB_LOCAL
    Wn["Nozzle"] = Wn["Bottle"] @ trs(BOTTLE_NOZZLE)
    return Wn


def draw_weapon(r, Wn, glass_alpha=0.3, water_level=1.0, hide=()):
    """Software preview. water_level: 0..1 (the Water mesh is clipped horizontally in TANK space — the runtime uses
    a world-space free surface instead)."""
    for name, mb in parts().items():
        if name in hide: continue
        M = Wn[name]
        if name == "Bottle" and abs(np.linalg.det(M[:3, :3])) < 1e-9: continue
        p, n, c = mb.arrays()
        if name == "Water":
            if water_level <= 0.01: continue
            ytop = -WATER_R + 2 * WATER_R * water_level
            p = p.copy(); p[:, 1] = np.minimum(p[:, 1], ytop)
        v = (M[:3, :3] @ p.T).T + M[:3, 3]
        f = np.arange(len(v)).reshape(-1, 3)
        a = glass_alpha if name == "TankGlass" else (0.75 if name == "Water" else 1.0)
        r.draw(v, f, c, alpha=a)
