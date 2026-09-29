"""Frisbee Launcher — node hierarchy + geometry (read from the Blender model dump), shared by the exporter, the pose
authors and the previews. Weapon-local units, forward -X, up +Y, +Z = gun's left side.

Weapon state used everywhere (dict, all keys optional):
  trig      trigger pull (deg)
  sled      0 = sled at the front stop (fired) .. 1 = cocked at the latch
  flex      limb flex 0 (relaxed) .. 1 (cocked); defaults to `sled` (the fire clip overshoots it for the twang)
  deck      the loaded disc: None = no disc on the deck, "loaded" = at rest on the deck, or a 4x4 ROOT-space matrix
  hand      the disc in the left hand (4x4 ROOT-space matrix) or None
  cage      None = cage seated, or a 4x4 ROOT-space matrix (magazine swap), "hidden" = off screen
  cage_n    discs visible in the cage (0..4, from the top slot down) — `cage_top` hides the top one only (disc taken)
"""
import json, os
import numpy as np
from rig import trs, qaxis, mat3_to_quat
from geom import MeshBuilder

ROOT_SCALE = 0.19
DUMP = os.environ.get("FL_DUMP", "fl_dump.json")
_J = json.load(open(DUMP))
_META, _OBJ = _J["meta"], _J["objects"]

GRIP = np.array(_META["grip"])
TRIGGER_PIVOT = np.array(_META["trigger_pivot"])
DECK_Y, CORD_Y = _META["deck_y"], _META["cord_y"]
DISC_R, DISC_H = _META["disc_r"], _META["disc_h"]
SLED_COCKED_X, SLED_FRONT_X = _META["sled_cocked_x"], _META["sled_front_x"]
DISC_LOADED = np.array(_META["disc_loaded"])
LIMB_PIVOT = np.array(_META["limb_pivot"])
LIMB_TIP_LOCAL = np.array(_META["limb_tip_local"])
FLEX_DEG = _META["flex_deg"]
NOCK_Z = _META["nock_z"]
FOREGRIP_X = _META["foregrip"]["x"]
FOREGRIP_Y0, FOREGRIP_Y1 = _META["foregrip"]["y0"], _META["foregrip"]["y1"]
FOREGRIP_HALF = tuple(_META["foregrip"]["half"])
CAGE_C = np.array(_META["cage_c"])
CAGE_POST_R = _META["cage_post_r"]
SLOT_Y = list(_META["slot_y"])
CAGE_BOTTOM = _META["cage_bottom"]
LAUNCH = np.array(_META["launch"])
MUZZLE = LAUNCH
SLED_HANDLE = np.array(_OBJ["SledHandle"]["location"])        # sled-local
CAGE_SLOTS = len(SLOT_Y)
CAPACITY = 1 + CAGE_SLOTS                                    # 1 on the deck + 4 in the cage

# Left-palm (Weapon_L) frames, set by the author scripts
OFFHAND_LOCAL = None         # root space: fist on the foregrip
SLED_GRAB_LOCAL = None       # sled space: fist over the T-handle
CAGE_GRAB_LOCAL = None       # cage space: hand under the cage (magazine swap)
DISC_GRAB_LOCAL = None       # disc space: pinch on the rim (carrying a disc)


def _mb(name):
    rec = _OBJ[name]
    mb = MeshBuilder(name)
    mb.pos = list(np.asarray(rec["pos"], float)); mb.nrm = list(np.asarray(rec["nrm"], float)); mb.col = list(np.asarray(rec["col"], float))
    return mb


_parts = None


def parts():
    """name -> MeshBuilder in the node's LOCAL frame (Blender object local = glTF node local)."""
    global _parts
    if _parts is None:
        _parts = {n: _mb(n) for n in ("Body", "Trigger", "LimbL", "LimbR", "Sled", "CordL", "CordR", "DiscDeck", "Cage")}
    return _parts


def limb_matrix(side, flex):
    """side +1 left / -1 right. Limb node local matrix (root space)."""
    return trs(LIMB_PIVOT * np.array([1, 1, side]), qaxis([0, 1, 0], np.radians(FLEX_DEG * flex * side)))


def limb_tip(side, flex):
    return (limb_matrix(side, flex) @ np.r_[LIMB_TIP_LOCAL * np.array([1, 1, side]), 1.0])[:3]


