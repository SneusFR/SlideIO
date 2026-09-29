"""Export baked clips (fp_clips.pkl / tp_clips.pkl) as glTF-local TRS per frame for fm_anim.load_clips."""
import sys, json, pickle, numpy as np
import weapon_def as wd
from rig import decompose


def trqs(M):
    t, r, s = decompose(M)
    return [list(map(float, t)), list(map(float, r)), float(np.mean(s))]


def export(src, outp, names=None):
    clips = pickle.load(open(src, "rb"))
    out = {}
    for nm in (names or [k for k in clips if not k.startswith("_")]):
        c = clips[nm]; frames = []
        for f, w in zip(c["frames"], c["weapon"]):
            b = w.get("bottle")
            L = wd.node_locals(w["trig"], w["cap_turn"], w["hinge"], None if b is None else np.asarray(b))
            B = trqs(L["Bottle"]) if b is not None else [list(map(float, wd.BOTTLE_PARK)), [0.0, 0.0, 0.0, 1.0], 0.0]
            frames.append({"bones": {k: [list(map(float, f[k][0])), list(map(float, f[k][1]))] for k in f},
                           "objects": {"Trigger": trqs(L["Trigger"]), "Cap": trqs(L["Cap"]), "CapHinge": trqs(L["CapHinge"]), "Bottle": B},
                           "level": float(w.get("level", 1.0))})
        out[nm] = {"fps": c["fps"], "frames": frames}
    json.dump(out, open(outp, "w"))
    print("wrote", outp, {k: len(v["frames"]) for k, v in out.items()})


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2], sys.argv[3:] or None)
