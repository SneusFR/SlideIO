"""Write PopcornShotgun_Weapon.glb (scene + sockets + popcorn templates + weapon-internal clips)."""
import json, pickle
import numpy as np
from glb import GLBWriter
import weapon_def as wd
import weapon_parts as wp
from rig import qaxis, mat3_to_quat

OPAQUE, GLASS = 0, 1


def dedup(pos, nrm, col):
    key = np.round(np.concatenate([pos, nrm * 10, col * 10], axis=1), 5)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
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


def weapon_tracks():
    """Weapon-internal clips, sampled from the SAME curves the FP arms were authored against."""
    import author_fp as A
    clips = {}
    fps = 60

    def sample(fn, dur):
        n = int(round(dur * fps)) + 1
        ts = np.minimum(np.arange(n) / fps, dur)
        return ts, [fn(t) for t in ts]

    clips["Idle"] = (np.array([0.0, 2.0]), [(0, 0, 0), (0, 0, 0)])
    clips["Fire"] = sample(lambda t: (float(A.PUMP_FIRE(t)), 0.0, float(A.TRIG_FIRE(t))), 0.9)
    clips["Fire_Last"] = sample(lambda t: (0.0, 0.0, float(A.TRIG_FIRE(t))), 0.55)
    clips["Reload"] = sample(lambda t: (float(A.RELOAD_PUMP(t)), float(A.RELOAD_LID(t)), 0.0), A.RL["end"])
    clips["Inspect"] = (np.array([0.0, 3.6]), [(0, 0, 0), (0, 0, 0)])
    clips["Equip"] = (np.array([0.0, 0.55]), [(0, 0, 0), (0, 0, 0)])
    return clips


