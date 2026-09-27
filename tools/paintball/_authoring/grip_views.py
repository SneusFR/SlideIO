"""Views of the FP left hand on the foregrip: game camera (zoomed) + orbit views around the grip.
python3 grip_views.py out.png [fore_grip.json]"""
import sys, json, numpy as np
from PIL import Image
import author_fp as A
import weapon_def as wd
from fp_common import render
from raster import look_at


def views(path, spec=None, size=360):
    spec = spec or dict(place=A.HOLD, lh=A.fore_hand)
    pose, ws, xR, xL, err = A.solve_pose(spec)
    from fp_common import arms
    W = arms.world(pose)
    G = W["Weapon_R"] @ A.M_FP @ A.S_ROOT
    R = G[:3, :3] / np.linalg.norm(G[:3, :3], axis=0)
    c = (G @ np.r_[wd.FOREGRIP_X, 0.5 * (wd.FOREGRIP_Y0 + wd.FOREGRIP_Y1), 0.0, 1.0])[:3]
    ims = []
    # 1: game camera, full frame; 2: game camera aimed at the grip (zoom)
    im, _, _ = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls(), size=(size * 16 // 9, size), label="game cam")
    ims.append(im)
    cam = look_at(np.zeros(3), c, up=(0, 1, 0))
    im, _, _ = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls(), size=(size, size), cam=cam, fov=22,
                      label=f"cam zoom L{err[2]*1000:.1f}mm")
    ims.append(im)
    for name, d, up in (("left", R[:, 2] + 0.3 * R[:, 0], R[:, 1]), ("back-left", R[:, 0] + 0.8 * R[:, 2] + 0.3 * R[:, 1], R[:, 1]),
                        ("below-left", -R[:, 1] + 0.7 * R[:, 2] + 0.3 * R[:, 0], R[:, 0]), ("front-right", -R[:, 0] - 0.6 * R[:, 2], R[:, 1]),
                        ("right", -R[:, 2], R[:, 1])):
        v = d / np.linalg.norm(d)
        cam = look_at(c + v * 0.32, c, up=up)
        im, _, _ = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls(), size=(size, size), cam=cam, fov=40, label=name)
        ims.append(im)
    Wt = sum(i.size[0] for i in ims[:4]); out = Image.new("RGB", (max(Wt, sum(i.size[0] for i in ims[4:])), size * 2), (40, 40, 40))
    x = 0
    for i in ims[:4]: out.paste(i, (x, 0)); x += i.size[0]
    x = 0
    for i in ims[4:]: out.paste(i, (x, size)); x += i.size[0]
    out.save(path)
    return err


if __name__ == "__main__":
    print(views(sys.argv[1] if len(sys.argv) > 1 else "grip_views.png"))
