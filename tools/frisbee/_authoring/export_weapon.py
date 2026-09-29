"""Write FrisbeeLauncher_Weapon.glb (scene + sockets + disc / cage data + weapon clips)."""
import json, pickle, os
import numpy as np
from glb import GLBWriter
import weapon_def as wd
from rig import qaxis, mat3_to_quat, trs

OPAQUE = 0


def dedup(pos, nrm, col):
    key = np.round(np.concatenate([pos, nrm * 10, col * 10], axis=1), 5)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    first = np.zeros(len(uniq), np.int64)
    first[inv[::-1]] = np.arange(len(inv))[::-1]
    return pos[first], nrm[first], col[first], inv.astype(np.uint32)


def add_mesh(w, name, mb, material):
    pos, nrm, col = mb.arrays()
    pos, nrm, col, idx = dedup(pos, nrm, col)
    a_pos = w.add_accessor(pos, "VEC3", 5126, target=34962, minmax=True)
    a_nrm = w.add_accessor(nrm, "VEC3", 5126, target=34962)
    c4 = np.concatenate([col, np.ones((len(col), 1), np.float32)], axis=1)
    a_col = w.add_accessor(np.round(np.clip(c4, 0, 1) * 65535), "VEC4", 5123, target=34962, normalized=True)
    ict = 5123 if len(pos) < 65535 else 5125
    a_idx = w.add_accessor(idx.reshape(-1, 1), "SCALAR", ict, target=34963)
    w.js.setdefault("meshes", []).append({"name": name, "primitives": [{
        "attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "COLOR_0": a_col}, "indices": a_idx, "material": material}]})
    return len(w.js["meshes"]) - 1, len(idx) // 3


def node(w, name, children=(), **kw):
    n = {"name": name}
    n.update({k: v for k, v in kw.items() if v is not None})
    if children: n["children"] = list(children)
    w.js["nodes"].append(n)
    return len(w.js["nodes"]) - 1


def f3(v): return [float(round(x, 6)) for x in v]
def f4(v): return [float(round(x, 7)) for x in v]


def trs_of(M):
    t = M[:3, 3]; s = np.linalg.norm(M[:3, :3], axis=0)
    R = M[:3, :3] / np.where(s > 1e-9, s, 1.0)
    if np.all(s < 1e-9): R = np.eye(3)
    return t, mat3_to_quat(R), s


ANIM_NODES = ("Trigger", "Sled", "LimbL", "LimbR", "CordL", "CordR", "DiscDeck", "DiscHand", "Cage")


def static_clip(st, dur):
    return (np.array([0.0, dur]), [st, st])


def clip_from(c):
    n = len(c["weapon"])
    ts = np.minimum(np.arange(n) / c["fps"], c["duration"])
    return ts, list(c["weapon"])


def weapon_tracks():
    fp = pickle.load(open("fp_clips.pkl", "rb"))
    tp = pickle.load(open("tp_clips.pkl", "rb")) if os.path.exists("tp_clips.pkl") else {}
    loaded, empty = {}, dict(sled=0.0, deck=None)
    clips = {"Idle": static_clip(loaded, 2.0), "IdleEmpty": static_clip(empty, 2.0)}
    clips["Fire"] = clip_from(fp["FP_Fire_FrisbeeLauncher"])
    clips["FireLast"] = clip_from(fp["FP_FireLast_FrisbeeLauncher"])
    clips["Reload"] = clip_from(fp["FP_Reload_FrisbeeLauncher"])
    clips["ReloadEmpty"] = clip_from(fp["FP_ReloadEmpty_FrisbeeLauncher"])
    if "TP_Reload_FrisbeeLauncher" in tp:
        clips["Reload_TP"] = clip_from(tp["TP_Reload_FrisbeeLauncher"])
        clips["ReloadEmpty_TP"] = clip_from(tp["TP_ReloadEmpty_FrisbeeLauncher"])
    clips["Inspect"] = static_clip(loaded, 3.6)
    clips["InspectEmpty"] = static_clip(empty, 3.6)
    clips["Equip"] = static_clip(loaded, 0.55)
    clips["EquipEmpty"] = static_clip(empty, 0.55)
    return clips


def build(path="FrisbeeLauncher_Weapon.glb"):
    import author_fp as A
    try:
        import author_tp as T
        sled_tp = T.SLED_GRAB_TP
    except Exception as e:
        print("TP sockets unavailable:", e); sled_tp = None
    w = GLBWriter()
    w.js["asset"]["generator"] = "Frisbee Launcher — modelled in Blender (fl_model.py), assembled by export_weapon.py"
    w.js["materials"] = [{"name": "FrisbeeLauncher_VertexColor",
                          "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.5}}]
    P = wd.parts()
    stats, m = {}, {}
    for name in ("Body", "Trigger", "LimbL", "LimbR", "Sled", "CordL", "CordR", "DiscDeck", "Cage"):
        m[name], stats[name] = add_mesh(w, name, P[name], OPAQUE)
    L0 = wd.node_locals({})

    def socket(name, F, extras):
        R = F[:3, :3] / np.linalg.norm(F[:3, :3], axis=0)
        return node(w, name, translation=f3(F[:3, 3]), rotation=f4(mat3_to_quat(R)), extras=extras)

    def tr(name, M, **kw):
        t, q, s = trs_of(M)
        return dict(translation=f3(t), rotation=f4(q), scale=f3(s) if np.any(np.abs(s - 1) > 1e-6) else None, **kw)

    n_body = node(w, "Body", mesh=m["Body"])
    n_trig = node(w, "Trigger", mesh=m["Trigger"], **tr("Trigger", L0["Trigger"]), extras={"pivot_axis": "+Z"})
    n_tipL = node(w, "LimbTipL", translation=f3(wd.LIMB_TIP_LOCAL), extras={"purpose": "socket", "note": "left cord anchor"})
    n_tipR = node(w, "LimbTipR", translation=f3(wd.LIMB_TIP_LOCAL * np.array([1, 1, -1])), extras={"purpose": "socket"})
    n_limbL = node(w, "LimbL", [n_tipL], mesh=m["LimbL"], **tr("LimbL", L0["LimbL"]),
                   extras={"pivot_axis": "+Y", "flex_degrees_cocked": wd.FLEX_DEG})
    n_limbR = node(w, "LimbR", [n_tipR], mesh=m["LimbR"], **tr("LimbR", L0["LimbR"]),
                   extras={"pivot_axis": "+Y", "flex_degrees_cocked": -wd.FLEX_DEG})
    n_cordL = node(w, "CordL", mesh=m["CordL"], **tr("CordL", L0["CordL"]),
                   extras={"elastic_cord": True, "note": "unit length along +X: translation = limb tip, scale.x = tip-to-nock length"})
    n_cordR = node(w, "CordR", mesh=m["CordR"], **tr("CordR", L0["CordR"]), extras={"elastic_cord": True})
    sled_kids = [node(w, "SledHandle", translation=f3(wd.SLED_HANDLE), extras={"purpose": "socket", "note": "T-handle centre (cocking)"}),
                 socket("SledGrabSocket", A.SLED_GRAB_LOCAL, {"purpose": "left_hand_ik_target", "matches": "Weapon_L",
                                                              "note": "FP: fist over the T-handle (re-cocking)"})]
    if sled_tp is not None:
        sled_kids.append(socket("SledGrabSocketTP", sled_tp, {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)"}))
    n_sled = node(w, "Sled", sled_kids, mesh=m["Sled"], **tr("Sled", L0["Sled"]),
                  extras={"travel_axis": "+X", "cocked_x": wd.SLED_COCKED_X, "fired_x": wd.SLED_FRONT_X,
                          "note": "carriage in the channel; the cords are knotted to it, its fin pushes the disc"})
    n_deck = node(w, "DiscDeck", mesh=m["DiscDeck"], **tr("DiscDeck", L0["DiscDeck"]),
                  extras={"disc": True, "radius": wd.DISC_R, "thickness": wd.DISC_H,
                          "note": "the loaded frisbee (scale 0 when the deck is empty); its mesh is the projectile template"})
    n_hand = node(w, "DiscHand", mesh=m["DiscDeck"], translation=f3(wd.DISC_LOADED), scale=[0.0, 0.0, 0.0],
                  extras={"disc": True, "reload_prop": True, "note": "the disc carried by the left hand during the re-cocking"})
    cage_kids = [node(w, f"CageDisc{k}", mesh=m["DiscDeck"], translation=f3([0.0, y, 0.0]),
                      extras={"disc": True, "slot": k, "note": "visible when the cage holds more than k discs (controller)"})
                 for k, y in enumerate(wd.SLOT_Y)]
    n_cage = node(w, "Cage", cage_kids, mesh=m["Cage"], translation=f3(wd.CAGE_C),
                  extras={"magazine": True, "capacity": wd.CAGE_SLOTS, "slotY": [float(y) for y in wd.SLOT_Y],
                          "note": "disc magazine, open on the LEFT side; slot 0 = top (the next disc)"})
    n_launch = node(w, "LaunchSocket", translation=f3(wd.LAUNCH), extras={"purpose": "socket", "forward": "-X",
                                                                          "note": "projectile visual start (the disc leaves the deck)"})
    n_grip = node(w, "GripSocket", translation=f3(wd.GRIP), extras={"purpose": "socket", "deform": False})
    n_fore = socket("ForegripSocket", A.OFFHAND_FIT, {"purpose": "left_hand_ik_target", "matches": "Weapon_L", "note": "FP foregrip fist"})
    root = node(w, "FrisbeeLauncher", [n_body, n_trig, n_limbL, n_limbR, n_cordL, n_cordR, n_sled, n_deck, n_hand, n_cage,
                                       n_launch, n_grip, n_fore], scale=[wd.ROOT_SCALE] * 3,
                extras={"forward": "-X", "units": "meters", "idle": "Idle", "idleEmpty": "IdleEmpty", "fire": "Fire",
                        "fireLast": "FireLast", "reload": "Reload", "reloadEmpty": "ReloadEmpty", "inspect": "Inspect",
                        "capacity": {"deck": 1, "cage": wd.CAGE_SLOTS},
                        "README": "Frisbee Launcher (two-handed crossbow that throws flying discs). One disc on the deck + a cage of "
                                  f"{wd.CAGE_SLOTS} under the gun. Fire = the elastic cords snap the sled forward and the disc flies "
                                  "(projectile), then the left hand re-cocks: pulls the sled back to the latch, takes the next disc "
                                  "from the cage (left side) and lays it on the deck. Reload = swap the cage."})
    w.js["scenes"][0]["nodes"] = [root]
    w.js["scenes"][0]["name"] = "Scene"
    idx = {"Trigger": n_trig, "Sled": n_sled, "LimbL": n_limbL, "LimbR": n_limbR, "CordL": n_cordL, "CordR": n_cordR,
           "DiscDeck": n_deck, "DiscHand": n_hand, "Cage": n_cage}

    anims = []
    for name, (ts, vals) in weapon_tracks().items():
        ts = np.asarray(ts, np.float32)
        a_in = w.add_accessor(ts.reshape(-1, 1), "SCALAR", minmax=True)
        Ls = [wd.node_locals(v) for v in vals]
        samplers, channels = [], []
        for nd in ANIM_NODES:
            T = [trs_of(L[nd]) for L in Ls]
            tt = np.array([x[0] for x in T], np.float32)
            qq = [np.asarray(x[1], float) for x in T]
            for i in range(1, len(qq)):
                if np.dot(qq[i - 1], qq[i]) < 0: qq[i] = -qq[i]
            ss = np.array([x[2] for x in T], np.float32)
            chs = [("translation", tt, "VEC3", "LINEAR"), ("rotation", np.array(qq, np.float32), "VEC4", "LINEAR")]
            if nd in ("CordL", "CordR"):
                chs.append(("scale", ss, "VEC3", "LINEAR"))
            elif nd in ("DiscDeck", "DiscHand"):
                chs.append(("scale", ss, "VEC3", "STEP"))             # visibility switches (scale 0 / 1), no shrinking
            elif nd == "Cage":
                chs.append(("scale", ss, "VEC3", "LINEAR"))           # hidden while off screen / handed to the world prop; the new cage grows out of the pouch
            for tpath, arr, typ, interp in chs:
                a_out = w.add_accessor(arr, typ)
                samplers.append({"input": a_in, "output": a_out, "interpolation": interp})
                channels.append({"sampler": len(samplers) - 1, "target": {"node": idx[nd], "path": tpath}})
        anims.append({"name": name, "samplers": samplers, "channels": channels})
    w.js["animations"] = anims
    w.write(path)
    return stats


if __name__ == "__main__":
    st = build()
    print("triangles:", st, "total", sum(st.values()))