def build(path="PopcornShotgun_Weapon.glb"):
    w = GLBWriter()
    w.js["materials"] = [
        {"name": "PopcornShotgun_VertexColor", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.62}},
        {"name": "PopcornShotgun_Glass", "alphaMode": "BLEND", "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 0.26], "metallicFactor": 0.0, "roughnessFactor": 0.08}},
    ]
    P = wd.parts()
    stats = {}
    m_body, stats["Body"] = add_mesh(w, "Body", P["Body"], OPAQUE)
    m_trig, stats["Trigger"] = add_mesh(w, "Trigger", P["Trigger"], OPAQUE)
    m_pump, stats["Pump"] = add_mesh(w, "Pump", P["Pump"], OPAQUE)
    m_frame, stats["TankFrame"] = add_mesh(w, "TankFrame", P["TankFrame"], OPAQUE)
    m_glass, stats["TankGlass"] = add_mesh(w, "TankGlass", P["TankGlass"], GLASS)
    m_lid, stats["TankLid"] = add_mesh(w, "TankLid", P["TankLid"], OPAQUE)
    pop_mb = wd._popcorn_tmpl(); ker_mb = wd._kernel_tmpl()
    m_pop, stats["Popcorn"] = add_mesh(w, "Popcorn", pop_mb, OPAQUE)
    m_ker, stats["Kernel"] = add_mesh(w, "Kernel", ker_mb, OPAQUE)

    bake = np.load("popcorn_bake.npz")
    N = int(bake["N"]); per_shot = int(bake["per_shot"])
    full = bake["full"]; quats = bake["quats"]; scales = bake["scales"]
    half_idx = bake["half_idx"]; half_pos = bake["half_pos"]
    order = bake["order"]
    try:  # layouts re-settled with the runtime (TS) solver -> exactly at rest when loaded
        tsb = json.load(open("popcorn_bake_ts.json"))
        full = np.array(tsb["full"], float); order = np.array(tsb["order"])
        half_idx = np.array(tsb["halfIdx"]); half_pos = np.array(tsb["halfPos"], float)
    except FileNotFoundError:
        pass

    # EXT_mesh_gpu_instancing preview fill (FULL layout) — hidden by the controller at runtime.
    a_t = w.add_accessor(full.astype(np.float32), "VEC3")
    a_r = w.add_accessor(quats.astype(np.float32), "VEC4")
    a_s = w.add_accessor(np.repeat(scales[:, None], 3, axis=1).astype(np.float32), "VEC3")

    wd_off = wd.OFFHAND_LOCAL
    sock = {"purpose": "socket", "deform": False}
    # --- node tree
    n_body = node(w, "Body", mesh=m_body)
    n_trig = node(w, "Trigger", mesh=m_trig, translation=f3(wd.TRIGGER_PIVOT))
    off_q = mat3_to_quat(wd_off[:3, :3])
    n_off = node(w, "OffhandSocket", translation=f3(wd_off[:3, 3]), rotation=f4(off_q),
                 extras={"purpose": "left_hand_ik_target", "matches": "Weapon_L", "note": "Weapon_L frame while holding the pump (moves with the pump)."})
    import json as _j
    _tp = np.array(_j.load(open("tp_grip.json"))["offhand_local_tp"])
    n_off_tp = node(w, "OffhandSocketTP", translation=f3(_tp[:3, 3]), rotation=f4(mat3_to_quat(_tp[:3, :3] / np.linalg.norm(_tp[:3, :3], axis=0))),
                    extras={"purpose": "left_hand_ik_target_tp", "matches": "Weapon_L (TP character)",
                            "note": "TP pump grip: rear of the pump (the Potato's TP arms are short), moves with the pump."})
    n_pump = node(w, "Pump", [n_off, n_off_tp], mesh=m_pump, translation=f3(wd.PUMP_ORIGIN),
                  extras={"slide_axis": "+X", "travel": wd.PUMP_TRAVEL, "units": "weapon"})
    lid_edge = node(w, "LidEdgeSocket", translation=f3([wd.LID_LEN, 0.08, 0.0]), extras=sock)
    lid_top = node(w, "LidTopSocket", translation=f3([wd.LID_LEN * 0.62, wp.Y(92) - wp.Y(146), 0.0]), extras=sock)
    n_lid = node(w, "TankLid", [lid_edge, lid_top], mesh=m_lid, translation=f3(wd.LID_HINGE - wd.TANK_C),
                 extras={"hinge_axis": "+Z", "open_degrees": wd.LID_OPEN_DEG})
    n_frame = node(w, "TankFrame", mesh=m_frame)
    n_glass = node(w, "TankGlass", mesh=m_glass, extras={"renderOrder": 2, "note": "transparent, draw after popcorn"})
    n_fill = node(w, "Popcorn_Fill", mesh=m_pop,
                  extensions={"EXT_mesh_gpu_instancing": {"attributes": {"TRANSLATION": a_t, "ROTATION": a_r, "SCALE": a_s}}},
                  extras={"preview_only": True, "note": "Full tank preview (72 instances). The controller hides it and drives its own InstancedMesh."})
    n_ptpl = node(w, "Popcorn_Template", mesh=m_pop, scale=[0.001] * 3, extras={"runtime_template": True, "note": "geometry source for the popcorn InstancedMesh"})
    n_ktpl = node(w, "Kernel_Template", mesh=m_ker, scale=[0.001] * 3, extras={"runtime_template": True, "note": "geometry source for the kernel InstancedMesh"})
    n_feed = node(w, "PopcornFeed", translation=f3(wd.FEED - wd.TANK_C), extras=sock)
    tank_extras = {
        "purpose": "popcorn_tank",
        "space": "Tank node local (weapon units; world = node matrix incl. root 0.19 scale)",
        "halfExtents": f3(wd.TANK_HALF),
        "count": N, "perShot": per_shot, "shots": 2,
        "popcornRadius": float(bake["r_pop"]), "kernelRadius": float(bake["r_kernel"]),
        "gravityUnitsPerS2": float(bake["g"]),
        "fullLayout": [f3(p) + f4(q) + [float(round(s, 4))] for p, q, s in zip(full, quats, scales)],
        "consumeOrder": [int(i) for i in order],
        "halfLayout": {"indices": [int(i) for i in half_idx], "positions": [f3(p) for p in half_pos]},
    }
    n_tank = node(w, "Tank", [n_frame, n_glass, n_lid, n_fill, n_ptpl, n_ktpl, n_feed], translation=f3(wd.TANK_C), extras=tank_extras)
    n_muzzle = node(w, "Muzzle", translation=f3(wd.MUZZLE), extras={"purpose": "socket", "forward": "-X"})
    n_grip = node(w, "GripSocket", translation=f3(wd.GRIP), extras=sock)
    root = node(w, "PopcornShotgun", [n_body, n_trig, n_pump, n_tank, n_muzzle, n_grip], scale=[wd.ROOT_SCALE] * 3,
                extras={"forward": "-X", "units": "meters", "idle": "Idle", "shot": "Fire", "shotLast": "Fire_Last",
                        "reload": "Reload", "inspect": "Inspect",
                        "README": "Popcorn Shotgun. 2 shots (tank full -> half -> empty). Fire 0.9s (recoil + pump), Fire_Last 0.55s, Reload 2.2s (lid flicked open, kernels sprinkled, lid pulled shut, pops, pump rack). 6 mesh draw calls + 2 instanced (popcorn, kernels)."})
    w.js["scenes"][0]["nodes"] = [root]
    w.js["scenes"][0]["name"] = "Scene"
    w.js["extensionsUsed"] = ["EXT_mesh_gpu_instancing"]

    # --- animations (Pump.translation, Trigger.rotation, TankLid.rotation on every clip)
    anims = []
    for name, (ts, vals) in weapon_tracks().items():
        ts = np.asarray(ts, np.float32)
        vals = np.asarray(vals, float)
        a_in = w.add_accessor(ts.reshape(-1, 1), "SCALAR", minmax=True)
        pump_t = np.array([wd.PUMP_ORIGIN + np.array([p * wd.PUMP_TRAVEL, 0, 0]) for p in vals[:, 0]], np.float32)
        lid_q = np.array([qaxis([0, 0, 1], np.radians(a)) for a in vals[:, 1]], np.float32)
        trg_q = np.array([qaxis([0, 0, 1], np.radians(a)) for a in vals[:, 2]], np.float32)
        samplers, channels = [], []
        for tgt, tpath, arr, typ in [(n_pump, "translation", pump_t, "VEC3"), (n_lid, "rotation", lid_q, "VEC4"),
                                     (n_trig, "rotation", trg_q, "VEC4")]:
            a_out = w.add_accessor(arr, typ)
            samplers.append({"input": a_in, "output": a_out, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": tgt, "path": tpath}})
        anims.append({"name": name, "samplers": samplers, "channels": channels})
    w.js["animations"] = anims
    w.write(path)
    return stats


if __name__ == "__main__":
    import author_fp  # noqa: F401  (sets wd.OFFHAND_LOCAL)
    st = build()
    print("triangles:", st, "total", sum(st.values()))
