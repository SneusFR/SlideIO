"""Contact sheet of an FP clip spec: python3 sheet_fp.py clip_fn times..."""
import sys, numpy as np
from PIL import Image, ImageDraw
import author_fp as A
import weapon_def as wd
from fp_common import render


def sheet(fn, times, path, cols=4, size=(480, 270), crop=None):
    ims = []
    xR = xL = None
    for t in times:
        spec = fn(t)
        pose, ws, xR, xL, err = A.solve_pose(spec, xR, xL)
        hide = () if (not hasattr(A, "hopper_visible") or A.hopper_visible(t) or fn is not A.clip_reload) else ("Hopper", "HopperFrame", "HopperGlass")
        im, W, Wn = render(pose, A.M_FP, ws[0], ws[1], ws[2], balls=wd.preview_balls(), size=(960, 540),
                           label=f"t={t:.2f} L{err[2]*1000:.1f}mm {err[3]:.0f}d", hide=hide)
        if crop: im = im.crop(crop)
        ims.append(im.resize(size))
    rows = (len(ims) + cols - 1) // cols
    out = Image.new("RGB", (size[0] * cols, size[1] * rows))
    for k, im in enumerate(ims): out.paste(im, ((k % cols) * size[0], (k // cols) * size[1]))
    out.save(path)


if __name__ == "__main__":
    fn = getattr(A, sys.argv[1]); path = sys.argv[2]
    times = [float(x) for x in sys.argv[3:]]
    sheet(fn, times, path)
