"""Write WaterFamas_Weapon.glb (scene + sockets + tank data + weapon clips)."""
import json, pickle, os
import numpy as np
from glb import GLBWriter
import weapon_def as wd
from rig import qaxis, mat3_to_quat

OPAQUE, GLASS, WATER = 0, 1, 2


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
    return t, mat3_to_quat(R), s


def weapon_tracks():
    """Weapon-internal clips, sampled from the SAME curves the arms were authored against.
    value = (trigger deg, cap_turn, hinge 0..1, bottle 4x4 | None)."""
    import author_fp as A
    fp = pickle.load(open("fp_clips.pkl", "rb"))
    tp = pickle.load(open("tp_clips.pkl", "rb")) if os.path.exists("tp_clips.pkl") else {}
    rest = (0.0, 0.0, 0.0, None)
    clips = {}

    def sample(fn, dur, f=60):
        n = int(round(dur * f)) + 1
        ts = np.minimum(np.arange(n) / f, dur)
        return ts, [fn(t) for t in ts]

    clips["Idle"] = (np.array([0.0, 2.0]), [rest, rest])
    clips["Fire"] = sample(lambda t: (float(A.TRIG_BURST(t)), 0.0, 0.0, None), A.BURST_DUR, 120)
    for name, src, key in (("Reload", fp, "FP_Reload_WaterFamas"), ("Reload_TP", tp, "TP_Reload_WaterFamas")):
        c = src.get(key) or fp["FP_Reload_WaterFamas"]
        n = len(c["weapon"])
        ts = np.minimum(np.arange(n) / c["fps"], c["duration"])
        vals = [(w["trig"], w["cap_turn"], w["hinge"], w["bottle"]) for w in c["weapon"]]
        # visibility steps of the bottle: duplicate the key at the switch (scale snaps, no shrinking bottle)
        ts2, vals2 = [], []
        for i in range(n):
            if i > 0 and (vals[i][3] is None) != (vals[i - 1][3] is None):
                ts2.append(ts[i] - 1e-3); vals2.append(vals[i - 1] if vals[i][3] is None else (vals[i][0], vals[i][1], vals[i][2], None))
                if vals[i][3] is not None:
                    vals2[-1] = (vals[i][0], vals[i][1], vals[i][2], ("hidden_at", vals[i][3]))
            ts2.append(ts[i]); vals2.append(vals[i])
        clips[name] = (np.array(ts2), vals2)
    clips["Inspect"] = (np.array([0.0, 3.6]), [rest, rest])
    clips["Equip"] = (np.array([0.0, 0.55]), [rest, rest])
    return clips


def bottle_trs(b):
    """None -> hidden (scale 0 at the park pose); ('hidden_at', M) -> hidden at M; M -> visible."""
    if b is None:
        return wd.BOTTLE_PARK, np.array([0, 0, 0, 1.0]), 0.0
    if isinstance(b, tuple):
        t, q, s = trs_of(b[1]); return t, q, 0.0
    t, q, s = trs_of(b)
    return t, q, float(np.mean(s))


