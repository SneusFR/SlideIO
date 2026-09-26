"""Weapon node hierarchy (shared by the GLB exporter, the pose author and the previews)."""
import numpy as np
import weapon_parts as w
from rig import trs, qaxis, qmul, quat_to_mat3
from geom import MeshBuilder

ROOT_SCALE = 0.19
PUMP_TRAVEL = 0.34
TANK_C, TANK_HALF = w.tank_inner_box()
PUMP_ORIGIN = np.array([w.PUMP_CENTER_X, w.PUMP_CY, 0.0])
TRIGGER_PIVOT = np.array([w.X(962), w.Y(668), 0.0])
LID_HINGE = np.array([w.X(600), w.Y(146), 0.0])             # weapon-local, hinge axis +Z (front edge)
LID_LEN = w.X(1066) - w.X(600)                            # hinge -> rear free edge
MUZZLE = np.array([w.X(117), 0.0, 0.0])
GRIP = np.array([w.X(1042), w.Y(760), 0.0])
FEED = np.array([TANK_C[0], w.Y(382), 0.0])
LID_OPEN_DEG = 105.0

# Left-palm (Weapon_L) frame relative to the Pump node, filled by author_fp (baked into OffhandSocket).
OFFHAND_LOCAL = None


def local_mesh(mb, origin):
    """Re-express a MeshBuilder's geometry relative to a node origin."""
    out = MeshBuilder(mb.name)
    out.pos = [p - origin for p in mb.pos]
    out.nrm = list(mb.nrm)
    out.col = list(mb.col)
    return out


_parts = None


def parts():
    global _parts
    if _parts is None:
        p = w.build()
        _parts = {
            "Body": p["Body"],
            "Pump": local_mesh(p["Pump"], PUMP_ORIGIN),
            "Trigger": local_mesh(p["Trigger"], TRIGGER_PIVOT),
            "TankFrame": local_mesh(p["TankFrame"], TANK_C),
            "TankGlass": local_mesh(p["TankGlass"], TANK_C),
            "TankLid": local_mesh(p["TankLid"], LID_HINGE),
        }
    return _parts


def node_locals(pump=0.0, lid_deg=0.0, trigger_deg=0.0):
    """Local matrices of the animated weapon nodes (weapon-local, pre root scale)."""
    return {
        "Pump": trs(PUMP_ORIGIN + np.array([pump * PUMP_TRAVEL, 0, 0])),
        "Trigger": trs(TRIGGER_PIVOT, qaxis([0, 0, 1], np.radians(trigger_deg))),
        "Tank": trs(TANK_C),
        "TankLid": trs(LID_HINGE - TANK_C, qaxis([0, 0, 1], np.radians(lid_deg))),
    }


def world_nodes(G, pump=0.0, lid_deg=0.0, trigger_deg=0.0):
    """G = weapon ROOT world matrix (includes the 0.19 root scale)."""
    L = node_locals(pump, lid_deg, trigger_deg)
    Wn = {"Root": G, "Body": G}
    Wn["Pump"] = G @ L["Pump"]
    Wn["Trigger"] = G @ L["Trigger"]
    Wn["Tank"] = G @ L["Tank"]
    Wn["TankFrame"] = Wn["Tank"]
    Wn["TankGlass"] = Wn["Tank"]
    Wn["TankLid"] = Wn["Tank"] @ L["TankLid"]
    Wn["Muzzle"] = G @ trs(MUZZLE)
    Wn["Grip"] = G @ trs(GRIP)
    Wn["Feed"] = G @ trs(FEED)
    Wn["LidEdge"] = Wn["TankLid"] @ trs(np.array([LID_LEN, 0.08, 0.0]))
    Wn["LidTop"] = Wn["TankLid"] @ trs(np.array([LID_LEN * 0.62, w.Y(92) - w.Y(146), 0.0]))
    if OFFHAND_LOCAL is not None:
        Wn["Offhand"] = Wn["Pump"] @ OFFHAND_LOCAL
    return Wn


def draw_weapon(r, Wn, popcorn=None, kernels=None, glass_alpha=0.28):
    """popcorn / kernels: list of 4x4 matrices in TANK space."""
    for name, mb in parts().items():
        M = Wn[name]
        p, n, c = mb.arrays()
        v = (M[:3, :3] @ p.T).T + M[:3, 3]
        f = np.arange(len(v)).reshape(-1, 3)
        r.draw(v, f, c, alpha=glass_alpha if name == "TankGlass" else 1.0)
    for lst, tmpl in ((popcorn, _popcorn_tmpl), (kernels, _kernel_tmpl)):
        if not lst: continue
        p, n, c = tmpl().arrays()
        f0 = np.arange(len(p)).reshape(-1, 3)
        for Mi in lst:
            M = Wn["Tank"] @ Mi
            v = (M[:3, :3] @ p.T).T + M[:3, 3]
            r.draw(v, f0, c)


_pt = None
_kt = None


def _popcorn_tmpl():
    global _pt
    if _pt is None: _pt = w.popcorn_piece(seed=11)
    return _pt


def _kernel_tmpl():
    global _kt
    if _kt is None: _kt = w.kernel_piece()
    return _kt