def sled_x(s):
    return SLED_FRONT_X + (SLED_COCKED_X - SLED_FRONT_X) * float(s)


def cord_matrix(side, sled, flex):
    tip = limb_tip(side, flex)
    nock = np.array([sled_x(sled), CORD_Y, side * NOCK_Z])
    d = nock - tip; L = float(np.linalg.norm(d)); u = d / L
    # shortest rotation +X -> u
    x = np.array([1.0, 0.0, 0.0]); ax = np.cross(x, u); s = np.linalg.norm(ax); c = float(np.dot(x, u))
    q = np.array([0, 0, 0, 1.0]) if s < 1e-9 else qaxis(ax / s, np.arctan2(s, c))
    return trs(tip, q, (L, 1.0, 1.0))


DISC_LOADED_M = trs(DISC_LOADED)
HIDDEN = trs(DISC_LOADED, s=(0.0, 0.0, 0.0))


def cage_disc_local(k):
    return trs([0.0, SLOT_Y[k], 0.0])


def node_locals(st=None):
    st = st or {}
    sled = float(st.get("sled", 1.0)); flex = float(st.get("flex", sled))
    L = {"Trigger": trs(TRIGGER_PIVOT, qaxis([0, 0, 1], np.radians(st.get("trig", 0.0)))),
         "Sled": trs([sled_x(sled), CORD_Y, 0.0]),
         "LimbL": limb_matrix(1, flex), "LimbR": limb_matrix(-1, flex),
         "CordL": cord_matrix(1, sled, flex), "CordR": cord_matrix(-1, sled, flex)}
    deck = st.get("deck", "loaded")
    L["DiscDeck"] = DISC_LOADED_M if isinstance(deck, str) and deck == "loaded" else (HIDDEN if deck is None else np.asarray(deck))
    hand = st.get("hand")
    L["DiscHand"] = HIDDEN if hand is None else np.asarray(hand)
    cage = st.get("cage")
    L["Cage"] = trs(CAGE_C) if cage is None else (trs(CAGE_C, s=(0, 0, 0)) if isinstance(cage, str) else np.asarray(cage))
    return L


def world_nodes(G, st=None):
    """G = weapon ROOT world matrix (includes the 0.19 root scale)."""
    L = node_locals(st)
    Wn = {"Root": G, "Body": G}
    for k, M in L.items():
        Wn[k] = G @ M
    Wn["Muzzle"] = Wn["Launch"] = G @ trs(LAUNCH)
    Wn["Grip"] = G @ trs(GRIP)
    if OFFHAND_LOCAL is not None: Wn["Offhand"] = G @ OFFHAND_LOCAL
    if SLED_GRAB_LOCAL is not None: Wn["SledGrab"] = Wn["Sled"] @ SLED_GRAB_LOCAL
    if CAGE_GRAB_LOCAL is not None: Wn["CageGrab"] = Wn["Cage"] @ CAGE_GRAB_LOCAL
    if DISC_GRAB_LOCAL is not None: Wn["DiscGrab"] = Wn["DiscHand"] @ DISC_GRAB_LOCAL
    return Wn


def draw_weapon(r, Wn, st=None, hide=()):
    st = st or {}
    P = parts()
    for name in ("Body", "Trigger", "LimbL", "LimbR", "Sled", "CordL", "CordR", "Cage"):
        if name in hide: continue
        M = Wn[name]
        if abs(np.linalg.det(M[:3, :3])) < 1e-12: continue
        p, n, c = P[name].arrays()
        v = (M[:3, :3] @ p.T).T + M[:3, 3]
        r.draw(v, np.arange(len(v)).reshape(-1, 3), c)
    p, n, c = P["DiscDeck"].arrays()
    f0 = np.arange(len(p)).reshape(-1, 3)
    discs = [Wn["DiscDeck"], Wn["DiscHand"]]
    n_cage = int(st.get("cage_n", CAGE_SLOTS))
    for k in range(n_cage):
        if k == 0 and st.get("cage_top") is False: continue
        discs.append(Wn["Cage"] @ cage_disc_local(k))
    if "Cage" in hide: discs = discs[:2]
    for M in discs:
        if abs(np.linalg.det(M[:3, :3])) < 1e-12: continue
        v = (M[:3, :3] @ p.T).T + M[:3, 3]
        r.draw(v, f0, c)
