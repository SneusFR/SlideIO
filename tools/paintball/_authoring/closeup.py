import numpy as np
from PIL import Image
import author_fp as A
import weapon_def as wd
from fp_common import arms, render
from raster import look_at


def closeups(spec, path, target="Offhand", dist=0.22, dirs=("left", "front", "below", "cam")):
    pose, ws, xR, xL, err = A.solve_pose(spec)
    W = arms.world(pose)
    G = W["Weapon_R"] @ A.M_FP @ A.S_ROOT
    Wn = wd.world_nodes(G, ws[0], ws[1], ws[2])
    c = Wn[target][:3, 3] if target in Wn else W[target][:3, 3]
    R = G[:3, :3] / np.linalg.norm(G[:3, :3], axis=0)
    D = {"left": R[:, 2], "right": -R[:, 2], "front": -R[:, 0], "below": -R[:, 1] + 0.3 * R[:, 2], "cam": -c / np.linalg.norm(c),
         "back": R[:, 0] + 0.2 * R[:, 2]}
    ims = []
    for d in dirs:
        v = D[d] / np.linalg.norm(D[d])
        up = R[:, 1] if d not in ("below",) else R[:, 0]
        cam = look_at(c + v * dist, c, up=up)
        im, _, _ = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls(), size=(420, 420), cam=cam, fov=45,
                          label=f"{d} L{err[2]*1000:.1f}mm {err[3]:.1f}d")
        ims.append(im)
    out = Image.new("RGB", (420 * len(ims), 420))
    for k, im in enumerate(ims): out.paste(im, (420 * k, 0))
    out.save(path)
    return pose, err


if __name__ == "__main__":
    closeups(dict(place=A.HOLD, lh=A.fore_hand), "cu_hold.png")
