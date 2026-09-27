"""Export baked clips (fp_clips.pkl / tp_clips.pkl) as glTF-local TRS per frame for pb_anim.load_clips."""
import sys, json, pickle, numpy as np
import weapon_def as wd
from rig import decompose


def trqs(M):
    t, r, s = decompose(M)
    return [list(map(float, t)), list(map(float, r)), float(s[0])]


def export(src, outp, names=None):
    clips = pickle.load(open(src, "rb"))
    out = {}
    for nm in (names or [k for k in clips if not k.startswith("_")]):
        c = clips[nm]; frames = []
        for f, w in zip(c["frames"], c["weapon"]):
            trig, charge, hop = w[0], w[1], w[2]
            vis = w[3] if len(w) > 3 else True
            L = wd.node_locals(trig, charge, None if hop is None else np.asarray(hop))
            H = trqs(L["Hopper"]); H[2] = 1.0 if vis else 0.0
            frames.append({"bones": {b: [list(map(float, f[b][0])), list(map(float, f[b][1]))] for b in f},
                           "objects": {"Trigger": trqs(L["Trigger"]), "ChargingHandle": trqs(L["ChargingHandle"]), "Hopper": H}})
        out[nm] = {"fps": c["fps"], "frames": frames}
    json.dump(out, open(outp, "w"))
    print("wrote", outp, {k: len(v["frames"]) for k, v in out.items()})


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2], sys.argv[3:] or None)
