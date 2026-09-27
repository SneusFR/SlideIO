"""Write animation-only pose libraries (FP / TP) on the exact node hierarchy of the rig GLB."""
import copy, pickle, sys
import numpy as np
from glb import GLBWriter, read_glb


def continuous_quats(qs):
    qs = np.array(qs, float)
    for i in range(1, len(qs)):
        if np.dot(qs[i - 1], qs[i]) < 0:
            qs[i] = -qs[i]
    return qs


def write_pose_library(rig_path, clips, channels, out_path, generator, scene_name=None):
    js, _ = read_glb(rig_path)
    w = GLBWriter()
    w.js["asset"] = {"version": "2.0", "generator": generator}
    nodes = []
    for n in js["nodes"]:
        m = {k: copy.deepcopy(v) for k, v in n.items() if k not in ("mesh", "skin")}
        nodes.append(m)
    w.js["nodes"] = nodes
    w.js["scenes"] = copy.deepcopy(js["scenes"])
    w.js["scene"] = js.get("scene", 0)
    idx = {n.get("name"): i for i, n in enumerate(nodes)}
    anims = []
    for name, clip in clips.items():
        fps = clip["fps"]
        frames = clip["frames"]
        n = len(frames)
        ts = np.minimum(np.arange(n) / fps, clip["duration"]).astype(np.float32)
        a_in = w.add_accessor(ts.reshape(-1, 1), "SCALAR", minmax=True)
        samplers, chans = [], []
        for bone, path in clip.get("channels", channels):
            if path == "translation":
                arr = np.array([f[bone][0] for f in frames], np.float32)
                typ = "VEC3"
            else:
                arr = continuous_quats([f[bone][1] for f in frames]).astype(np.float32)
                arr /= np.linalg.norm(arr, axis=1, keepdims=True)
                typ = "VEC4"
            a_out = w.add_accessor(arr, typ)
            samplers.append({"input": a_in, "output": a_out, "interpolation": "LINEAR"})
            chans.append({"sampler": len(samplers) - 1, "target": {"node": idx[bone], "path": path}})
        anims.append({"name": name, "samplers": samplers, "channels": chans})
    w.js["animations"] = anims
    w.write(out_path)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "fp"
    if which == "fp":
        clips = pickle.load(open("fp_clips.pkl", "rb"))
        meta = clips.pop("_meta")
        write_pose_library("Potato_FP_CommonArms.glb", clips, meta["channels"], "PaintballRifle_FP_Poses.glb",
                           "Paintball Rifle FP pose library - IK-authored on Potato_FP_CommonArms, animation only, no mesh")
    else:
        clips = pickle.load(open("tp_clips.pkl", "rb"))
        meta = clips.pop("_meta")
        write_pose_library("Potato_TP_Character.glb", clips, meta["channels"], "PaintballRifle_TP_Poses.glb",
                           "Paintball Rifle TP pose library - animation only, no duplicated mesh")
