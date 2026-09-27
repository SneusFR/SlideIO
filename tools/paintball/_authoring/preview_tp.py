"""TP preview renders: python3 preview_tp.py pkl clip t [t ...]"""
import sys, pickle, numpy as np
from PIL import Image
from tp_rig import ch
from scene import drawables
from raster import Renderer, look_at
import weapon_def as wd
from rig import trs

S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)


def render_tp(pose, M_TP, ws, eye, target, size=(420, 420), fov=32, label=None):
    p = ch.rest_pose(); p.update(pose)
    W = ch.world(p)
    G = W["Weapon_R"] @ M_TP @ S_ROOT
    Wn = wd.world_nodes(G, ws[0], ws[1], ws[2])
    r = Renderer(*size, fov=fov)
    r.set_camera(look_at(np.array(eye), np.array(target)))
    for d in drawables(ch, W): r.draw(*d)
    hide = () if (len(ws) < 4 or ws[3]) else ("Hopper", "HopperFrame", "HopperGlass")
    wd.draw_weapon(r, Wn, wd.preview_balls(), hide=hide)
    return r.image(label=label)


if __name__ == "__main__":
    pkl, clip = sys.argv[1], sys.argv[2]
    times = [float(x) for x in sys.argv[3:]]
    c = pickle.load(open(pkl, "rb"))
    M = c["_meta"]["mount"]
    cl = c[clip]
    ims = []
    for t in times:
        i = min(len(cl["frames"]) - 1, int(round(t * cl["fps"])))
        for eye in ([1.3, 0.75, 1.5], [-1.4, 0.7, 1.2], [0.25, 0.9, 1.8]):
            ims.append(render_tp(cl["frames"][i], M, cl["weapon"][i], eye, [0.0, 0.42, 0.1], label=f"{clip} t={t:.2f}"))
    out = Image.new("RGB", (420 * 3, 420 * len(times)))
    for k, im in enumerate(ims): out.paste(im, ((k % 3) * 420, (k // 3) * 420))
    out.save(f"tp_{clip}.png")
