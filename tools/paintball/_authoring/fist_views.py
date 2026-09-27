"""Hand mesh + foregrip box only, in the foregrip METRIC frame (fore_fit): quick views to design the grip.
views(H, curls, path): below (along the grip axis), game camera direction, back, left, front."""
import numpy as np
from PIL import Image
import fore_fit as F
from raster import Renderer, look_at

CAM_M = np.array([0.636, 0.261, 0.354])          # FP game camera in the grip metric frame (HOLD)
HAND_COL = np.array([0.72, 0.38, 0.16]); GRIP_COL = np.array([0.30, 0.33, 0.40]); MOUNT_COL = np.array([0.15, 0.55, 0.60])

_md = F.md
_sel = np.zeros(len(_md["pos"]), bool); _sel[F.VSEL] = True
_tris = _md["idx"][np.all(_sel[_md["idx"]], axis=1)]
_remap = -np.ones(len(_md["pos"]), np.int64); _remap[F.VSEL] = np.arange(len(F.VSEL))
HAND_TRIS = _remap[_tris]


def box(c, h):
    c = np.asarray(c, float); h = np.asarray(h, float)
    v = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * h + c
    f = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return v, np.array(f)


def draw_scene(r, H, curls, finger_cols=True):
    v = F.hand_vertices(H, curls)
    cols = np.tile(HAND_COL, (len(v), 1))
    if finger_cols:
        pal = {"Index_L_1": (0.95, 0.55, 0.2), "Middle_L_1": (0.85, 0.3, 0.3), "Ring_L_1": (0.6, 0.25, 0.5), "Thumb_L_1": (0.95, 0.8, 0.3)}
        for n, c in pal.items(): cols[F.DOMSEL == n] = c
    r.draw(v, HAND_TRIS, cols)
    gv, gf = box([0, -F.LEN / 2, 0], [F.HX, F.LEN / 2, F.HZ]); r.draw(gv, gf, GRIP_COL)
    (a, b, hz) = F.MOUNT
    mv, mf = box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0], [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2, hz]); r.draw(mv, mf, MOUNT_COL)
    return v


def views(H, curls, path, size=300, label=""):
    c = np.array([0.0, -F.LEN / 2, 0.0])
    dirs = {"camera": (CAM_M - c, (0, 1, 0)), "below": (np.array([0.05, -1.0, 0.1]), (1, 0, 0)),
            "back": (np.array([1.0, 0.1, 0.05]), (0, 1, 0)), "left": (np.array([0.05, 0.1, 1.0]), (0, 1, 0)),
            "front": (np.array([-1.0, 0.1, -0.2]), (0, 1, 0))}
    ims = []
    for k, (d, up) in dirs.items():
        d = d / np.linalg.norm(d)
        r = Renderer(size, size, fov=38)
        r.set_camera(look_at(c + d * 0.36, c, up=up))
        draw_scene(r, H, curls)
        im = r.image(label=f"{k} {label}" if k == "camera" else k)
        ims.append(im)
    out = Image.new("RGB", (size * len(ims), size))
    for i, im in enumerate(ims): out.paste(im, (i * size, 0))
    out.save(path)


if __name__ == "__main__":
    import json, sys
    g = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "fore_grip.json"))
    views(np.array(g["hand_metric"]), g["curls"], sys.argv[2] if len(sys.argv) > 2 else "fist_now.png", label="v1")
