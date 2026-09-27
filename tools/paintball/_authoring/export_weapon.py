"""Write PaintballRifle_Weapon.glb (scene + sockets + ball template + hopper physics data + weapon clips)."""
import json, pickle, sys
import numpy as np
from glb import GLBWriter
import weapon_def as wd
from rig import qaxis, mat3_to_quat

OPAQUE, GLASS = 0, 1


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
    """4x4 (rotation possibly scaled) -> t, q, s."""
    t = M[:3, 3]; s = np.linalg.norm(M[:3, :3], axis=0)
    R = M[:3, :3] / np.where(s > 1e-9, s, 1.0)
    return t, mat3_to_quat(R), s


def weapon_tracks():
    """Weapon-internal clips, sampled from the SAME curves the arms were authored against."""
    import author_fp as A
    fp = pickle.load(open("fp_clips.pkl", "rb"))
    tp = pickle.load(open("tp_clips.pkl", "rb"))
    seated = (wd.HOPPER_C, np.array([0, 0, 0, 1.0]), 1.0)
    clips = {}
    fps = 60

    def sample(fn, dur, f=fps):
        n = int(round(dur * f)) + 1
        ts = np.minimum(np.arange(n) / f, dur)
        return ts, [fn(t) for t in ts]

    def hop(M, vis=True):
        if M is None:
            return (wd.HOPPER_C, np.array([0, 0, 0, 1.0]), 1.0 if vis else 0.0)
        t, q, s = trs_of(M)
        return (t, q, 1.0 if vis else 0.0)

    clips["Idle"] = (np.array([0.0, 2.0]), [(0, 0, seated), (0, 0, seated)])
    clips["Fire"] = sample(lambda t: (A.TRIG_HELD, float(A.CH_KICK(t % A.FIRE_PERIOD)), seated), A.FIRE_PERIOD, 120)
    clips["Fire_End"] = sample(lambda t: (float(A.TRIG_END(t)), 0.0, seated), 0.30)
    for name, src, key in (("Reload", fp, "FP_Reload_PaintballRifle"), ("Reload_TP", tp, "TP_Reload_PaintballRifle")):
        c = src[key]
        n = len(c["weapon"])
        ts = np.minimum(np.arange(n) / c["fps"], c["duration"])
        vals = [(w[0], w[1], hop(w[2], w[3])) for w in c["weapon"]]
        # visibility steps: duplicate the key at the switch so the scale snaps (no shrinking hopper)
        ts2, vals2 = [], []
        for i in range(n):
            if i > 0 and vals[i][2][2] != vals[i - 1][2][2]:
                ts2.append(ts[i] - 1e-3); vals2.append((vals[i][0], vals[i][1], (vals[i][2][0], vals[i][2][1], vals[i - 1][2][2])))
            ts2.append(ts[i]); vals2.append(vals[i])
        clips[name] = (np.array(ts2), vals2)
    clips["Inspect"] = (np.array([0.0, 3.6]), [(0, 0, seated), (0, 0, seated)])
    clips["Equip"] = (np.array([0.0, 0.55]), [(0, 0, seated), (0, 0, seated)])
    return clips