def build(path="WaterFamas_Weapon.glb"):
    import author_fp as A
    try:
        import author_tp as T
        cap_tp, bottle_tp = T.cap_grab_local_tp(T.CAP_PHI_TP), T.BOTTLE_GRAB_TP
    except Exception as e:                                          # TP not authored yet
        print("TP sockets unavailable:", e)
        cap_tp = bottle_tp = None
    w = GLBWriter()
    w.js["asset"]["generator"] = "Water FAMAS — modelled in Blender (fm_model.py), assembled by export_weapon.py"
    w.js["materials"] = [
        {"name": "WaterFamas_VertexColor", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.55}},
        {"name": "WaterFamas_TankGlass", "alphaMode": "BLEND", "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 0.28], "metallicFactor": 0.0, "roughnessFactor": 0.06}},
        {"name": "WaterFamas_Water", "alphaMode": "BLEND", "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 0.72], "metallicFactor": 0.0, "roughnessFactor": 0.1}},
    ]
    P = wd.parts()
    stats = {}
    m = {}
    for name, mat in (("Body", OPAQUE), ("Trigger", OPAQUE), ("TankFrame", OPAQUE), ("TankGlass", GLASS), ("Water", WATER),
                      ("CapHinge", OPAQUE), ("Cap", OPAQUE), ("Bottle", OPAQUE)):
        m[name], stats[name] = add_mesh(w, name, P[name], mat)

    def socket(name, F, extras):
        R = F[:3, :3] / np.linalg.norm(F[:3, :3], axis=0)
        return node(w, name, translation=f3(F[:3, 3]), rotation=f4(mat3_to_quat(R)), extras=extras)

    n_body = node(w, "Body", mesh=m["Body"])
    n_trig = node(w, "Trigger", mesh=m["Trigger"], translation=f3(wd.TRIGGER_PIVOT), extras={"pivot_axis": "+Z", "pull_degrees": A.TRIG_PULL})
    cap_kids = [socket("CapGrabSocket", A.cap_grab_local(A.CAP_PHI), {"purpose": "left_hand_ik_target", "matches": "Weapon_L",
                                                                    "note": "FP: claw on the cap (reload), centre of the unscrew strokes"})]
    if cap_tp is not None:
        cap_kids.append(socket("CapGrabSocketTP", cap_tp, {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)"}))
    n_cap = node(w, "Cap", cap_kids, mesh=m["Cap"], translation=f3(wd.CAP_REST),
                 extras={"unscrew_axis": "+X", "thread_per_turn": wd.THREAD, "note": "unscrews 0.5 turn (+X rotation) in the reload clips"})
    n_hinge = node(w, "CapHinge", [n_cap], mesh=m["CapHinge"], translation=f3(wd.HINGE),
                   extras={"hinge_axis": "+Y", "open_degrees": -wd.HINGE_OPEN_DEG, "note": "retainer that swings the unscrewed cap aside"})
    n_frame = node(w, "TankFrame", mesh=m["TankFrame"])
    n_glass = node(w, "TankGlass", mesh=m["TankGlass"], extras={"renderOrder": 3, "note": "transparent, draw after the water"})
    n_water = node(w, "Water", mesh=m["Water"], extras={"runtime_liquid": True, "note": "the controller replaces its material by the "
                                                         "free-surface water shader (level = ammo, sloshing with the weapon motion)"})
    n_fill = node(w, "FillPoint", translation=f3([wd.TANK_X[1] + 0.06, 0.0, 0.0]), extras={"purpose": "socket", "note": "filler hole (tank axis = +X)"})
    tank_extras = {"purpose": "water_tank", "space": "Tank node local (weapon units; world = node matrix incl. root 0.19 scale)",
                   "capacity": 9, "jetsPerShot": 3, "axis": "+X", "radius": wd.WATER_R, "xMin": wd.WATER_X[0], "xMax": wd.WATER_X[1],
                   "glassRadius": wd.TANK_R, "emptyLevel": 0.06}
    n_tank = node(w, "Tank", [n_frame, n_water, n_glass, n_hinge, n_fill], translation=f3(wd.TANK_C), extras=tank_extras)
    bot_kids = [socket("BottleGrabSocket", wd.BOTTLE_GRAB_LOCAL, {"purpose": "left_hand_ik_target", "matches": "Weapon_L", "note": "FP: fist on the bottle band"})]
    if bottle_tp is not None:
        bot_kids.append(socket("BottleGrabSocketTP", bottle_tp, {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)"}))
    bot_kids.append(node(w, "BottleNozzle", translation=f3(wd.BOTTLE_NOZZLE), extras={"purpose": "socket", "note": "pour stream start"}))
    n_bottle = node(w, "Bottle", bot_kids, mesh=m["Bottle"], translation=f3(wd.BOTTLE_PARK), scale=[0.0, 0.0, 0.0],
                    extras={"reload_prop": True, "note": "water bottle, shown (scale 1) only during the reload clips"})
    n_muzzle = node(w, "Muzzle", translation=f3(wd.MUZZLE), extras={"purpose": "socket", "forward": "-X"})
    n_grip = node(w, "GripSocket", translation=f3(wd.GRIP), extras={"purpose": "socket", "deform": False})
    root = node(w, "WaterFamas", [n_body, n_trig, n_tank, n_bottle, n_muzzle, n_grip], scale=[wd.ROOT_SCALE] * 3,
                extras={"forward": "-X", "units": "meters", "idle": "Idle", "fire": "Fire", "reload": "Reload", "reloadTP": "Reload_TP",
                        "inspect": "Inspect",
                        "README": "Water FAMAS (one-handed). 9 jets = 3 shots; a shot is a FAMAS 3-jet burst (0 / 0.075 / 0.15 s, clip 0.42 s). "
                                  "Reload 3.3 s = unscrew the rear cap, swing it open, pour a bottle, close, screw. "
                                  "The Water mesh is driven by the runtime liquid shader."})
    w.js["scenes"][0]["nodes"] = [root]
    w.js["scenes"][0]["name"] = "Scene"

    anims = []
    for name, (ts, vals) in weapon_tracks().items():
        ts = np.asarray(ts, np.float32)
        a_in = w.add_accessor(ts.reshape(-1, 1), "SCALAR", minmax=True)
        trg_q = np.array([qaxis([0, 0, 1], np.radians(v[0])) for v in vals], np.float32)
        L = [wd.node_locals(0.0, v[1], v[2]) for v in vals]
        cap_t = np.array([l["Cap"][:3, 3] for l in L], np.float32)
        cap_q = [mat3_to_quat(l["Cap"][:3, :3]) for l in L]
        hin_q = [mat3_to_quat(l["CapHinge"][:3, :3]) for l in L]
        bt = [bottle_trs(v[3]) for v in vals]
        b_t = np.array([b[0] for b in bt], np.float32)
        b_q = [np.asarray(b[1], float) for b in bt]
        b_s = np.array([[b[2]] * 3 for b in bt], np.float32)
        for arr in (cap_q, hin_q, b_q):
            for i in range(1, len(arr)):
                if np.dot(arr[i - 1], arr[i]) < 0: arr[i] = -arr[i]
        samplers, channels = [], []
        for tgt, tpath, arr, typ in [(n_trig, "rotation", trg_q, "VEC4"), (n_cap, "translation", cap_t, "VEC3"),
                                     (n_cap, "rotation", np.array(cap_q, np.float32), "VEC4"),
                                     (n_hinge, "rotation", np.array(hin_q, np.float32), "VEC4"),
                                     (n_bottle, "translation", b_t, "VEC3"), (n_bottle, "rotation", np.array(b_q, np.float32), "VEC4"),
                                     (n_bottle, "scale", b_s, "VEC3")]:
            a_out = w.add_accessor(arr, typ)
            samplers.append({"input": a_in, "output": a_out, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": tgt, "path": tpath}})
        anims.append({"name": name, "samplers": samplers, "channels": channels})
    w.js["animations"] = anims
    w.write(path)
    return stats


if __name__ == "__main__":
    st = build()
    print("triangles:", st, "total", sum(st.values()))
