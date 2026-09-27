"""Preview frames of FP clips: python3 preview_fp.py hold|spec-name ..."""
import sys, numpy as np
from PIL import Image
import author_fp as A
import weapon_def as wd
from fp_common import render


def frame(spec, label=None, size=(640, 360), balls=True):
    pose, ws, xR, xL, err = A.solve_pose(spec)
    im, W, Wn = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls() if balls else None, size=size,
                       label=label or f"L {err[2]*1000:.1f}mm {err[3]:.1f}deg")
    return im, pose, W, Wn, err


if __name__ == "__main__":
    im, pose, W, Wn, err = frame(dict(place=A.HOLD, lh=A.fore_hand), size=(960, 540))
    im.save("pv_hold.png")
    from straight import screen_angles
    print("err", np.round(err, 4), "screen angles", np.round(screen_angles(W, "L"), 1))


def zoom(spec, path, label=None, box=(880, 520, 1920, 1080), balls=True):
    im, pose, W, Wn, err = frame(spec, label, size=(1920, 1080), balls=balls)
    im.crop(box).save(path)
    return pose, W, Wn, err
