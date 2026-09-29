"""TP preview renders: python3 preview_tp.py pkl clip out.png t [t ...]  (3 views per time)"""
import sys, pickle, numpy as np
from PIL import Image
from tp_rig import ch
from scene import drawables
from raster import Renderer, look_at
import weapon_def as wd
from rig import trs

S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)
VIEWS = ([1.3, 0.75, 1.5], [-1.4, 0.7, 1.2], [0.25, 0.9, 1.8])


def render_tp(pose, M_TP, st, eye, target=(0.0, 0.42, 0.1), size=(420, 420), fov=32, label=None):
    p = ch.rest_pose(); p.update(pose)
    W = ch.world(p)
    G = W["Weapon_R"] @ M_TP @ S_ROOT
    Wn = wd.world_nodes(G, st or {})
    r = Renderer(*size, fov=fov)
    r.set_camera(look_at(np.array(eye, float), np.array(target, float)))
    for d in drawables(ch, W): r.draw(*d)
    wd.draw_weapon(r, Wn, st or {})
    return r.image(label=label)


if __name__ == "__main__":
    pkl, clip, out = sys.argv[1], sys.argv[2], sys.argv[3]
    times = [float(x) for x in sys.argv[4:]]
    c = pickle.load(open(pkl, "rb"))
    M = c["_meta"]["mount"]
    cl = c[clip]
    ims = []
    for t in times:
        i = min(len(cl["frames"]) - 1, int(round(t * cl["fps"])))
        e = cl["errors"][i]
        for eye in VIEWS:
            ims.append(render_tp(cl["frames"][i], M, cl["weapon"][i], eye, label=f"t={t:.2f} L{e[2]*1000:.1f}mm"))
    S = Image.new("RGB", (420 * 3, 420 * len(times)))
    for k, im in enumerate(ims): S.paste(im, ((k % 3) * 420, (k // 3) * 420))
    S.save(out)