def build(path="PaintballRifle_Weapon.glb"):
    import author_fp as A          # sets the FP sockets on wd
    import author_tp as T
    T.load_key()
    w = GLBWriter()
    w.js["asset"]["generator"] = "Paintball Rifle — modelled in Blender (pb_model.py), assembled by export_weapon.py"
    w.js["materials"] = [
        {"name": "PaintballRifle_VertexColor", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.58}},
        {"name": "PaintballRifle_Glass", "alphaMode": "BLEND", "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 0.24], "metallicFactor": 0.0, "roughnessFactor": 0.08}},
        {"name": "PaintballRifle_Ball", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.32}},
    ]
    P = wd.parts()
    stats = {}
    m_body, stats["Body"] = add_mesh(w, "Body", P["Body"], OPAQUE)
    m_trig, stats["Trigger"] = add_mesh(w, "Trigger", P["Trigger"], OPAQUE)
    m_ch, stats["ChargingHandle"] = add_mesh(w, "ChargingHandle", P["ChargingHandle"], OPAQUE)
    m_frame, stats["HopperFrame"] = add_mesh(w, "HopperFrame", P["HopperFrame"], OPAQUE)
    m_glass, stats["HopperGlass"] = add_mesh(w, "HopperGlass", P["HopperGlass"], GLASS)
    m_ball, stats["Ball"] = add_mesh(w, "Ball", P["Ball_Template"], 2)

    bake = json.load(open("hopper_bake.json"))
    full = np.array(bake["full"], float)
    cfg = bake["cfg"]
    palette = [list(wd.BALL_RGB[k]) for k in range(3)]
    a_t = w.add_accessor(full.astype(np.float32), "VEC3")
    a_s = w.add_accessor(np.full((len(full), 3), wd.BALL_R, np.float32), "VEC3")

    sock = {"purpose": "socket", "deform": False}

    def socket(name, F, extras):
        R = F[:3, :3] / np.linalg.norm(F[:3, :3], axis=0)
        return node(w, name, translation=f3(F[:3, 3]), rotation=f4(mat3_to_quat(R)), extras=extras)

    n_body = node(w, "Body", mesh=m_body)
    n_trig = node(w, "Trigger", mesh=m_trig, translation=f3(wd.TRIGGER_PIVOT), extras={"pivot_axis": "+Z", "pull_degrees": A.TRIG_HELD})
    n_chs = socket("ChargeSocket", wd.CHARGE_LOCAL, {"purpose": "left_hand_ik_target", "matches": "Weapon_L", "note": "FP: fingers on the charging-handle knob"})
    n_chs_tp = socket("ChargeSocketTP", T.CHARGE_TP, {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)"})
    n_ch = node(w, "ChargingHandle", [n_chs, n_chs_tp], mesh=m_ch, translation=f3(wd.CH_REST),
                extras={"slide_axis": "+X", "travel": wd.CH_TRAVEL, "units": "weapon"})
    n_grab = socket("HopperGrabSocket", wd.HOPPER_GRAB_LOCAL, {"purpose": "left_hand_ik_target", "matches": "Weapon_L", "note": "FP: hand on the hopper (reload)"})
    n_grab_tp = socket("HopperGrabSocketTP", T.GRAB_TP, {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)"})
    n_frame = node(w, "HopperFrame", mesh=m_frame)
    n_glass = node(w, "HopperGlass", mesh=m_glass, extras={"renderOrder": 2, "note": "transparent, draw after the balls"})
    n_fill = node(w, "Ball_Fill", mesh=m_ball,
                  extensions={"EXT_mesh_gpu_instancing": {"attributes": {"TRANSLATION": a_t, "SCALE": a_s}}},
                  extras={"preview_only": True, "note": "Full hopper preview (32 instances). The controller hides it and drives its own coloured InstancedMesh."})
    n_btpl = node(w, "Ball_Template", mesh=m_ball, scale=[0.001] * 3, extras={"runtime_template": True, "note": "unit-radius ball, geometry source for the ball InstancedMesh / projectiles"})
    n_feed = node(w, "BallFeed", translation=f3([cfg["feedX"], -cfg["innerRadius"], 0.0]), extras=sock)
    hopper_extras = {
        "purpose": "paintball_hopper",
        "space": "Hopper node local (weapon units; world = node matrix incl. root 0.19 scale)",
        "capacity": 32, "ballRadius": wd.BALL_R, "innerRadius": cfg["innerRadius"], "xMin": cfg["xMin"], "xMax": cfg["xMax"],
        "feedX": cfg["feedX"], "vSlope": cfg["vSlope"], "palette": [f3(c) for c in palette], "colors": bake["colors"],
        "layouts": [[None if p is None else f3(p) for p in L] for L in bake["layouts"]],
    }
    n_hopper = node(w, "Hopper", [n_frame, n_glass, n_fill, n_btpl, n_feed, n_grab, n_grab_tp], translation=f3(wd.HOPPER_C), extras=hopper_extras)
    n_off = socket("OffhandSocket", wd.OFFHAND_LOCAL, {"purpose": "left_hand_ik_target", "matches": "Weapon_L",
                                                       "note": "FP: left fist on the vertical foregrip (fitted on the real hand mesh)"})
    n_off_tp = socket("OffhandSocketTP", T.tp_offhand(T.TP_GRIP["yaw"], T.TP_GRIP["slide"]),
                      {"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)", "note": "TP: same fist, turned toward the back (short TP arm)"})
    n_muzzle = node(w, "Muzzle", translation=f3(wd.MUZZLE), extras={"purpose": "socket", "forward": "-X"})
    n_grip = node(w, "GripSocket", translation=f3(wd.GRIP), extras=sock)
    root = node(w, "PaintballRifle", [n_body, n_trig, n_ch, n_hopper, n_off, n_off_tp, n_muzzle, n_grip], scale=[wd.ROOT_SCALE] * 3,
                extras={"forward": "-X", "units": "meters", "idle": "Idle", "fire": "Fire", "fireEnd": "Fire_End",
                        "reload": "Reload", "reloadTP": "Reload_TP", "inspect": "Inspect",
                        "README": "Paintball Rifle. 32 balls, automatic 600 rpm: Fire is a 0.1 s LOOP (trigger held, charging handle "
                                  "cycling), Fire_End 0.3 s. Reload 2.45 s = hopper swap (Reload = FP hand path, Reload_TP = TP hand path). "
                                  "5 mesh draw calls + 1 instanced (balls)."})
    w.js["scenes"][0]["nodes"] = [root]
    w.js["scenes"][0]["name"] = "Scene"
    w.js["extensionsUsed"] = ["EXT_mesh_gpu_instancing"]

    anims = []
    for name, (ts, vals) in weapon_tracks().items():
        ts = np.asarray(ts, np.float32)
        a_in = w.add_accessor(ts.reshape(-1, 1), "SCALAR", minmax=True)
        trg_q = np.array([qaxis([0, 0, 1], np.radians(v[0])) for v in vals], np.float32)
        ch_t = np.array([wd.CH_REST + np.array([v[1] * wd.CH_TRAVEL, 0, 0]) for v in vals], np.float32)
        hq = [np.asarray(v[2][1], float) for v in vals]
        for i in range(1, len(hq)):
            if np.dot(hq[i - 1], hq[i]) < 0: hq[i] = -hq[i]
        h_t = np.array([v[2][0] for v in vals], np.float32)
        h_q = np.array(hq, np.float32)
        h_s = np.array([[v[2][2]] * 3 for v in vals], np.float32)
        samplers, channels = [], []
        for tgt, tpath, arr, typ in [(n_trig, "rotation", trg_q, "VEC4"), (n_ch, "translation", ch_t, "VEC3"),
                                     (n_hopper, "translation", h_t, "VEC3"), (n_hopper, "rotation", h_q, "VEC4"),
                                     (n_hopper, "scale", h_s, "VEC3")]:
            a_out = w.add_accessor(arr, typ)
            samplers.append({"input": a_in, "output": a_out, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": tgt, "path": tpath}})
        anims.append({"name": name, "samplers": samplers, "channels": channels})
    w.js["animations"] = anims
    w.write(path)
    return stats


if __name__ == "__main__":
    st = build()
    print("triangles:", st, "total (excl. ball template)", sum(v for k, v in st.items() if k != "Ball"))
